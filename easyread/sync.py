"""文獻庫放在雲端硬碟同步資料夾時，把別台電腦的筆記日誌合併進來（paths.py 說明了檔案怎麼擺）。

- 每篇論文的 sync/<裝置 id>.jsonl 是那台電腦寫的操作日誌（一行一批 {"t", "ops"}）；這台只寫自己的那份。
- 每 3 秒看一遍別台的日誌有沒有變長（stat 很便宜），有就從上次讀到的位置接著讀、套進本機的 reader.json
  （store.apply_ops 本來就是「同一條以較新的為準」，所以不管先後、重複套都收斂）。讀到哪記在快取的 sync-state.json。
- 雲端硬碟自己產生的衝突副本（檔名帶 conflict、(1)）也順便找出來，狀態 API 回報給頁面提醒。
- 翻譯任務：job.json 記了是哪台電腦在跑；別台看到的是「另一台電腦正在翻譯」（jobs.py）。
- 換了文獻庫（設定裡切換、或跟著路標自動換，見 cloudsync.py）：讀到哪的記錄作廢重來，這台快取裡的筆記寫一份快照進新文獻庫的日誌，
  別台才看得到這台在舊資料夾裡記的東西。
- 這台某一篇的快取不見了（清過快取、重裝）：那一篇所有的日誌（包括自己的）從頭重套，筆記就回來了。
- 同一個執行緒順便管裝置心跳（cloudsync.tick）：誰在用這個文獻庫、對方有沒有收到這台的更新。
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from . import cloudsync, config, paths
from .log import log
from .store import Workspace, now_iso, read_json, write_json_atomic

INTERVAL = 3.0
_CONFLICT = re.compile(r"\(conflict|\(\d+\)\.json$|conflicted copy", re.I)
_state_lock = threading.Lock()
_status: dict = {"enabled": False, "applied": 0, "last_remote_at": "", "last_pull_at": "", "last_from": "", "devices": {}, "conflicts": []}


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


_pull_lock = threading.Lock()


def pull_once(lib_root: Path, state: dict | None = None) -> int:
    """把所有論文裡別台電腦日誌的新內容套進來，回傳套用了幾批。背景執行緒和「立即同步」都會叫，一次只跑一個。"""
    with _pull_lock:
        return _pull(lib_root, state)


def _pull(lib_root: Path, state: dict | None = None) -> int:
    me = paths.device()["id"]
    state = _load_state() if state is None else state
    if state.get("root") != str(lib_root):  # 換了文獻庫（或升級後第一次）：舊的讀取位置對不上新資料夾的檔案
        state["offsets"] = {}
        state["root"] = str(lib_root)
        _publish_local(Path(lib_root))
    offsets = state.setdefault("offsets", {})
    applied_batches = 0
    last_from = ""
    conflicts: list[str] = []
    devices = state.setdefault("devices", {})
    for ws_dir in sorted(p for p in Path(lib_root).iterdir() if p.is_dir() and not p.name.startswith(".")):
        sync_dir = ws_dir / "sync"
        if not sync_dir.is_dir():
            continue
        # 這台沒有這一篇的筆記快取（別台匯入的、或快取被清掉）：全部的日誌從頭套，包括自己以前寫的
        have_cache = (paths.cache_dir(ws_dir) / "reader.json").exists()
        for f in sorted(sync_dir.glob("*.jsonl")):
            dev = f.stem
            if dev == me and have_cache:
                continue
            key = f"{ws_dir.name}/{dev}"
            try:
                size = f.stat().st_size
            except OSError:
                continue
            done = int(offsets.get(key, 0)) if have_cache else 0
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
                        if dev != me:
                            last_from = dev
                    offsets[key] = pos
                if not ws.reader_path.exists():  # 套完沒有任何改動也要留一份，不然每一輪都當成「沒有快取」從頭重讀
                    write_json_atomic(ws.reader_path, ws.load("reader"))
            except Exception:  # noqa: BLE001
                log.exception("合併另一台電腦的筆記失敗 %s", key)
        for p in ws_dir.iterdir():
            if _CONFLICT.search(p.name):
                conflicts.append(f"{ws_dir.name}/{p.name}")
    _save_state(state)
    with _state_lock:
        _status.update(enabled=True, conflicts=conflicts[:50], last_pull_at=now_iso(), devices=dict(devices))
        if applied_batches and last_from:
            _status["applied"] = int(_status.get("applied", 0)) + applied_batches
            _status["last_remote_at"] = now_iso()
            _status["last_from"] = last_from
    return applied_batches


def _publish_local(lib_root: Path) -> None:
    """這台快取裡每一篇的筆記，寫一份快照進這個文獻庫裡自己的日誌（別台照「新的贏」合併，重複寫無妨）。"""
    if not paths.is_synced(lib_root):
        return
    n = 0
    try:
        folders = [p for p in lib_root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    except OSError:
        return
    for ws_dir in folders:
        cached = paths.cache_dir(ws_dir) / "reader.json"
        try:
            data = read_json(cached, None)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not any(data.get(k) for k in ("notes", "page_notes", "paper_note", "edits")):
            continue
        try:
            paths.sync_append(ws_dir, [{"op": "snapshot", "reader": data, "at": now_iso()}])
            n += 1
        except OSError:
            log.warning("寫筆記快照失敗 %s", ws_dir, exc_info=True)
    if n:
        log.info("同步：文獻庫換了位置，這台 %d 篇的筆記已寫進新文獻庫的日誌", n)


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
        cloudsync.ensure_marker(self.lib_root)

        def run():
            try:
                cloudsync.beat(self.lib_root)  # 一啟動就報到，別台馬上看得到這台在用這個資料夾
            except Exception:  # noqa: BLE001
                log.exception("寫裝置心跳失敗")
            n = 0
            while not self.stopped.wait(INTERVAL if n else 0.2):
                n += 1
                try:
                    pull_once(self.lib_root)
                except Exception:  # noqa: BLE001
                    log.exception("同步拉取失敗")
                if n % 5 == 1:  # 每 15 秒看一次別台的心跳
                    try:
                        cloudsync.tick(self.lib_root)
                    except Exception:  # noqa: BLE001
                        log.exception("裝置心跳失敗")
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        log.info("同步：文獻庫在同步資料夾，這台電腦是 %s（%s）", paths.device()["name"], paths.device()["id"])

    def close(self) -> None:
        self.stopped.set()


def wait_quiet(seconds: float = 0.5) -> None:
    time.sleep(seconds)
