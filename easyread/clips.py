"""讀者拿給模型看的圖片，都放在這份文件目錄的 clips/：

- region()：在原 PDF 上框選的一塊（圖、表、公式、選不到字的投影片），從 PDF 重新渲染，小字也看得清。
- save_upload()：貼進「問 AI」輸入框的圖片。

檔名用內容（或頁碼＋範圍）的雜湊：同一張圖只存一份，重問不會越存越多。
"""
from __future__ import annotations

import hashlib
import math
from contextlib import closing
from pathlib import Path

from . import pdfwork
from .i18n import tr

DIR = "clips"
MAX_BYTES = 12 * 1024 * 1024   # 貼進來的圖片最大多少
MAX_SIDE = 1800                # 框選區域渲染出來的長邊像素上限
MAX_PIXELS = 16_000_000        # 整頁渲染的像素上限（區域很小時不要把整頁放得太大）
MAX_IMAGES = 6                 # 一次提問最多帶幾張

_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"))
MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}


def _kind(data: bytes) -> str | None:
    for magic, ext in _MAGIC:
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def save_upload(root: Path, data: bytes) -> str:
    """存一張貼進來的圖片，回傳相對路徑（clips/u-….png）。只認 png / jpg / gif / webp 的檔頭。"""
    if not data:
        raise ValueError(tr("圖片是空的"))
    if len(data) > MAX_BYTES:
        raise ValueError(tr("圖片太大（最多 {n} MB）", n=MAX_BYTES // 1024 // 1024))
    ext = _kind(data)
    if not ext:
        raise ValueError(tr("只能貼 PNG、JPEG、GIF、WebP 圖片"))
    out = Path(root) / DIR / f"u-{hashlib.sha256(data).hexdigest()[:16]}.{ext}"
    if not out.exists():
        out.parent.mkdir(exist_ok=True)
        out.write_bytes(data)
    return f"{DIR}/{out.name}"


def _rect(rect) -> tuple[float, float, float, float]:
    try:
        x0, y0, x1, y1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError(tr("框選範圍不對"))
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        raise ValueError(tr("框選範圍不對"))
    x0, x1 = sorted((min(1.0, max(0.0, x0)), min(1.0, max(0.0, x1))))
    y0, y1 = sorted((min(1.0, max(0.0, y0)), min(1.0, max(0.0, y1))))
    if x1 - x0 < 0.004 or y1 - y0 < 0.004:
        raise ValueError(tr("框選範圍太小"))
    return x0, y0, x1, y1


def region(root: Path, page, rect) -> str:
    """原 PDF 第 page 頁上的一塊（rect 是按頁寬高歸一化的 [x0, y0, x1, y1]）渲染成 PNG，回傳相對路徑。"""
    root = Path(root)
    pdf = root / "source.pdf"
    try:
        page = int(page)
    except (TypeError, ValueError):
        raise ValueError(tr("沒有這一頁"))
    x0, y0, x1, y1 = _rect(rect)
    if not pdf.exists():
        raise ValueError(tr("找不到原 PDF"))
    key = hashlib.md5(f"{page}:{x0:.4f},{y0:.4f},{x1:.4f},{y1:.4f}".encode()).hexdigest()[:12]
    out = root / DIR / f"c-p{page}-{key}.png"
    if out.exists():
        return f"{DIR}/{out.name}"
    with pdfwork.open_pdf(pdf) as doc:
        if not 1 <= page <= len(doc):
            raise ValueError(tr("沒有這一頁"))
        with closing(doc[page - 1]) as pdf_page:
            w, h = pdf_page.get_size()
            long_side = max((x1 - x0) * w, (y1 - y0) * h, 1.0)
            scale = max(1.0, min(6.0, MAX_SIDE / long_side, math.sqrt(MAX_PIXELS / max(w * h, 1.0))))
            with closing(pdf_page.render(scale=scale)) as bitmap, bitmap.to_pil() as raw, raw.convert("RGB") as img:
                W, H = img.size
                with img.crop((int(x0 * W), int(y0 * H), max(int(x0 * W) + 1, int(math.ceil(x1 * W))), max(int(y0 * H) + 1, int(math.ceil(y1 * H))))) as part:
                    out.parent.mkdir(exist_ok=True)
                    part.save(out, "PNG", optimize=True)
    return f"{DIR}/{out.name}"


def rel(path: Path) -> str:
    return f"{DIR}/{Path(path).name}"


def resolve(root: Path, names) -> list[Path]:
    """對話請求裡帶的圖片名 → 實際檔案。只認 clips/ 底下存在的圖片，其餘丟掉（不讓請求指到別的檔案）。"""
    out: list[Path] = []
    base = (Path(root) / DIR).resolve()
    for name in (names if isinstance(names, list) else [])[:MAX_IMAGES]:
        if not isinstance(name, str):
            continue
        p = (base / Path(name).name).resolve()
        if p.is_relative_to(base) and p.is_file() and p.suffix.lstrip(".").lower() in MIME and p not in out:
            out.append(p)
    return out


def data_url(path: Path) -> str:
    import base64
    mime = MIME.get(Path(path).suffix.lstrip(".").lower(), "image/jpeg")
    return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()
