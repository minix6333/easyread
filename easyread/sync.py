"""文獻庫放在雲端硬碟同步資料夾時，把別台電腦的筆記日誌合併進來（paths.py 說明了檔案怎麼擺）。

- 每篇論文的 sync/<裝置 id>.jsonl 是那台電腦寫的操作日誌（一行一批 {"t", "ops"}）；這台只寫自己的那份。
- 每 3 秒看一遍別台的日誌有沒有變長（stat 很便宜），有就從上次讀到的位置接著讀、套進本機的 reader.json
  （store.apply_ops 本來就是「同一條以較新的為準」，所以不管先後、重複套都收斂）。讀到哪記在快取的 sync-state.json。
- 雲端硬碟自己產生的衝突副本（檔名帶 conflict、(1)）也順便找出來，狀態 API 回報給頁面提醒。
- 翻譯任務：job.json 記了是哪台電腦在跑；別台看到的是「另一台電腦正在翻譯」（jobs.py）。
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from . import config, paths
from .log import log
from .store import Workspace, now_iso, read_json, write_json_atomic

INTERVAL = 3.0
_CONFLICT = re.compile(r"\(conflict|\(\d+\)\.json$|conflicted copy", re.I)
_state_lock = threading.Lock()
_status: dict = {"enabled": False, "applied": 0, "last_remote_at": "", "devices": {}, "conflicts": []}


def state_path() -> Path:
    return config.CACHE_DIR / "sync-state.json"


def status() -> dict:
    with _state_lock:
        return json.loads(json.dumps(_status))


def _load_state() -> dict:
    data = read_json(state_path(), {}) or {}
    return data if isinstance(data, dict) else {}


def _save_state(state: dict) -> None:
    state_path().parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(state_path(), state)


def pull_once(lib_root: Path, state: dict | None = None) -> int:
    """把所有論文裡別台電腦日誌的新內容套進來，回傳套用了幾批。"""
    me = paths.device()["id"]
    state = _load_state() if state is None else state
    offsets = state.setdefault("offsets", {})
    applied_batches = 0
    conflicts: list[str] = []
    devices = state.setdefault("devices", {})
    for ws_dir in sorted(p for p in Path(lib_root).iterdir() if p.is_dir() and not p.name.startswith(".")):
        sync_dir = ws_dir / "sync"
        if not sync_dir.is_dir():
            continue
        for f in sorted(sync_dir.glob("*.jsonl")):
            dev = f.stem
            if dev == me:
                continue
            key = f"{ws_dir.name}/{dev}"
            try:
                size = f.stat().st_size
            except OSError:
                continue
            done = int(offsets.get(key, 0))
            if size < done:  # 檔案被換掉或縮短（極少見）：從頭重套，反正冪等
                done = 0
            if size == done:
                continue
            ops_batches: list[tuple[int, list]] = []
            with open(f, "rb") as fh:
                fh.seek(done)
                pos = done
                for raw in fh:
                    pos += len(raw)
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        batch = json.loads(line.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        pos -= len(raw)  # 可能還沒寫完（雲端硬碟傳到一半）：這行下次再讀
                        break
                    if isinstance(batch, dict) and isinstance(batch.get("ops"), list):
                        ops_batches.append((pos, batch["ops"]))
                        devices[dev] = {"at": batch.get("t") or "", "paper": ws_dir.name}
                    else:
                        ops_batches.append((pos, []))
            if not ops_batches:
                continue
            ws = Workspace(ws_dir)
            try:
                for pos, ops in ops_batches:
                    if ops:
                        ws.apply_reader_ops(ops, client=f"sync:{dev}", journal=False)
                        applied_batches += 1
                    offsets[key] = pos
            except Exception:  # noqa: BLE001
                log.exception("合併另一台電腦的筆記失敗 %s", key)
        for p in ws_dir.iterdir():
            if _CONFLICT.search(p.name):
                conflicts.append(f"{ws_dir.name}/{p.name}")
    _save_state(state)
    with _state_lock:
        _status.update(enabled=True, conflicts=conflicts[:50], devices=dict(devices))
        if applied_batches:
            _status["applied"] = int(_status.get("applied", 0)) + applied_batches
            _status["last_remote_at"] = now_iso()
    return applied_batches


class Puller:
    """背景執行緒：每 INTERVAL 秒拉一次；close() 停掉。"""

    def __init__(self, lib_root: Path):
        self.lib_root = Path(lib_root)
        self.stopped = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if not paths.is_synced(self.lib_root):
            return
        with _state_lock:
            _status["enabled"] = True

        def run():
            while not self.stopped.wait(INTERVAL):
                try:
                    pull_once(self.lib_root)
                except Exception:  # noqa: BLE001
                    log.exception("同步拉取失敗")
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        log.info("同步：文獻庫在同步資料夾，這台電腦是 %s（%s）", paths.device()["name"], paths.device()["id"])

    def close(self) -> None:
        self.stopped.set()


def wait_quiet(seconds: float = 0.5) -> None:
    time.sleep(seconds)
