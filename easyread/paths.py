"""同步模式的路徑：文獻庫放在雲端硬碟（Google Drive、OneDrive、Dropbox、iCloud）的同步資料夾時，
可以重算的東西放本機快取，不進雲端；筆記改成每台電腦各寫一份日誌（sync/<裝置>.jsonl），讀的時候合併（見 sync.py）。

- is_synced(lib_root)：文獻庫根目錄有 .easyread-sync.json 標記，或路徑在已知的同步資料夾裡（第一次碰到就寫上標記）。
- derived(paper_root, name)：pages / extract / history 在同步模式下對應到 HOME/cache/<論文 id>/<name>（舊的搬過去），否則還在論文目錄裡。
- reader_path(paper_root)：同步模式下筆記的合併結果放快取（HOME/cache/<id>/reader.json）；論文目錄裡只留各台的日誌。
- device()：這台電腦的 id 和名字（HOME/device.json，第一次產生）。
環境變數 EASYREAD_SYNC=1/0 可以強制開關（測試用）。
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import threading
from pathlib import Path
from uuid import uuid4

from . import config

MARKER = ".easyread-sync.json"
DERIVED = ("pages", "extract", "history")
_CLOUD_HINTS = ("google drive", "googledrive", "my drive", "我的雲端硬碟", "我的云端硬盘", "onedrive", "dropbox", "icloud", "cloudstorage")  # i18n-ok 路徑關鍵字
_synced: dict[str, bool] = {}
_lock = threading.Lock()
_device: dict | None = None


def is_synced(lib_root: Path) -> bool:
    """這個文獻庫是不是放在同步資料夾裡（結果記著，不每次 stat）。"""
    key = str(lib_root)
    hit = _synced.get(key)
    if hit is not None:
        return hit
    env = os.environ.get("EASYREAD_SYNC")
    if env in ("1", "0"):
        on = env == "1"
    else:
        root = Path(lib_root)
        on = (root / MARKER).is_file()
        if not on and any(h in str(root).casefold() for h in _CLOUD_HINTS):
            on = True
            try:  # 另一台電腦開這個庫時不用再猜路徑
                (root / MARKER).write_text(json.dumps({"created": _now(), "by": device()["name"]}, ensure_ascii=False), encoding="utf-8")
            except OSError:
                pass
    _synced[key] = on
    return on


def forget() -> None:
    """文獻庫換位置了：重新判斷。"""
    _synced.clear()


def cache_dir(paper_root: Path) -> Path:
    return config.CACHE_DIR / Path(paper_root).name


def derived(paper_root: Path, name: str) -> Path:
    """pages / extract / history 放哪裡。同步模式：本機快取（論文目錄裡的舊資料第一次搬過去）；否則論文目錄。"""
    root = Path(paper_root)
    if name not in DERIVED or not is_synced(root.parent):
        return root / name
    out = cache_dir(root) / name
    legacy = root / name
    if not out.exists() and legacy.is_dir():
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(legacy), str(out))
        except OSError:
            return legacy
    return out


def reader_path(paper_root: Path) -> Path:
    """筆記的合併結果。同步模式下在快取；論文目錄裡原本的 reader.json 第一次搬過去，並把內容寫一份快照進自己的日誌給別台。"""
    root = Path(paper_root)
    if not is_synced(root.parent):
        return root / "reader.json"
    out = cache_dir(root) / "reader.json"
    legacy = root / "reader.json"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return legacy
    if not out.exists() and legacy.is_file():
        try:
            data = json.loads(legacy.read_text(encoding="utf-8"))
            sync_append(root, [{"op": "snapshot", "reader": data, "at": _now()}])
            shutil.move(str(legacy), str(out))
        except (OSError, ValueError):
            return legacy
    return out


def sync_dir(paper_root: Path) -> Path:
    return Path(paper_root) / "sync"


def sync_append(paper_root: Path, ops: list[dict]) -> None:
    """把這批操作寫進這台電腦自己的日誌（一個檔只有一台在寫，雲端硬碟不會產生衝突副本）。
    Windows 上雲端硬碟的同步程式正在讀這個檔時會開不了（PermissionError）：等一下再試，不要把這批操作丟掉。"""
    import time
    d = sync_dir(paper_root)
    d.mkdir(exist_ok=True)
    line = json.dumps({"t": _now(), "ops": ops}, ensure_ascii=False)
    with _lock:
        for attempt in range(40):
            try:
                with open(d / f"{device()['id']}.jsonl", "a", encoding="utf-8", newline="\n") as f:
                    f.write(line + "\n")
                return
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.05 * (attempt + 1))


def lock_dir(paper_root: Path) -> Path:
    """寫入鎖放哪裡。同步模式下放本機快取：鎖只管這台電腦上的行程互斥，放進雲端硬碟只會讓它一直忙著同步一個馬上就刪掉的檔。"""
    root = Path(paper_root)
    if not is_synced(root.parent):
        return root
    out = cache_dir(root)
    try:
        out.mkdir(parents=True, exist_ok=True)
    except OSError:
        return root
    return out


def device() -> dict:
    """{"id", "name"}：第一次產生，之後都一樣（HOME/device.json）。"""
    global _device
    if _device:
        return _device
    path = config.HOME / "device.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("id"):
            _device = {"id": str(data["id"]), "name": str(data.get("name") or socket.gethostname())}
            return _device
    except (OSError, ValueError):
        pass
    _device = {"id": uuid4().hex[:12], "name": socket.gethostname().split(".")[0] or "this-device"}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(_device, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return _device


def _now() -> str:
    from .store import now_iso
    return now_iso()
