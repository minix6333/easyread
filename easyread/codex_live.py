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

from . import codex_lean, engines, usage
from .i18n import tr
from .log import log

_REQUEST_TIMEOUT = 30
_disabled = False


class Unavailable(engines.EngineError):
    """app-server 起不來或協定對不上：呼叫方退回 codex exec。"""


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
        args = [exe, "app-server", *codex_lean.args(), *list(c.get("extra_args") or [])]
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
    def thread_start(self, cwd: Path, model: str) -> str:
        params: dict = {"cwd": str(cwd), "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": True}
        if model:
            params["model"] = model
        res = self.request("thread/start", params) or {}
        tid = (res.get("thread") or {}).get("id") or res.get("threadId")
        if not tid:
            raise Unavailable(tr("Codex app-server 没有给出对话 id"))
        self.events[tid] = queue.Queue()
        return tid

    def turn(self, tid: str, inputs: list[dict], effort: str, cancel: threading.Event | None, meter: usage.Meter | None,
             timeout: float = 1200) -> Iterator[str]:
        """送一輪、逐段吐文字；turn/completed 時記 token 和額度。取消就 turn/interrupt。"""
        q = self.events.get(tid)
        if q is None:
            raise Unavailable(tr("Codex app-server 没有给出对话 id"))
        params: dict = {"threadId": tid, "input": inputs}
        if effort:
            params["effort"] = effort
        self.request("turn/start", params)
        deadline = time.time() + timeout
        turn_id = None
        used = None
        got = False
        while True:
            try:
                ev = q.get(timeout=0.2)
            except queue.Empty:
                if cancel is not None and cancel.is_set():
                    if turn_id:
                        try:
                            self._send({"id": 0, "method": "turn/interrupt", "params": {"threadId": tid, "turnId": turn_id}})
                        except engines.EngineError:
                            pass
                    raise engines.Cancelled()
                if time.time() > deadline:
                    raise engines.EngineError(tr("超过 {n} 秒没有结果", n=int(timeout)))
                continue
            if ev is None:
                raise engines.EngineError(tr("Codex app-server 退出了"))
            m = ev.get("method")
            p = ev.get("params") or {}
            if m == "turn/started":
                turn_id = (p.get("turn") or {}).get("id") or p.get("turnId")
            elif m == "item/agentMessage/delta":
                d = p.get("delta") or p.get("text") or ""
                if d:
                    got = True
                    yield d
            elif m == "thread/tokenUsage/updated":
                used = (p.get("tokenUsage") or {}).get("last")
            elif m == "error":
                err = p.get("error") or {}
                raise engines.EngineError(str(err.get("message") or err or p)[:600])
            elif m == "turn/completed":
                if meter is not None:
                    meter.add(**usage.from_codex_live(used, self.rate_limits))
                turn = p.get("turn") or {}
                if turn.get("status") == "failed" or turn.get("error"):
                    raise engines.EngineError(str(turn.get("error") or tr("Codex 没有给出结果：{msg}", msg="")))
                if not got:
                    final = turn.get("finalMessage") or p.get("finalMessage")
                    if final:
                        yield str(final)
                return


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


def bound_turns(ws_id: str, thread: str | None, model: str, cwd: Path) -> int | None:
    """這個對話在 app-server 裡已經有幾輪（模型沒換、行程還活著）；沒有回 None。"""
    if not thread or not enabled():
        return None
    with _lock:
        t = _threads.get((ws_id, thread))
        if not t or t["key"] != (model or "", str(cwd)) or not (_client and _client.alive()):
            return None
        return t["turns"]


def stream(c: dict, text: str, cwd: Path, cancel, meter=None, images=None, thread: str | None = None,
           expect_turns: int | None = None, followup_text: str | None = None, on_live=None) -> Iterator[str]:
    """問一輪。thread 給了就接著同一個 app-server 對話（輪數對得上時只送 followup_text）。"""
    cli = client(c)
    model = c.get("model") or ""
    key = (model, str(cwd))
    ws_id = Path(cwd).name
    with _lock:
        t = _threads.get((ws_id, thread)) if thread else None
        if t and (t["key"] != key or (expect_turns is not None and t["turns"] != expect_turns)):
            t = None
    use_follow = bool(t) and bool(followup_text)
    if not t:
        tid = cli.thread_start(Path(cwd), model)
        t = {"id": tid, "turns": 0, "key": key}
        if thread:
            with _lock:
                _threads[(ws_id, thread)] = t
    if on_live:
        on_live()
    try:
        for piece in cli.turn(t["id"], items(followup_text if use_follow else text, images), c.get("reasoning_effort") or "", cancel, meter,
                              int(c.get("timeout") or 1200)):
            yield piece
        t["turns"] += 1
    finally:
        if not thread:  # 一次性的（選字翻譯）：這個 app-server 對話用完就不用再收它的通知
            cli.events.pop(t["id"], None)
