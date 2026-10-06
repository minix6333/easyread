"""全文地圖：問 AI 時讓模型看得到整份文件，而不是只有正在看的那一頁。

- outline(ws)：每頁一行（標題、開頭一句），整份壓在 OUTLINE_BUDGET 字以內——每次提問都帶，模型知道什麼在哪一頁
- relevant(ws, question, skip, k)：問題裡的關鍵詞在哪幾頁出現最多——那幾頁的全文一起帶（不用把整本塞進去）
- full_text(ws, budget)：整份的文字（導讀用），太長就每頁截短

文字來源是每頁抽取的 extract/page-NNN.txt（paths.derived）；整理過的論文（paper.json 有 heading 塊）標題用它的。
"""
from __future__ import annotations

import math
import re
from pathlib import Path

from . import paths
from .store import Workspace

OUTLINE_BUDGET = 4500     # 全文地圖最多幾個字
PAGE_BUDGET = 3000        # 相關頁每頁最多帶幾個字
FULL_BUDGET = 90000       # 導讀：整份最多幾個字

_HEADING = re.compile(r"^(?:(?:\d+(?:\.\d+)*|[A-Z]|[IVX]+)[.)]?\s+)?[A-Z][^.!?]{2,80}$")
_NUMBERED = re.compile(r"^(?:\d+(?:\.\d+)*|[A-Z]|[IVX]+)[.)]?\s+\S")
_CAPTION = re.compile(r"^(Figure|Fig\.|Table|Algorithm)\s*\d+", re.I)
_WORD = re.compile(r"[A-Za-z][A-Za-z\-]{2,}|\d{2,}")
_CJK = re.compile(r"[一-鿿]")  # i18n-ok
_STOP = set("""the and for with this that from are was were been being have has had not but can could would should may might will shall
what which who whom whose when where why how does did done doing into onto over under than then there their them they these those
also only very more most much many some such each both either neither all any few own same other another about above after again against
between through during before because while until since within without here out off per via one two three four five six seven eight nine
ten first second third paper page section figure table equation mean means meaning explain example show shows shown use used using
""".split())
_STOP_ZH = ("什麼", "什么", "這個", "这个", "這裡", "这里", "這段", "这段", "這句", "这句", "為什麼", "为什么", "怎麼", "怎么", "請", "请",  # i18n-ok
            "一下", "說明", "说明", "解釋", "解释", "意思", "可以", "是不是", "有沒有", "有没有", "哪裡", "哪里", "如何", "我們", "我们", "他們", "他们")  # i18n-ok


def page_texts(ws: Workspace) -> list[str]:
    """第 1 頁到最後一頁的抽取文字（沒抽到的是空字串）。"""
    meta = ws.load("paper").get("meta") or {}
    extract = paths.derived(ws.root, "extract")
    total = int(meta.get("page_count") or 0)
    if not total and extract.is_dir():
        total = len([p for p in extract.glob("page-*.txt")])
    out = []
    for n in range(1, total + 1):
        p: Path = extract / f"page-{n:03d}.txt"
        try:
            out.append(p.read_text(encoding="utf-8", errors="replace") if p.exists() else "")
        except OSError:
            out.append("")
    return out


def _lines(text: str) -> list[str]:
    return [" ".join(l.split()) for l in text.splitlines() if l.strip()]


def _headings(lines: list[str]) -> list[str]:
    """看起來像標題的行：編號開頭、或短短一行大寫開頭沒句點。"""
    out = []
    for l in lines[:14]:
        if len(l) > 90 or _CAPTION.match(l):
            continue
        if _NUMBERED.match(l) and len(l) < 70:
            out.append(l)
        elif _HEADING.match(l) and len(l.split()) <= 10 and not l.endswith((",", ";")):
            out.append(l)
        if len(out) >= 2:
            break
    return out


def _block_headings(ws: Workspace) -> dict[int, list[str]]:
    by_page: dict[int, list[str]] = {}
    for b in ws.load("paper").get("blocks", []) or []:
        if b.get("type") != "heading" or not b.get("page"):
            continue
        title = " ".join(str(b.get("zh") or b.get("en") or "").split())
        if not title:
            continue
        num = str(b.get("num") or "").strip()
        by_page.setdefault(int(b["page"]), []).append((num + " " if num and not title.startswith(num) else "") + title)
    return by_page


def outline(ws: Workspace) -> str:
    """每頁一行：p3: 2 Related Works ｜ Many recent works have investigated…"""
    pages = page_texts(ws)
    if not any(pages):
        return ""
    known = _block_headings(ws)
    per = max(70, OUTLINE_BUDGET // max(1, len(pages)))
    rows = []
    for i, text in enumerate(pages, 1):
        lines = _lines(text)
        if not lines:
            continue
        heads = known.get(i) or _headings(lines)
        lead = next((l for l in lines if l not in heads and not _CAPTION.match(l) and len(l) >= 40), lines[0] if lines[0] not in heads else "")
        cap = next((l for l in lines if _CAPTION.match(l)), "")
        row = f"p{i}: " + (" / ".join(heads[:2]) + (" ｜ " if heads and lead else "") if heads else "") + lead[:90]  # i18n-ok
        if cap:
            row += "（" + cap[:50] + "）"  # i18n-ok
        rows.append(row[:per])
    return "\n".join(rows)


def _tokens(ws: Workspace, question: str, doc_has_cjk: bool) -> list[str]:
    q = question or ""
    toks = {w.lower() for w in _WORD.findall(q)} - _STOP
    # 問題是中文、文件是英文：用術語表把中文詞換成英文詞
    for g in ws.load("paper").get("glossary", []) or []:
        zh, en = str(g.get("zh") or ""), str(g.get("en") or "")
        if zh and en and zh in q:
            toks |= {w.lower() for w in _WORD.findall(en)} - _STOP
    if doc_has_cjk:  # 中文文件：問題裡的中文拆成兩字詞
        s = q
        for w in _STOP_ZH:
            s = s.replace(w, " ")
        for run in re.findall(r"[一-鿿]{2,}", s):  # i18n-ok
            toks |= {run[i:i + 2] for i in range(len(run) - 1)}
    return sorted(toks)


def relevant(ws: Workspace, question: str, skip=(), k: int = 2) -> list[int]:
    """問題可能在問哪幾頁（關鍵詞出現最多的；每頁都有的詞不算）。回傳頁碼，最相關的在前。"""
    pages = page_texts(ws)
    n = len(pages)
    if not n or not question:
        return []
    toks = _tokens(ws, question, any(_CJK.search(p) for p in pages[:3]))
    if not toks:
        return []
    low = [p.lower() for p in pages]
    scores = []
    for i, text in enumerate(low, 1):
        if i in set(skip) or not text:
            continue
        s = 0.0
        for t in toks:
            c = text.count(t)
            if not c:
                continue
            df = sum(1 for p in low if t in p)
            if df >= n and n > 2:
                continue
            s += (1 + math.log(min(c, 8))) * math.log(1 + n / (1 + df))
        if s > 0:
            scores.append((-s, i))
    scores.sort()
    return [i for _, i in scores[:k]]


def pages_block(ws: Workspace, nums: list[int], per: int = PAGE_BUDGET) -> str:
    pages = page_texts(ws)
    parts = []
    for n in nums:
        if 1 <= n <= len(pages) and pages[n - 1].strip():
            parts.append(f"[第 {n} 页]\n" + pages[n - 1][:per])  # i18n-ok 提示詞
    return "\n\n".join(parts)


def full_text(ws: Workspace, budget: int = FULL_BUDGET) -> str:
    """整份的文字，按頁；太長就每頁截短（開頭保留多一點）。"""
    pages = page_texts(ws)
    have = [(i, p) for i, p in enumerate(pages, 1) if p.strip()]
    if not have:
        return ""
    total = sum(len(p) for _, p in have)
    per = None if total <= budget else max(500, budget // len(have))
    parts = []
    for i, p in have:
        t = p if per is None or len(p) <= per else p[:per] + "\n…（本页后面省略）"  # i18n-ok
        parts.append(f"[第 {i} 页]\n{t}")  # i18n-ok
    return "\n\n".join(parts)
