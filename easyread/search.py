"""全文搜尋：在每份文件抽出來的文字（extract/page-NNN.txt）、自己在文件上寫的筆記、獨立筆記的內文裡找。
給外殼的「快速開啟」（⌘K）用：標題對不到的時候，還能找「哪一篇提過這個詞」。

不建索引。一份文獻庫幾十到幾百份文件、每頁幾 KB 的文字，整個掃一遍只要幾十毫秒；
讀過的內容記在記憶體裡（照資料夾／檔案的修改時間對），第二次搜尋就不碰硬碟。
只找這台已經有的文字——同步模式下別台匯入、這台還沒開過的文件沒有抽取文字，這裡不會為了搜尋去重抽（那要好幾秒）。
回傳的只有文件的 id：標題、圖示這些清單上本來就有，前端自己對。
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path

from . import notes, paths
from .store import read_json

_CJK = "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"  # 日文假名、中日韓的字  # i18n-ok
_HYPHEN = re.compile(r"(?<=[A-Za-z])-[ \t]*\n\s*(?=[a-z])")         # 行尾的連字號：fine-⏎tuning → finetuning
_JOIN = re.compile(rf"(?<=[{_CJK}])\s+(?=[{_CJK}])")                # 中日文之間的換行、空白：「機器⏎學習」→「機器學習」
_WS = re.compile(r"\s+")
_MD_LINE = re.compile(r"(?m)^[ \t]{0,8}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)")  # 行首的 Markdown 記號（標題、引用、清單、待辦）
_MD_INLINE = re.compile(r"\*\*|__|==|~~|`")
_PAGE = re.compile(r"page-(\d+)\.txt$")
MAX_DOCS, MAX_HITS, AROUND = 12, 3, (34, 64)

_lock = threading.Lock()
_pages: dict[str, tuple[tuple, list[tuple[int, str, str]]]] = {}    # 文件資料夾 → （修改記號, [(頁, 顯示用的字, 比對用的字)]）
_files: dict[str, tuple[tuple, object]] = {}                        # 單一檔案（筆記）→ （修改記號, 內容）


def squash(text: str) -> str:
    """把抽出來的文字理成一行一行接好的樣子（搜尋和摘要都用這個）。"""
    return _WS.sub(" ", _JOIN.sub("", _HYPHEN.sub("", text or ""))).strip()


def plain(md: str) -> str:
    """筆記的 Markdown 去掉記號（摘要裡不要出現 ##、- [ ]、**）。"""
    return squash(_MD_INLINE.sub("", _MD_LINE.sub("", md or "")))


def _fold(text: str) -> str:
    low = text.lower()
    return low if len(low) == len(text) else text  # 極少數字元轉小寫會變長（İ）：那就不轉，位置才對得上


def _stamp(p: Path) -> tuple:
    try:
        st = p.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return ()


def _paper_pages(root: Path) -> list[tuple[int, str, str]]:
    d = paths.derived(root, "extract")
    try:
        files = sorted(f for f in d.iterdir() if _PAGE.search(f.name))
    except OSError:
        return []
    from . import pagevision  # 整頁是圖的那幾頁：看圖讀出來的字（看了新的頁，快取就換）
    mark = (_stamp(d), len(files), _stamp(files[0]) if files else (), _stamp(files[-1]) if files else (), pagevision.stamp(root))
    with _lock:
        hit = _pages.get(str(root))
        if hit and hit[0] == mark:
            return hit[1]
    out = []
    for f in files:
        n = int(_PAGE.search(f.name).group(1))
        try:
            shown = squash(pagevision.overlay(root, n, f.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            continue
        if shown:
            out.append((n, shown, _fold(shown)))
    with _lock:
        if len(_pages) > 3000:
            _pages.clear()
        _pages[str(root)] = (mark, out)
    return out


def _cached(p: Path, load):
    mark = _stamp(p)
    if not mark:
        return None
    with _lock:
        hit = _files.get(str(p))
        if hit and hit[0] == mark:
            return hit[1]
    val = load(p)
    with _lock:
        if len(_files) > 6000:
            _files.clear()
        _files[str(p)] = (mark, val)
    return val


def _my_notes(root: Path) -> list[tuple[int | None, str, str]]:
    """自己在這份文件上寫的筆記、提問（不含畫線：畫線的字本來就在內文裡）。"""
    def load(p: Path):
        data = read_json(p, {}) or {}
        out = []
        for n in (data.get("notes") or {}).values():
            if not isinstance(n, dict) or n.get("deleted") or not str(n.get("body") or "").strip():
                continue
            shown = plain(n["body"])
            page = n.get("page")
            out.append((int(page) if isinstance(page, int) or str(page or "").isdigit() else None, shown, _fold(shown)))
        return out
    return _cached(paths.reader_path(root), load) or []


def _terms(q: str) -> tuple[str, list[str]]:
    phrase = _fold(squash(q))
    return phrase, [t for t in phrase.split(" ") if t]


def _match(folded: str, phrase: str, terms: list[str]) -> tuple[int, int, bool] | None:
    """這段文字對不對得上：整句連著出現最好；不然每個詞都要在。回傳（位置, 長度, 是不是整句）。"""
    i = folded.find(phrase)
    if i >= 0:
        return i, len(phrase), True
    if len(terms) < 2 or not all(t in folded for t in terms):
        return None
    return folded.find(terms[0]), len(terms[0]), False


def _snippet(shown: str, at: int, n: int) -> dict:
    a, b = max(0, at - AROUND[0]), min(len(shown), at + n + AROUND[1])
    if a > 0:  # 不要從一個英文字的中間開始
        sp = shown.find(" ", a, at)
        a = sp + 1 if sp >= 0 else a
    head, tail = ("…" if a > 0 else ""), ("…" if b < len(shown) else "")
    return {"snippet": head + shown[a:b] + tail, "mark": [len(head) + at - a, len(head) + at - a + n]}


def search(lib, q: str, limit: int = MAX_DOCS) -> dict:
    t0 = time.perf_counter()
    phrase, terms = _terms(q)
    if len(phrase) < 2:
        return {"q": q, "results": [], "ms": 0}
    found = []
    for ws in lib.all():
        hits, n, exact = [], 0, 0
        for page, shown, folded in _paper_pages(ws.root):
            m = _match(folded, phrase, terms)
            if not m:
                continue
            n += 1
            exact += m[2]
            if len(hits) < MAX_HITS:
                hits.append({"page": page, "where": "text", **_snippet(shown, m[0], m[1])})
        for page, shown, folded in _my_notes(ws.root):
            m = _match(folded, phrase, terms)
            if not m:
                continue
            n += 1
            exact += m[2]
            if len(hits) < MAX_HITS:
                hits.append({"page": page, "where": "note", **_snippet(shown, m[0], m[1])})
        if hits:
            found.append((exact, n, {"kind": "paper", "id": ws.id, "n": n, "hits": hits}))
    base = notes.folder(lib.root)
    if base.is_dir():
        for d in base.iterdir():
            f = d / "note.md"
            if not d.is_dir() or not (d / "note.json").is_file():
                continue
            body = _cached(f, lambda p: (lambda s: (s, _fold(s)))(plain(p.read_text(encoding="utf-8", errors="replace"))))
            if not body:
                continue
            m = _match(body[1], phrase, terms)
            if m:
                found.append((int(m[2]), 1, {"kind": "note", "id": d.name, "n": 1, "hits": [{"where": "text", **_snippet(body[0], m[0], m[1])}]}))
    found.sort(key=lambda x: (-x[0], -x[1]))
    return {"q": q, "results": [x[2] for x in found[: max(1, min(50, int(limit or MAX_DOCS)))]], "total": len(found), "ms": round((time.perf_counter() - t0) * 1000)}
