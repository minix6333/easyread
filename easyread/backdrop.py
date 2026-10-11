"""整個視窗後面的那張背景圖（設定 → 外觀 → 背景 → 自選圖片）。

瀏覽器那邊先把圖縮好——一張大的給畫布，一張很小的給旁邊的材質（放大就是糊的）——用 data URL 送過來；
這裡只驗一下、存在偏好檔旁邊，之後照原樣給回去。只收 JPEG（瀏覽器端一律轉成 JPEG 再送）。
"""
from __future__ import annotations

import base64
import binascii
import time
from pathlib import Path

from . import prefs
from .i18n import tr
from .store import write_bytes_atomic

MAX_FULL = 12 * 1024 * 1024
MAX_SMALL = 512 * 1024
PREFIX = "data:image/jpeg;base64,"
NAMES = {"full": "backdrop.jpg", "small": "backdrop-s.jpg"}


def _dir() -> Path:
    return prefs.path().parent  # 和偏好放在一起；測試用的臨時文獻庫各自一份


def path(which: str) -> Path | None:
    name = NAMES.get(which)
    p = _dir() / name if name else None
    return p if p and p.is_file() else None


def _decode(data, limit: int) -> bytes:
    if not isinstance(data, str) or not data.startswith(PREFIX):
        raise ValueError(tr("背景圖要是 JPEG"))
    try:
        raw = base64.b64decode(data[len(PREFIX):], validate=True)
    except (binascii.Error, ValueError):
        raise ValueError(tr("背景圖讀不出來")) from None
    if not raw.startswith(b"\xff\xd8\xff"):
        raise ValueError(tr("背景圖要是 JPEG"))
    if len(raw) > limit:
        raise ValueError(tr("背景圖太大"))
    return raw


def save(body: dict) -> dict:
    """存一張新的背景圖；回傳的 v 給網址帶著，瀏覽器才知道換了（圖是照快取給的）。"""
    body = body if isinstance(body, dict) else {}
    full = _decode(body.get("image"), MAX_FULL)
    small = _decode(body.get("small"), MAX_SMALL)
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    for name, raw in ((NAMES["full"], full), (NAMES["small"], small)):
        write_bytes_atomic(d / name, raw)
    return {"ok": True, "v": int(time.time())}
