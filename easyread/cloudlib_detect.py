"""只检测有官方依据且确实存在的同步目录，不扫描磁盘猜测网盘位置。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def detect() -> list[dict]:
    found, seen = [], set()

    def add(kind, label, path):
        if not path:
            return
        p = Path(path).expanduser()
        try:
            p = p.resolve()
            if not p.is_dir() or str(p).casefold() in seen:
                return
        except OSError:
            return
        seen.add(str(p).casefold())
        found.append({"id": kind, "label": label, "root_path": str(p), "path": str(p / "EasyRead")})

    # 測試、或同步程式裝在偵測不到的地方時：EASYREAD_CLOUD_ROOTS 直接指定雲端硬碟的根目錄（多個用系統的路徑分隔符隔開）。
    # 有設就只認這些，不再自己找（測試才不會碰到這台電腦真正的雲端硬碟）。
    if os.environ.get("EASYREAD_CLOUD_ROOTS") is not None:
        for raw in os.environ["EASYREAD_CLOUD_ROOTS"].split(os.pathsep):
            if raw.strip():
                add("custom", Path(raw.strip()).name or "Cloud", raw.strip())
        return found
    # OneDrive 给出的环境变量可以覆盖用户自选的位置；未设置时不猜用户目录。
    for name in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        add("onedrive", "OneDrive", os.environ.get(name))
    home = Path.home()
    if sys.platform == "darwin":
        cloud = home / "Library" / "CloudStorage"
        if cloud.is_dir():
            for p in sorted(cloud.glob("OneDrive*")):
                if p.name.startswith(("OneDrive-", "OneDrive - ")):
                    add("onedrive", "OneDrive", p)
    if sys.platform == "win32":
        # Apple: support.apple.com/guide/icloud-windows/icw0144825a5/icloud
        for name in ("iCloudDrive", "iCloud Drive"):
            add("icloud", "iCloud Drive", home / name)

    # Google Drive 桌面版。「我的雲端硬碟」在哪裡有三種來源，全部收進來再去掉重複和包在別人裡面的：
    # 1. 雙向同步（鏡像）模式：Drive 自己記的位置（_drivefs_mirror_roots，最準）；
    # 2. macOS：~/Library/CloudStorage/GoogleDrive-<帳號>/<我的雲端硬碟 | My Drive>（串流模式是虛擬磁碟，鏡像模式是指到鏡像資料夾的連結）；
    # 3. Windows 串流模式：一個磁碟機（G:\我的雲端硬碟、G:\My Drive——名字跟著系統語言）；找不到時再猜家目錄下的預設鏡像資料夾。
    # support.google.com/drive/answer/10838124
    drive_subs = ("My Drive", "我的雲端硬碟", "我的云端硬盘", "マイドライブ")  # i18n-ok Google 自己取的資料夾名
    for root in _drivefs_mirror_roots():
        add("gdrive", "Google Drive", root)
    if sys.platform == "darwin":
        for acct in sorted((home / "Library" / "CloudStorage").glob("GoogleDrive-*")):
            for sub in drive_subs:
                add("gdrive", "Google Drive", acct / sub)
    if sys.platform == "win32":
        for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            if not os.path.exists(f"{letter}:\\"):
                continue
            for sub in drive_subs:  # 以前只認英文的 My Drive，中文 Windows 的 G:\我的雲端硬碟 找不到
                add("gdrive", "Google Drive", Path(f"{letter}:/{sub}"))
    for base in (home / "My Drive", home / "我的雲端硬碟", home / "我的云端硬盘", home / "Google Drive", home / "Google 雲端硬碟"):  # i18n-ok
        if _looks_like_drive_root(base):  # 鏡像資料夾裡有 Drive 自己的暫存夾；只是剛好叫這個名字的普通資料夾不算
            add("gdrive", "Google Drive", base)

    # 同一個雲端硬碟裡又有一個叫「我的雲端硬碟」的普通資料夾時，它不是另一個根目錄：包在別的根目錄裡面的拿掉
    roots = [Path(f["root_path"]) for f in found]
    found[:] = [f for f in found if not any(r != Path(f["root_path"]) and Path(f["root_path"]).is_relative_to(r) for r in roots)]

    # Dropbox 官方支持 info.json，包含 personal/business 两种账户。
    # help.dropbox.com/installs/locate-dropbox-folder
    infos = [home / ".dropbox" / "info.json"]
    if sys.platform == "win32":
        infos = [Path(os.environ[n]) / "Dropbox" / "info.json"
                 for n in ("APPDATA", "LOCALAPPDATA") if os.environ.get(n)]
    for info in infos:
        try:
            data = json.loads(info.read_text(encoding="utf-8"))
            for account in ("personal", "business"):
                entry = data.get(account, {})
                if isinstance(entry, dict):
                    add("dropbox", "Dropbox", entry.get("path"))
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return found


def _looks_like_drive_root(path: Path) -> bool:
    try:
        return path.is_dir() and ((path / ".tmp.driveupload").is_dir() or (path / ".tmp.drivedownload").is_dir())
    except OSError:
        return False


def _drivefs_mirror_roots() -> list[Path]:
    """Google Drive 桌面版自己記的「我的雲端硬碟」鏡像位置（雙向同步模式才有這一筆）。
    只讀它的偏好設定（root_preference_sqlite.db 的 roots 表，immutable 開啟，不鎖、不寫）；讀不到就回空，靠別的辦法找。"""
    home = Path.home()
    bases = []
    if sys.platform == "darwin":
        bases.append(home / "Library" / "Application Support" / "Google" / "DriveFS")
    elif sys.platform == "win32":
        if os.environ.get("LOCALAPPDATA"):
            bases.append(Path(os.environ["LOCALAPPDATA"]) / "Google" / "DriveFS")
    else:
        return []
    out: list[Path] = []
    for base in bases:
        db = base / "root_preference_sqlite.db"
        if not db.is_file():
            continue
        try:
            import sqlite3
            con = sqlite3.connect(db.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0.5)
            try:
                rows = con.execute("select last_seen_absolute_path, root_path from roots where is_my_drive = 1").fetchall()
            finally:
                con.close()
        except Exception:  # noqa: BLE001 —— 表結構改了、檔案被鎖：當作沒有
            continue
        for seen, rel in rows:
            raw = str(seen or "").strip()
            if raw.startswith("\\\\?\\"):  # Windows 的長路徑前綴 \\?\C:\…
                raw = raw[4:]
            if not raw and rel:
                raw = "/" + str(rel).lstrip("/\\") if sys.platform == "darwin" else str(rel)
            if raw:
                out.append(Path(raw))
    return out


def is_cloud_root(path: str | Path) -> bool:
    """這個資料夾是不是某個雲端硬碟的根目錄（文獻庫要放在它底下的 EasyRead，不是直接放在根目錄）。"""
    try:
        p = Path(path).expanduser().resolve()
    except OSError:
        return False
    return any(Path(f["root_path"]) == p for f in detect())


def target_path(value: str | Path) -> Path:
    """已有库按原路径使用，普通同步文件夹只在 EasyRead 子目录里放论文。"""
    from .i18n import tr
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise ValueError(tr("请选择文献库文件夹"))
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(tr("请输入完整的文件夹路径"))
    path = path.resolve()
    if is_cloud_root(path):  # 選到雲端硬碟的根目錄：一律用底下的 EasyRead（就算根目錄剛好叫 EasyRead、或裡面散著論文資料夾）
        return path / "EasyRead"
    if path.name.casefold() == "easyread" or (path.exists() and not path.is_dir()):
        return path
    if path.is_dir():
        # 未完成迁移也必须交给 inspect 原地检查，不能套一层目录后绕过事务标记。
        marker = path / ".easyread-migration.json"
        if marker.exists() or marker.is_symlink():
            return path
        if any(not child.name.startswith(".") and (child / "item.json").is_file()
               for child in path.iterdir()):
            return path
    return path / "EasyRead"
