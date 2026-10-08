"""全文地圖：問 AI 時讓模型看得到整份文件，而不是只有正在看的那一頁。

- outline(ws)：每頁一行（標題、開頭一句），整份壓在 OUTLINE_BUDGET 字以內——每次提問都帶，模型知道什麼在哪一頁
- relevant(ws, question, skip, k)：問題裡的關鍵詞在哪幾頁出現最多——那幾頁的全文一起帶（不用把整本塞進去）
- full_text(ws, budget)：整份的文字（本文＋補充資料），太長就每頁截短
- size(ws)：整份有多少字；不超過門檻時每一問都把整份帶上（chat.py）
- nearby(ws, question, skip, k)：放不下整份時，問題最相關的幾頁（本文和補充資料一起找）

文字來源是每頁抽取的 extract/page-NNN.txt（paths.derived）；整理過的論文（paper.json 有 heading 塊）標題用它的。
補充資料（supp.py）接在本文後面，頁碼寫成「補充資料 S1 第 n 頁」。
"""
from __future__ import annotations

import math
import re
from pathlib import Path

from . import paths, supp
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
    from . import derive  # 這台沒有這篇的抽取文字（另一台匯入的）就先重做
    extract = derive.extract(ws.root)
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
    for sp in supp.texts(ws.root):  # 補充資料：每份一行開頭，再每頁一行
        rows.append(f"补充资料 {sp['key']}：{sp['name'][:60]}（{len(sp['pages'])} 页）")  # i18n-ok 提示詞
        for i, text in enumerate(sp["pages"], 1):
            lines = _lines(text)
            if lines:
                rows.append((f"{sp['key']}-p{i}: " + " / ".join(_headings(lines)[:1] + [next((l for l in lines if len(l) >= 40), lines[0])[:80]]))[:per])
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


def _rank(texts: list[str], toks: list[str], skip=()) -> list[tuple[float, int]]:
    """每段文字對這些關鍵詞的分數（每段都有的詞不算）。回傳 [(-分數, 第幾段)]，最相關的在前。"""
    n = len(texts)
    low = [t.lower() for t in texts]
    df = {t: sum(1 for p in low if t in p) for t in toks}
    scores = []
    for i, text in enumerate(low):
        if i in skip or not text:
            continue
        s = 0.0
        for t in toks:
            c = text.count(t)
            if not c or (df[t] >= n and n > 2):
                continue
            s += (1 + math.log(min(c, 8))) * math.log(1 + n / (1 + df[t]))
        if s > 0:
            scores.append((-s, i))
    scores.sort()
    return scores


def relevant(ws: Workspace, question: str, skip=(), k: int = 2) -> list[int]:
    """問題可能在問本文的哪幾頁（關鍵詞出現最多的；每頁都有的詞不算）。回傳頁碼，最相關的在前。"""
    pages = page_texts(ws)
    if not pages or not question:
        return []
    toks = _tokens(ws, question, any(_CJK.search(p) for p in pages[:3]))
    if not toks:
        return []
    return [i + 1 for _, i in _rank(pages, toks, {int(x) - 1 for x in skip if x})[:k]]


def units(ws: Workspace) -> list[dict]:
    """整份文件一頁一頁：本文在前、補充資料在後。{label, page（本文頁碼，補充資料是 0）, text}"""
    out = [{"label": f"第 {i} 页", "page": i, "text": t} for i, t in enumerate(page_texts(ws), 1)]  # i18n-ok 提示詞
    for s in supp.texts(ws.root):
        for i, t in enumerate(s["pages"], 1):
            out.append({"label": f"补充资料 {s['key']}（{s['name'][:40]}）第 {i} 页", "page": 0, "text": t})  # i18n-ok
    return out


def size(ws: Workspace) -> int:
    return sum(len(u["text"]) for u in units(ws))


def nearby(ws: Workspace, question: str, skip=(), k: int = 3, per: int = PAGE_BUDGET) -> str:
    """整份放不進一次提問時：問題最相關的幾頁全文（本文和補充資料一起找）。skip：已經帶上的本文頁碼。"""
    us = units(ws)
    if not us or not question:
        return ""
    toks = _tokens(ws, question, any(_CJK.search(u["text"]) for u in us[:3]))
    if not toks:
        return ""
    skip_idx = {i for i, u in enumerate(us) if u["page"] and u["page"] in set(skip)}
    picked = sorted(i for _, i in _rank([u["text"] for u in us], toks, skip_idx)[:k])
    return "\n\n".join(f"[{us[i]['label']}]\n" + us[i]["text"][:per] for i in picked if us[i]["text"].strip())


def pages_block(ws: Workspace, nums: list[int], per: int = PAGE_BUDGET) -> str:
    pages = page_texts(ws)
    parts = []
    for n in nums:
        if 1 <= n <= len(pages) and pages[n - 1].strip():
            parts.append(f"[第 {n} 页]\n" + pages[n - 1][:per])  # i18n-ok 提示詞
    return "\n\n".join(parts)


def full_text(ws: Workspace, budget: int = FULL_BUDGET) -> str:
    """整份的文字（本文，再接補充資料），按頁；太長就每頁截短（開頭保留多一點）。"""
    have = [u for u in units(ws) if u["text"].strip()]
    if not have:
        return ""
    total = sum(len(u["text"]) for u in have)
    per = None if total <= budget else max(500, budget // len(have))
    parts = []
    for u in have:
        p = u["text"]
        t = p if per is None or len(p) <= per else p[:per] + "\n…（本页后面省略）"  # i18n-ok
        parts.append(f"[{u['label']}]\n{t}")
    return "\n\n".join(parts)
