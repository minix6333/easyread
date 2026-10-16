"""Codex app-server：一個常駐的 codex app-server 行程（stdio 上的 JSON-RPC），「問 AI」用它逐字串流。

為什麼：
- codex exec 要等整段答完才一次吐出，實測 GPT-6.1-Sol 問一句要 8–30 秒什麼都看不到；
  app-server 的 item/agentMessage/delta 一個字一個字來（首字約 4 秒，追問約 1.7 秒）。
- 同一個對話接著問用同一個 thread：Codex 自己記著前文（OpenAI 端有快取），追問只送新問題。
- 順便拿到 account/rateLimits/updated：ChatGPT 方案的 5 小時 / 7 天額度用了幾 %（exec 拿不到），顯示在用量那裡。

app-server 還標著 experimental：初始化失敗、協定對不上、行程死了，chat.py 都退回 codex exec（engines.run_codex）。
整批翻譯不走這裡（不需要串流）。關掉：環境變數 EASYREAD_NO_LIVE=1。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import queue
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path

from . import codex_lean, engines, usage, webtools
from .i18n import tr
from .log import log

_REQUEST_TIMEOUT = 30
_disabled = False


class Unavailable(engines.EngineError):
    """app-server 起不來或協定對不上：呼叫方退回 codex exec。"""


class Busy(engines.EngineError):
    """OpenAI 那邊暫時接不了（模型滿載、429、連線重試用完）：還沒出字的話等一下再問一次就好（見 stream）。"""


# 這幾種是「現在太擠」，不是這一問有問題：codexErrorInfo（camelCase）或訊息對得上其中一個
_BUSY_INFO = {"serverOverloaded", "rateLimitExceeded", "responseTooManyFailedAttempts", "responseStreamDisconnected",
              "responseStreamConnectionFailed", "httpConnectionFailed", "internalServerError"}
_BUSY_TEXT = ("at capacity", "overloaded", "too many requests", "exceeded retry limit", "stream disconnected", "429", "503", "502")
RETRY_WAITS = (3, 8)  # 太擠時自動再問：隔幾秒各試一次（都不行才把錯誤交給讀者）


def _is_busy(err: dict | str) -> bool:
    info = err.get("codexErrorInfo") if isinstance(err, dict) else None
    kind = info if isinstance(info, str) else next(iter(info), "") if isinstance(info, dict) else ""
    if kind in ("usageLimitExceeded", "unauthorized", "contextWindowExceeded", "badRequest"):  # 額度用完、沒登入…再試也一樣
        return False
    text = str(err.get("message") if isinstance(err, dict) else err).lower()
    return kind in _BUSY_INFO or any(k in text for k in _BUSY_TEXT)


def busy_message(model: str, detail: str) -> str:
    """試了幾次還是太擠：說清楚不是讀者的問題、可以怎麼辦。"""
    return tr("{model} 現在太擠（OpenAI 那邊暫時接不了，不是你的額度用完）。等一下再問，或在輸入框下面換一個模型、打開 Fast。", model=model or "Codex") + "\n" + detail


def tier_of(c: dict):
    """設定裡的 Fast → app-server 的 serviceTier："fast"（＝priority，約 2 倍速、額度用得快）、"default"（標準）；沒設就不傳，照 Codex 自己的設定。"""
    v = (c.get("service_tier") or "").strip()
    return v if v in ("fast", "priority", "flex", "default") else None


def enabled() -> bool:
    return not _disabled and os.environ.get("EASYREAD_NO_LIVE", "") not in ("1", "true", "yes")


def disable() -> None:
    global _disabled, _client
    _disabled = True
    with _lock:
        c, _client = _client, None
    if c:
        c.close()


def image_item(path: Path) -> dict | None:
    """圖片檔 → turn/start 的 image item。file:// 會被 OpenAI 退回（實測），要用 data: URL。"""
    mime = mimetypes.guess_type(str(path))[0] or ""
    if not mime.startswith("image/"):
        return None
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return {"type": "image", "url": f"data:{mime};base64," + base64.b64encode(data).decode("ascii")}


def items(text: str, images=None) -> list[dict]:
    out = [x for x in (image_item(Path(p)) for p in (images or [])) if x]
    return out + [{"type": "text", "text": text}]


def _rate_limits(rl: dict | None) -> dict | None:
    """account/rateLimits/updated → 和 Claude 一樣的 {five_hour, seven_day} 格式（used 是 0–1）。"""
    if not isinstance(rl, dict):
        return None
    out: dict = {}
    for name, w in (("primary", rl.get("primary")), ("secondary", rl.get("secondary"))):
        if not isinstance(w, dict) or w.get("usedPercent") is None:
            continue
        mins = int(w.get("windowDurationMins") or 0)
        k = "five_hour" if mins <= 600 or name == "primary" else "seven_day"
        if k in out:
            k = "seven_day"
        out[k] = {"used": float(w["usedPercent"]) / 100, "resets_at": w.get("resetsAt")}
    if not out:
        return None
    out["engine"] = "codex"
    return out


class Client:
    """一個 app-server 行程。request() 同步等回覆；每個 thread 的通知各排一隊，turn() 從自己那隊讀。"""

    def __init__(self, c: dict):
        exe = engines.codex_path(c)
        if not exe:
            raise Unavailable(tr("找不到 Codex 命令：{cmd}（先装好并登录 Codex CLI）", cmd=c.get("command") or "codex"))
        args = [exe, "app-server", *codex_lean.args(tools=True), *list(c.get("extra_args") or [])]  # 工具給不給由每個對話的設定決定（thread_config）
        self.proc = engines._popen(args, Path(tempfile.gettempdir()))
        self.lock = threading.Lock()
        self.next_id = 1
        self.replies: dict[int, queue.Queue] = {}
        self.events: dict[str, queue.Queue] = {}  # threadId → 通知
        self.rate_limits: dict | None = None
        self.closed = False
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.request("initialize", {"clientInfo": {"name": "easyread", "title": "EasyRead", "version": "1"},
                                        "capabilities": {"experimentalApi": True}})
            self._send({"method": "initialized", "params": {}})
        except engines.EngineError as e:
            self.close()
            raise Unavailable(str(e)) from None

    # ---- 底層 ----
    def _send(self, obj: dict) -> None:
        try:
            self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise Unavailable(str(e)) from None

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "id" in ev and "method" not in ev:
                    q = self.replies.get(ev["id"])
                    if q:
                        q.put(ev)
                    continue
                m = ev.get("method") or ""
                p = ev.get("params") or {}
                if m == "account/rateLimits/updated":
                    self.rate_limits = _rate_limits(p.get("rateLimits"))
                tid = p.get("threadId") or (p.get("thread") or {}).get("id")
                if tid and tid in self.events:
                    self.events[tid].put(ev)
        except (OSError, ValueError):
            pass
        self.closed = True
        for q in list(self.replies.values()) + list(self.events.values()):
            q.put(None)

    def alive(self) -> bool:
        return not self.closed and self.proc.poll() is None

    def close(self) -> None:
        self.closed = True
        try:
            if self.proc.poll() is None:
                self.proc.kill()
        except OSError:
            pass

    def request(self, method: str, params: dict, timeout: float = _REQUEST_TIMEOUT):
        with self.lock:
            rid = self.next_id
            self.next_id += 1
            q: queue.Queue = queue.Queue()
            self.replies[rid] = q
        try:
            self._send({"id": rid, "method": method, "params": params})
            try:
                ev = q.get(timeout=timeout)
            except queue.Empty:
                raise Unavailable(tr("Codex app-server 没有回应（{method}）", method=method)) from None
            if ev is None:
                raise Unavailable(tr("Codex app-server 退出了"))
            if "error" in ev:
                raise engines.EngineError(str((ev["error"] or {}).get("message") or ev["error"]))
            return ev.get("result")
        finally:
            self.replies.pop(rid, None)

    # ---- 對話 ----
    def thread_start(self, cwd: Path, model: str, tier: str | None = None, web: bool = False) -> str:
        params: dict = {"cwd": str(cwd), "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": True,
                        "config": codex_lean.thread_config(web)}  # 不載入使用者的外掛、不能執行指令；web 才開上網搜尋
        if model:
            params["model"] = model
        if tier:
            params["serviceTier"] = tier
        res = self.request("thread/start", params) or {}
        tid = (res.get("thread") or {}).get("id") or res.get("threadId")
        if not tid:
            raise Unavailable(tr("Codex app-server 没有给出对话 id"))
        self.events[tid] = queue.Queue()
        return tid

    def turn(self, tid: str, inputs: list[dict], effort: str, cancel: threading.Event | None, meter: usage.Meter | None,
             timeout: float = 1200, tier: str | None = None, on_status=None, on_source=None) -> Iterator[str]:
        """送一輪、逐段吐文字；turn/completed 時記 token 和額度。取消就 turn/interrupt。
        on_status(dict)：還沒出字時發生了什麼（{"kind": "reconnect"|"thinking", …}），頁面拿去顯示在等待的地方；
        上網查的動作（{"kind": "search"|"open"|"find", …}）什麼時候發生都報。on_source(url, title, domain)：查到、打開的網頁。"""
        q = self.events.get(tid)
        if q is None:
            raise Unavailable(tr("Codex app-server 没有给出对话 id"))
        params: dict = {"threadId": tid, "input": inputs}
        ids = codex_lean.plugin_ids()
        if ids:
            params["disabledPluginIds"] = ids  # 外掛一律不載入（只寫在 thread/start 的設定裡擋不住，要兩邊都寫）
        if effort:
            params["effort"] = effort
        if tier:
            params["serviceTier"] = tier
        while True:  # 上一輪留下來沒讀完的通知（出錯、取消之後）不能算到這一輪頭上
            try:
                if q.get_nowait() is None:
                    raise engines.EngineError(tr("Codex app-server 退出了"))
            except queue.Empty:
                break
        self.request("turn/start", params)
        deadline = time.time() + timeout
        turn_id = None
        used = None
        got = False

        def tell(always=False, **st):
            if on_status and (always or not got):
                try:
                    on_status(st)
                except Exception:  # noqa: BLE001 —— 狀態只是給人看的，送不出去不能影響回答
                    pass
        finished = False  # 這一輪在 Codex 那邊結束了沒有（完成或失敗）；沒結束就離開（按了停止、逾時）要叫它停，不然它會寫到完、額度照扣
        searched = False  # 這一輪上網查過了沒有
        # 模型動手之前常先說一句「我會去查…」（agentMessage 的 phase 是 commentary）：那是進度，不是回答——拿去當等待時的狀態，不接進回答裡
        phases: dict[str, str] = {}
        notes: dict[str, str] = {}
        last_note = ""
        try:
            while True:
                try:
                    ev = q.get(timeout=0.2)
                except queue.Empty:
                    if cancel is not None and cancel.is_set():
                        raise engines.Cancelled() from None
                    if time.time() > deadline:
                        raise engines.EngineError(tr("超过 {n} 秒没有结果", n=int(timeout))) from None
                    continue
                if ev is None:
                    finished = True
                    raise engines.EngineError(tr("Codex app-server 退出了"))
                m = ev.get("method")
                p = ev.get("params") or {}
                if m == "turn/started":
                    turn_id = (p.get("turn") or {}).get("id") or p.get("turnId")
                elif m == "item/agentMessage/delta":
                    d = p.get("delta") or p.get("text") or ""
                    if d and phases.get(p.get("itemId") or "") == "commentary":
                        notes[p.get("itemId")] = notes.get(p.get("itemId"), "") + d
                    elif d:
                        got = True
                        yield d
                elif m == "item/started" and (p.get("item") or {}).get("type") == "agentMessage":
                    it = p.get("item") or {}
                    if it.get("id"):
                        phases[it["id"]] = it.get("phase") or ""
                elif m == "item/completed" and (p.get("item") or {}).get("type") == "agentMessage" and (p.get("item") or {}).get("phase") == "commentary":
                    it = p.get("item") or {}
                    note = str(it.get("text") or notes.get(it.get("id") or "", "")).strip()
                    if note:
                        last_note = note
                        tell(always=True, kind="note", text=note[:200])
                elif m == "thread/tokenUsage/updated":
                    used = (p.get("tokenUsage") or {}).get("last")
                elif m == "item/started" and (p.get("item") or {}).get("type") == "reasoning":
                    tell(kind="thinking")
                elif m == "item/started" and (p.get("item") or {}).get("type") == "webSearch":
                    if not searched:  # 第一次：「上網搜尋」；之後開始的那一下還不知道要查什麼，畫面留著上一個（搜尋「…」、讀某網站）
                        tell(always=True, kind="search", query="")
                    searched = True
                elif m == "item/completed" and (p.get("item") or {}).get("type") == "webSearch":
                    st, found = webtools.codex_item(p.get("item") or {})
                    if st:
                        tell(always=True, **st)
                    for f in found:
                        if on_source:
                            on_source(f["url"], f.get("title"), f.get("domain"), f.get("kind", "result"))
                elif m == "error":
                    err = p.get("error") or {}
                    msg = str((err.get("message") if isinstance(err, dict) else err) or p)[:600]
                    # willRetry：和 OpenAI 的連線斷了，Codex 自己會重連（「Reconnecting... 2/5」）——不是失敗，接著等。
                    # 2.1.0-tw.9 以前把它當成出錯直接結束，讀者看到的就是一句「Reconnecting... 2/5」，還得自己再問一次
                    if p.get("willRetry"):
                        tell(kind="reconnect", text=msg)
                        continue
                    finished = True
                    raise (Busy if not got and _is_busy(err) else engines.EngineError)(msg)
                elif m == "turn/completed":
                    finished = True
                    if meter is not None:
                        meter.add(**usage.from_codex_live(used, self.rate_limits))
                    turn = p.get("turn") or {}
                    if turn.get("status") == "failed" or turn.get("error"):
                        err = turn.get("error") or {}
                        msg = str((err.get("message") if isinstance(err, dict) else err) or tr("Codex 没有给出结果：{msg}", msg=""))[:600]
                        raise (Busy if not got and _is_busy(err or msg) else engines.EngineError)(msg)
                    if not got:
                        final = turn.get("finalMessage") or p.get("finalMessage") or last_note  # 只說了進度就結束（很少）：至少把那句給讀者
                        if final:
                            yield str(final)
                    return
        finally:
            if not finished and turn_id and self.alive():
                try:
                    self._send({"id": 0, "method": "turn/interrupt", "params": {"threadId": tid, "turnId": turn_id}})
                except engines.EngineError:
                    pass

# ---------- 單一行程 + 對話對應 ----------
_lock = threading.Lock()
_client: Client | None = None
_threads: dict[tuple, dict] = {}  # (文件 id, chat 的 thread id) → {"id": codex threadId, "turns": n, "key": (model, cwd)}


def client(c: dict) -> Client:
    """共用的 app-server 行程；死了就重開。起不來抛 Unavailable。"""
    global _client, _disabled
    if not enabled():
        raise Unavailable("disabled")
    with _lock:
        if _client and _client.alive():
            return _client
        _threads.clear()
        try:
            _client = Client(c)
        except Unavailable:
            _disabled = True  # 這版 Codex 沒有 app-server（或起不來）：之後都直接走 codex exec，不每問一次試一次
            raise
        return _client


def warm(c: dict) -> None:
    """讀者打開面板、開始打字：先把 app-server 拉起來（背景做）。"""
    if not enabled():
        return

    def go():
        try:
            client(c)
        except Exception as e:  # noqa: BLE001
            log.info("Codex app-server 預先啟動失敗：%s", str(e)[-200:])
    threading.Thread(target=go, daemon=True).start()


def bound_turns(ws_id: str, thread: str | None, model: str, cwd: Path, web: bool = False) -> int | None:
    """這個對話在 app-server 裡已經有幾輪（模型沒換、上網的開關沒換、行程還活著）；沒有回 None。"""
    if not thread or not enabled():
        return None
    with _lock:
        t = _threads.get((ws_id, thread))
        if not t or t["key"] != (model or "", str(cwd), bool(web)) or not (_client and _client.alive()):
            return None
        return t["turns"]


def stream(c: dict, text: str, cwd: Path, cancel, meter=None, images=None, thread: str | None = None,
           expect_turns: int | None = None, followup_text: str | None = None, on_live=None, on_status=None,
           web: bool = False, on_source=None) -> Iterator[str]:
    """問一輪。thread 給了就接著同一個 app-server 對話（輪數對得上時只送 followup_text）。
    OpenAI 那邊太擠（滿載、429、重連用完）而且還沒出字：隔幾秒自動再問，最多 len(RETRY_WAITS) 次；on_status 會收到 {"kind": "busy", …}。"""
    model = c.get("model") or ""
    key = (model, str(cwd), bool(web))  # 上網的開關換了：Codex 對話的工具不一樣，開新的
    ws_id = Path(cwd).name
    tier = tier_of(c)
    attempt = 0
    while True:
        cli = client(c)
        with _lock:
            t = _threads.get((ws_id, thread)) if thread else None
            if t and (t["key"] != key or (expect_turns is not None and t["turns"] != expect_turns)):
                t = None
        use_follow = bool(t) and bool(followup_text)
        if not t:
            tid = cli.thread_start(Path(cwd), model, tier, web)
            t = {"id": tid, "turns": 0, "key": key}
            if thread:
                with _lock:
                    _threads[(ws_id, thread)] = t
        if on_live:
            on_live()
        ok = False
        try:
            for piece in cli.turn(t["id"], items(followup_text if use_follow else text, images), c.get("reasoning_effort") or "", cancel, meter,
                                  int(c.get("timeout") or 1200), tier, on_status, on_source):
                yield piece
            t["turns"] += 1
            ok = True
            return
        except Busy as e:  # 只在還沒出字時抛
            if attempt >= len(RETRY_WAITS) or (cancel is not None and cancel.is_set()):
                raise engines.EngineError(busy_message(model, str(e))) from None
            wait = RETRY_WAITS[attempt]
            attempt += 1
            log.info("Codex 太擠（%s），%d 秒後再問一次（第 %d 次）", str(e)[:120], wait, attempt)  # i18n-ok 終端機記錄
            if on_status:
                try:
                    on_status({"kind": "busy", "attempt": attempt, "of": len(RETRY_WAITS), "wait": wait, "text": str(e)[:200]})
                except Exception:  # noqa: BLE001
                    pass
            end = time.time() + wait
            while time.time() < end:
                if cancel is not None and cancel.is_set():
                    raise engines.Cancelled() from None
                time.sleep(0.2)
        finally:
            # 沒答完（出錯、取消、太擠）：這個 app-server 對話裡留著半輪，接著用會對不上（整份文件再送一次、讀到上一輪剩下的通知）——
            # 解開，下一問開新的（server 那邊看到沒綁著，會送完整的提示詞和對話記錄）。一次性的（選字翻譯）用完就不用再收通知
            if not ok or not thread:
                cli.events.pop(t["id"], None)
                if thread:
                    with _lock:
                        if _threads.get((ws_id, thread)) is t:
                            _threads.pop((ws_id, thread), None)
