"""文獻庫卡片上的封面圖。

自動的：第一頁最上面那一塊——標題、作者、摘要的開頭——裁成橫的（16:10），兩邊的白邊（連同 arXiv 印在頁邊的那一直條）去掉；
橫的頁面（投影片）就是第一頁整張。以前卡片上放的是整頁縮小：字小到只剩一片灰，卡片還得拉得很長才放得下。
自己挑的：在閱讀頁框一塊「設為封面」（item.json 的 cover: {"page": n, "box": [x0, y0, x1, y1]}，頁內座標 0–1）——
框的那一塊整個都要看得到，四周補紙的白。
做一次存在 pages/cover.webp（同步模式下在本機快取），旁邊的 cover.json 記著是照什麼做的；條件變了（換了封面、那一頁的圖重做過）才重做。
"""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path

from . import derive, paths, pdfwork
from .store import read_json, write_json_atomic

SIZE = (720, 450)  # 16:10。卡片最寬約 300 像素，兩倍密度的螢幕也夠
VERSION = 1        # 裁法改了就加一：舊的封面全部重做
_lock = threading.Lock()


def clean(spec) -> dict | None:
    """使用者挑的封面（從請求來的）整理成存得進 item.json 的樣子；不合格、或要恢復自動的回 None。"""
    if not isinstance(spec, dict):
        return None
    try:
        page = int(spec.get("page") or 0)
        box = [max(0.0, min(1.0, float(v))) for v in (spec.get("box") or [])]
    except (TypeError, ValueError):
        return None
    if page < 1 or len(box) != 4 or box[2] - box[0] < 0.03 or box[3] - box[1] < 0.02:
        return None
    return {"page": page, "box": [round(v, 4) for v in box]}


def spec_of(ws) -> dict | None:
    return clean((ws.load("item") or {}).get("cover"))


def _source(root: Path, spec: dict | None) -> Path:
    return paths.derived(root, "pages") / f"page-{(spec or {}).get('page', 1):03d}.webp"


def stamp(root: Path, spec: dict | None) -> str:
    """放在網址後面的版本：封面換了、那一頁的圖重做了就不一樣（瀏覽器才會去拿新的）。"""
    src = _source(root, spec)
    try:
        st = src.stat()
        mark = [st.st_mtime_ns, st.st_size]
    except OSError:
        mark = []
    return hashlib.sha1(json.dumps([VERSION, spec, mark], sort_keys=True).encode()).hexdigest()[:10]


def _fill(im, size):
    """把圖放大／縮小到蓋滿 size，多的從中間裁掉。"""
    from PIL import Image
    w, h = im.size
    k = max(size[0] / w, size[1] / h)
    im = im.resize((max(size[0], round(w * k)), max(size[1], round(h * k))), Image.LANCZOS)
    x, y = (im.width - size[0]) // 2, (im.height - size[1]) // 2
    return im.crop((x, y, x + size[0], y + size[1]))


def _region(im, box, size):
    """自己框的一塊：整塊都看得到，四周補白。"""
    from PIL import Image
    w, h = im.size
    part = im.crop((round(box[0] * w), round(box[1] * h), max(round(box[0] * w) + 2, round(box[2] * w)), max(round(box[1] * h) + 2, round(box[3] * h))))
    k = min(size[0] / part.width, size[1] / part.height)
    part = part.resize((max(1, round(part.width * k)), max(1, round(part.height * k))), Image.LANCZOS)
    out = Image.new("RGB", size, (255, 255, 255))
    out.paste(part, ((size[0] - part.width) // 2, (size[1] - part.height) // 2))
    return out


def _runs(values: list[int], floor: int, gap: int) -> list[tuple[int, int, int]]:
    """一排數字裡「有東西」的幾段：（開始, 結束, 總量）；中間空 gap 格以內的算同一段。"""
    out, start, last, total = [], None, None, 0
    for i, v in enumerate(values):
        if v <= floor:
            continue
        if start is None or i - last > gap:
            if start is not None:
                out.append((start, last, total))
            start, total = i, 0
        last, total = i, total + v
    if start is not None:
        out.append((start, last, total))
    return out


def _top_block(im, size):
    """直的頁面：找出內文那一欄的左右邊（頁邊單獨一直條的東西不算），從第一行字開始往下裁一塊橫的。"""
    from PIL import Image
    w, h = im.size
    sw = 240
    small = im.convert("L").resize((sw, max(8, round(sw * h / w))), Image.BILINEAR)
    sh = small.height
    ink = small.point(lambda v: 255 if v < 215 else 0)
    cols = list(ink.resize((sw, 1), Image.BOX).tobytes())  # 灰階圖一個位元組一格：每一直行平均有多少墨
    runs = _runs(cols, 1, max(2, sw // 60))
    if not runs:
        return _fill(im.crop((0, 0, w, min(h, round(w * size[1] / size[0])))), size)
    a, b, _ = max(runs, key=lambda r: r[2])
    rows = list(ink.crop((a, 0, b + 1, sh)).resize((1, sh), Image.BOX).tobytes())
    top = next((i for i, v in enumerate(rows) if v > 1), 0)
    k = w / sw
    pad = (b - a + 1) * 0.035
    x0, x1 = max(0.0, (a - pad) * k), min(float(w), (b + 1 + pad) * k)
    cw = x1 - x0
    ch = cw * size[1] / size[0]
    y0 = max(0.0, top * k - cw * 0.035)
    if y0 + ch > h:
        y0 = max(0.0, h - ch)
    return _fill(im.crop((round(x0), round(y0), round(x1), round(min(h, y0 + ch)))), size)


def render(im, spec: dict | None, size=SIZE):
    """一頁的圖 → 封面（給測試直接叫）。"""
    im = im.convert("RGB")
    if spec:
        return _region(im, spec["box"], size)
    if im.width >= im.height * 1.15:  # 橫的頁面：投影片的第一張本來就是封面
        return _fill(im, size)
    return _top_block(im, size)


def cover(root: Path, spec: dict | None = None) -> Path | None:
    """這份文件的封面檔；沒有就做。沒有 PDF、頁碼不對回 None。"""
    root = Path(root)
    src = derive.page_image(root, (spec or {}).get("page", 1))
    if not src and spec:  # 挑的那一頁沒了：退回自動的
        spec, src = None, derive.page_image(root, 1)
    if not src:
        return None
    out, meta = src.parent / "cover.webp", src.parent / "cover.json"
    key = {"stamp": stamp(root, spec)}
    if out.exists() and read_json(meta, None) == key:
        return out
    with _lock:
        if out.exists() and read_json(meta, None) == key:
            return out
        from PIL import Image
        with Image.open(src) as im:
            pdfwork.save_image(render(im, spec), out, "WEBP", quality=86, method=4)
        write_json_atomic(meta, key)
    return out
