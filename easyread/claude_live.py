"""Claude Code 常駐行程：用 --input-format stream-json 一次啟動、多次提問（問 AI、選字翻譯、整批翻譯都走這裡）。

為什麼：
- 每次 claude -p 都要重新啟動 Node、讀設定，實測約 0.7 秒；加上模型本身的首字時間，短問題光等就 2 秒。
  讀者打開「問 AI」面板或開始打字時先把行程拉起來（warm），按送出時只剩模型的時間，首字壓到 1 秒以內。
- 同一個對話接著問，行程留著不關：Claude Code 自己記著前面的對話（API 端有快取），追問只送新問題，首字約 0.7 秒；
  也不用每次把整段對話再發一遍（省 token）。
- 圖片（框選的區域、貼進來的圖、翻譯時的原頁圖）直接放進訊息（image block），模型不必再用 Read 工具讀一次，
  實測少一個來回、首字從 5 秒降到 1.6 秒，token 也少。

行程沒收到訊息前不連網、不花額度；閒置幾分鐘自動關掉。這版 Claude Code 不認這些參數時，chat.py 退回一次性呼叫。
關掉：環境變數 EASYREAD_NO_LIVE=1。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import queue
import threading
import time
from collections.abc import Iterator
from pathlib import Path

from . import engines, usage
from .i18n import tr
from .log import log

MAX_SESSIONS = 6     # 最多同時留幾個行程（每個約 200 MB）
IDLE_FRESH = 180     # 預先啟動、還沒用過的行程閒置多久關掉
IDLE_BOUND = 600     # 綁著某個對話的行程閒置多久關掉
_disabled = False


class Unsupported(engines.EngineError):
    """這版 Claude Code 不認 --input-format stream-json（或行程還沒答就退出了）：呼叫方退回一次性呼叫。"""


def enabled() -> bool:
    return not _disabled and os.environ.get("EASYREAD_NO_LIVE", "") not in ("1", "true", "yes")


def disable() -> None:
    """第一次發現不支援就整個關掉，後面都走舊路，不每問一次都失敗一次。"""
    global _disabled
    _disabled = True
    close_all()


def image_block(path: Path) -> dict | None:
    """圖片檔 → API 的 image block；讀不到、不是圖就略過。"""
    mime = mimetypes.guess_type(str(path))[0] or ""
    if not mime.startswith("image/"):
        return None
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(data).decode("ascii")}}


def content(text: str, images=None) -> list[dict]:
    """一則訊息：圖在前、文字在後。"""
    blocks = [b for b in (image_block(Path(p)) for p in (images or [])) if b]
    return blocks + [{"type": "text", "text": text}]


def key_of(c: dict, cwd: Path, tools: str | None, system_prompt: str | None) -> tuple:
    return (c.get("command") or "claude", c.get("model") or "", c.get("reasoning_effort") or "", tuple(c.get("extra_args") or []),
            tools, system_prompt or "", str(cwd))


class Session:
    """一個常駐的 claude -p 行程。turn() 送一則訊息、逐字吐回答；同一個 Session 可以多輪（Claude Code 記著對話）。"""

    def __init__(self, c: dict, cwd: Path, tools: str | None = "Read", system_prompt: str | None = None):
        exe = engines.claude_path(c)
        if not exe:
            raise engines.EngineError(tr("找不到 Claude Code 命令（先装好并登录 Claude Code）"))
        self.key = key_of(c, cwd, tools, system_prompt)
        args = [exe, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--include-partial-messages", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
        if tools is not None:  # 只給用得到的工具：其餘內建工具的定義每問一次都要發（約 2.7 萬 token）
            args += ["--tools", tools]
            if tools:
                args += ["--allowedTools", tools]
        if c.get("model"):
            args += ["--model", c["model"]]
        if c.get("reasoning_effort"):
            args += ["--effort", c["reasoning_effort"]]
        args += list(c.get("extra_args") or [])
        if system_prompt:
            args += ["--system-prompt", system_prompt]
        self.args = args
        self.cwd = Path(cwd)
        self.proc = engines._popen(args, self.cwd)
        self.q: queue.Queue = queue.Queue()
        self.turns = 0
        self.busy = False
        self.bound: str | None = None    # 綁著哪個對話（chat 的 thread id）
        self.model: str | None = None    # Claude Code 報的實際模型
        self.last_result: str = ""
        self.started = self.last_used = time.time()
        self.closed = False
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for line in self.proc.stdout:
                self.q.put(line)
        except (OSError, ValueError):
            pass
        self.q.put(None)

    def alive(self) -> bool:
        return not self.closed and self.proc.poll() is None

    def close(self) -> None:
        self.closed = True
        try:
            if self.proc.poll() is None:
                self.proc.kill()
        except OSError:
            pass

    def _stderr(self) -> str:
        try:
            return (self.proc.stderr.read() or "")[-600:]
        except (OSError, ValueError):
            return ""

    def turn(self, blocks: list[dict], cancel: threading.Event | None = None, on_model=None, meter: usage.Meter | None = None,
             timeout: float | None = None) -> Iterator[str]:
        """送一則訊息，逐段吐出回答文字。取消就把行程殺掉（這一輪作廢，下次重新啟動）。"""
        self.busy = True
        self.last_used = time.time()
        deadline = time.time() + timeout if timeout else None
        got = False
        rate = None
        try:
            try:
                self.proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": blocks}}, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
            except (OSError, ValueError) as e:
                self.close()
                raise Unsupported(self._stderr() or str(e)) from None
            while True:
                try:
                    line = self.q.get(timeout=0.2)
                except queue.Empty:
                    if cancel is not None and cancel.is_set():
                        self.close()
                        raise engines.Cancelled()
                    if deadline and time.time() > deadline:
                        self.close()
                        raise engines.EngineError(tr("超过 {n} 秒没有结果", n=int(timeout)))
                    continue
                if line is None:  # 行程退出了
                    self.close()
                    err = self._stderr()
                    if self.turns == 0 and not got:
                        raise Unsupported(err or tr("Claude Code 没有输出"))
                    raise engines.EngineError(err or tr("Claude Code 没有输出"))
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = ev.get("type")
                if t == "system" and ev.get("subtype") == "init":
                    if ev.get("model"):
                        self.model = ev["model"]
                        if on_model:
                            on_model(ev["model"])
                elif t == "stream_event":
                    d = (ev.get("event") or {}).get("delta") or {}
                    if d.get("type") == "text_delta" and d.get("text"):
                        got = True
                        yield d["text"]
                elif t == "rate_limit_event":
                    rate = ev
                elif t == "result":
                    if meter is not None:
                        meter.add(**usage.from_claude(ev, rate))
                    if ev.get("is_error"):
                        self.close()  # 出錯的對話不留著
                        raise engines.EngineError(tr("Claude Code 出错：{detail}", detail=str(ev.get("result") or ev.get("subtype"))))
                    self.last_result = str(ev.get("result") or "")
                    if not got and self.last_result:
                        yield self.last_result
                    self.turns += 1
                    return
        finally:
            self.busy = False
            self.last_used = time.time()


# ---------- 行程池 ----------
_lock = threading.Lock()
_sessions: list[Session] = []
_spawning: set[tuple] = set()  # 正在背景啟動的（warm），同一種不開第二個
_reaper_started = False


def _reaper():
    while True:
        time.sleep(30)
        now = time.time()
        with _lock:
            for s in list(_sessions):
                idle = now - s.last_used
                if not s.alive() or (not s.busy and idle > (IDLE_BOUND if s.turns else IDLE_FRESH)):
                    _sessions.remove(s)
                    s.close()


def _ensure_reaper():
    global _reaper_started
    if not _reaper_started:
        _reaper_started = True
        threading.Thread(target=_reaper, daemon=True).start()


def _spawn(c: dict, cwd: Path, tools, system_prompt) -> Session:
    s = Session(c, cwd, tools, system_prompt)
    with _lock:
        if len(_sessions) >= MAX_SESSIONS:  # 太多了：先關最久沒用、沒在忙的
            idle = sorted((x for x in _sessions if not x.busy), key=lambda x: x.last_used)
            if idle:
                _sessions.remove(idle[0])
                idle[0].close()
        _sessions.append(s)
    _ensure_reaper()
    return s


def warm(c: dict, cwd: Path, tools: str | None = "Read", system_prompt: str | None = None) -> None:
    """讀者打開面板、開始打字、選了字：先把行程拉起來（背景做，不等）。已經有一個備著就不再開。"""
    if not enabled():
        return
    key = key_of(c, cwd, tools, system_prompt)
    with _lock:
        if key in _spawning or any(s.key == key and s.turns == 0 and not s.busy and s.alive() for s in _sessions):
            return
        if len(_sessions) >= MAX_SESSIONS and all(s.busy for s in _sessions):
            return
        _spawning.add(key)

    def go():
        try:
            _spawn(c, cwd, tools, system_prompt)
        except Exception as e:  # noqa: BLE001 —— 預熱失敗不影響之後正常提問
            log.info("Claude Code 預先啟動失敗：%s", str(e)[-200:])
        finally:
            with _lock:
                _spawning.discard(key)
    threading.Thread(target=go, daemon=True).start()


def acquire(c: dict, cwd: Path, tools: str | None = "Read", system_prompt: str | None = None, thread: str | None = None,
            expect_turns: int | None = None) -> Session:
    """拿一個行程來問：thread 給了就先找綁著這個對話、而且輪數對得上的（追問）；沒有就拿預熱好的，再沒有就現開一個。"""
    key = key_of(c, cwd, tools, system_prompt)
    with _lock:
        if thread:
            for s in list(_sessions):
                if s.bound == thread:
                    if s.key == key and s.alive() and not s.busy and (expect_turns is None or s.turns == expect_turns):
                        s.busy = True
                        return s
                    _sessions.remove(s)  # 換了模型、對話記錄對不上、或行程死了：這個不能接著用
                    s.close()
        fresh = next((s for s in _sessions if s.key == key and s.turns == 0 and not s.busy and s.alive()), None)
        if fresh:
            fresh.busy = True
            fresh.bound = thread
            return fresh
    s = _spawn(c, cwd, tools, system_prompt)
    s.busy = True
    s.bound = thread
    return s


def release(s: Session, keep: bool) -> None:
    """用完：keep 留著給同一個對話追問；不留就關掉。"""
    s.busy = False
    if keep and s.alive() and s.bound:
        return
    with _lock:
        if s in _sessions:
            _sessions.remove(s)
    s.close()


def bound_turns(thread: str | None) -> int | None:
    """綁著這個對話的行程已經答了幾輪；沒有這樣的行程回 None。chat.py 用它決定要送完整提示詞還是只送追問。"""
    if not thread or not enabled():
        return None
    with _lock:
        s = next((x for x in _sessions if x.bound == thread and x.alive() and not x.busy), None)
        return s.turns if s else None


def close_all() -> None:
    with _lock:
        for s in _sessions:
            s.close()
        _sessions.clear()


def one_shot(c: dict, cwd: Path, blocks: list[dict], cancel=None, meter=None, timeout: float | None = None,
             tools: str | None = "Read") -> str:
    """一次性呼叫（整批翻譯）：開行程、送一則帶圖的訊息、拿整段結果、關掉。不支援時抛 Unsupported。"""
    s = Session(c, cwd, tools)
    try:
        pieces = list(s.turn(blocks, cancel, None, meter, timeout))
        return s.last_result or "".join(pieces)
    finally:
        s.close()
