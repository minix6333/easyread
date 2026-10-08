"""補充資料：一份文件另外附的 PDF（論文的 supplementary、另外下載的附錄、講義的習題解答…）。

- 檔案放在論文資料夾的 supp/ 底下，跟著論文一起同步；清單就是那個資料夾裡的 PDF（照檔名排，依序叫 S1、S2…），不另外記索引。
- 抽出的文字是可重算的，放在 extract/supp/<檔名>/ 底下（同步模式在本機快取，見 paths.py），沒有就從 PDF 重抽。
- 問 AI、預讀（preread.py）時和本文一起給模型（docmap.py）。
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

from . import paths, pdfwork
from .i18n import tr
from .log import log

DIR = "supp"
MAX_FILES = 8
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_lock = threading.Lock()


def folder(root: Path) -> Path:
    return Path(root) / DIR


def files(root: Path) -> list[Path]:
    d = folder(root)
    if not d.is_dir():
        return []
    return sorted((p for p in d.iterdir() if p.is_file() and p.suffix.lower() == ".pdf" and not p.name.startswith(".")), key=lambda p: p.name.lower())


def _text_dir(root: Path, pdf: Path) -> Path:
    return paths.derived(Path(root), "extract") / DIR / pdf.stem


def _pages(root: Path, pdf: Path) -> list[str]:
    """這份補充資料每頁的文字；快取沒有（另一台電腦加的、快取清過）就重抽。"""
    out = _text_dir(root, pdf)
    stamp = out / ".size"
    size = str(pdf.stat().st_size)
    with _lock:
        if not stamp.exists() or stamp.read_text(encoding="utf-8", errors="replace").strip() != size:
            try:
                pdfwork.extract_text(pdf, out)
                stamp.write_text(size, encoding="utf-8")
            except Exception:  # noqa: BLE001 壞掉的 PDF：當成沒有文字，不擋住問答
                log.exception("補充資料抽不出文字 %s", pdf)  # i18n-ok 終端機記錄
                return []
    texts = []
    for p in sorted(out.glob("page-*.txt")):
        try:
            texts.append(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            texts.append("")
    return texts


def texts(root: Path) -> list[dict]:
    """[{key: "S1", file, name, pages: [每頁文字]}]"""
    return [{"key": f"S{i}", "file": p.name, "name": p.stem, "pages": _pages(root, p)} for i, p in enumerate(files(root), 1)]


def listing(root: Path) -> list[dict]:
    out = []
    for t in texts(root):
        out.append({"key": t["key"], "file": t["file"], "name": t["name"], "pages": len(t["pages"]), "chars": sum(len(x) for x in t["pages"])})
    return out


def stamp(root: Path) -> str:
    """補充資料有沒有變（預讀用來判斷筆記是不是舊的）。"""
    return "|".join(f"{p.name}:{p.stat().st_size}" for p in files(root))


def add(root: Path, data: bytes, filename: str) -> dict:
    if not data.startswith(b"%PDF"):
        raise ValueError(tr("補充資料只能是 PDF 檔"))
    have = files(root)
    if len(have) >= MAX_FILES:
        raise ValueError(tr("一份文件最多附 {n} 個補充資料", n=MAX_FILES))
    stem = _BAD.sub(" ", Path(str(filename or "")).name).strip().strip(".")
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4].strip()
    stem = (" ".join(stem.split()) or "supplementary")[:80]
    d = folder(root)
    d.mkdir(parents=True, exist_ok=True)
    name, n = stem + ".pdf", 1
    while (d / name).exists():
        if (d / name).read_bytes() == data:  # 同一個檔再加一次：不重複放
            return {"file": name, "new": False}
        n += 1
        name = f"{stem} ({n}).pdf"
    (d / name).write_bytes(data)
    return {"file": name, "new": True}


def remove(root: Path, filename: str) -> bool:
    target = next((p for p in files(root) if p.name == filename), None)
    if not target:
        return False
    cache = _text_dir(root, target)
    target.unlink()
    if cache.is_dir():
        for p in cache.iterdir():
            try:
                p.unlink()
            except OSError:
                pass
        try:
            cache.rmdir()
        except OSError:
            pass
    return True
