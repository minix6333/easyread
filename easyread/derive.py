"""可重算的檔案（原頁圖、抽取文字）缺了就從 source.pdf 重做。

同步模式下它們放在本機快取、不進雲端硬碟（paths.py）：另一台電腦匯入的論文，這台的快取是空的。
以前只有匯入那一刻會做，所以別台匯入的論文在這台打開是整頁空白、沒有文字層，問 AI 也拿不到這一頁的文字。
現在：
- extract(root)：整份的抽取文字缺了就重抽一次（幾十頁通常不到一秒）。
- page_image(root, n)：第 n 頁的原頁圖缺了就渲染這一頁（和匯入時同樣 2.4 倍、WEBP）。
- ensure(root, gate)：打開論文時叫——文字先備好，頁面圖在背景一頁一頁做（讀者正在看的那頁由 page_image 插隊先做）。
不在同步模式也適用（快取被清掉、資料夾是從別處複製來的）。
"""
from __future__ import annotations

import re
import threading
from contextlib import closing
from pathlib import Path

from . import paths, pdfwork
from .log import log

_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_warming: set[str] = set()
_text_ok: set[str] = set()  # 這次執行期間確認過文字齊全的論文（不用每次再讀 paper.json 數頁數）
_PAGE = re.compile(r"page-(\d{3})\.")


def _lock(root: Path) -> threading.Lock:
    with _guard:
        return _locks.setdefault(str(root), threading.Lock())


def page_count(root: Path) -> int:
    """paper.json 記的頁數（沒有就 0，不為了這個去開 PDF）。"""
    from .store import read_json
    try:
        meta = (read_json(Path(root) / "paper.json", {}) or {}).get("meta") or {}
    except (OSError, ValueError):
        return 0
    return int(meta.get("page_count") or len(meta.get("pages") or []) or 0)


def extract(root: Path) -> Path:
    """抽取文字的目錄；第一頁或最後一頁的文字不在就整份重抽。回傳目錄（重抽失敗時可能還是空的）。"""
    root = Path(root)
    out = paths.derived(root, "extract")
    if str(root) in _text_ok:
        return out
    total = page_count(root)
    if (out / "page-001.txt").exists() and (not total or (out / f"page-{total:03d}.txt").exists()):
        _text_ok.add(str(root))
        return out
    pdf = root / "source.pdf"
    if not pdf.exists():
        return out
    with _lock(root):
        if (out / "page-001.txt").exists() and (not total or (out / f"page-{total:03d}.txt").exists()):
            return out
        try:
            n = pdfwork.extract_text(pdf, out)
            _text_ok.add(str(root))
            log.info("這台沒有 %s 的抽取文字，已從 PDF 重做（%d 頁）", root.name, n)  # i18n-ok 終端機記錄
        except Exception:  # noqa: BLE001
            log.exception("重抽文字失敗 %s", root)
    return out


def page_image(root: Path, n: int) -> Path | None:
    """第 n 頁的原頁圖；沒有就渲染這一頁。沒有 PDF 或頁碼不對回 None。"""
    root = Path(root)
    out = paths.derived(root, "pages") / f"page-{n:03d}.webp"
    if out.exists():
        return out
    pdf = root / "source.pdf"
    if n < 1 or not pdf.exists():
        return None
    with _lock(root):
        if out.exists():
            return out
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            with pdfwork.open_pdf(pdf) as doc:
                if n > len(doc):
                    return None
                with closing(doc[n - 1]) as page, closing(page.render(scale=2.4)) as bitmap:
                    with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                        tmp = out.with_name(out.name + ".part")
                        img.save(tmp, "WEBP", quality=84, method=4)
                        tmp.replace(out)
        except Exception:  # noqa: BLE001
            log.exception("重做第 %s 頁的圖失敗 %s", n, root)
            return None
    return out


def page_of(rel: str) -> int:
    """'pages/page-007.webp' → 7；不是頁面圖回 0。"""
    m = _PAGE.search(rel.rsplit("/", 1)[-1])
    return int(m.group(1)) if m else 0


def missing(root: Path) -> bool:
    """這台缺這篇的頁面圖或文字（很便宜：只看頭尾兩個檔）。"""
    root = Path(root)
    total = page_count(root)
    if not total or not (root / "source.pdf").exists():
        return False
    pages, ext = paths.derived(root, "pages"), paths.derived(root, "extract")
    return not ((pages / "page-001.webp").exists() and (pages / f"page-{total:03d}.webp").exists()
                and (ext / "page-001.txt").exists() and (ext / f"page-{total:03d}.txt").exists())


def ensure(root: Path, gate=None) -> bool:
    """打開論文時叫。缺東西就：文字馬上抽（問 AI、選字都靠它），頁面圖在背景一頁一頁做。回傳有沒有動手。"""
    root = Path(root)
    if not missing(root):
        return False
    extract(root)
    key = str(root)
    with _guard:
        if key in _warming:
            return True
        _warming.add(key)
    if gate:
        gate.begin()  # 參與「文獻庫搬家」的在途計數，搬的時候不會做到一半

    def run():
        try:
            for n in range(1, page_count(root) + 1):
                page_image(root, n)  # 每頁各自拿鎖，讀者正在看的那一頁可以插隊
        finally:
            with _guard:
                _warming.discard(key)
            if gate:
                gate.end()
    try:
        threading.Thread(target=run, daemon=True, name="derive").start()
    except Exception:
        with _guard:
            _warming.discard(key)
        if gate:
            gate.end()
        raise
    return True
