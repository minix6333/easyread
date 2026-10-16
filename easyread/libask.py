"""問 AI 問整個文獻庫（或一個分類、挑的幾篇）：一題要看很多份文件時，挑出要給模型看的東西、出處怎麼標、怎麼變成連結。

範圍（前端送來的 scope，存在對話上）：
- {"kind": "all"}：整個文獻庫
- {"kind": "tag", "tag": "Paper"}：一個分類
- {"kind": "docs", "ids": [...]}：挑的幾篇
目前開著的這份一定在裡面，代號 D1；其餘照最近打開的排成 D2、D3…（最多 MAX_DOCS 份）。

給模型的：
1. 一份一行的總覽：代號、作者和年份、標題、在講什麼（AI 預讀筆記的開頭，沒有就用摘要）。
2. 問題的關鍵詞（英文詞；中文詞用各份的術語表換成英文；中文的兩字詞拿去比預讀筆記——筆記是中文寫的）
   對每份的每一頁、每份的預讀筆記打分：最相關的幾份帶整份預讀筆記（短、而且分段寫了頁碼），
   再跨文件挑分數最高的幾頁原文（每份最多幾頁、總字數有上限）。
3. 回答裡的出處寫〔D3 p.5〕；存之前換成連結 [Karan 2026 · p.5](/read/<id>#page=5)，點了在旁邊打開那一頁。
讀的檔案都有快取（抽取文字用 search.py 的快取；每份的卡片照 paper.json／item.json／brief.json 的修改時間），
文獻庫放在雲端硬碟上時，一題不用把幾十份重讀一遍。
"""
from __future__ import annotations

import re
import threading

from . import docmap, preread, search
from .store import Workspace, read_json

MAX_DOCS = 80
LEAD = 240          # 總覽裡每份「在講什麼」最多幾個字
BRIEF_DOCS = 4      # 帶整份預讀筆記的份數（含 D1）
BRIEF_PER = 5200
PAGE_PER = 2400
PAGES_PER_DOC = 3
PAGES_TOTAL = 40000  # 原文頁的總字數（Claude／Codex；按量計費的 API 一半）

_lock = threading.Lock()
_cards: dict[str, tuple[tuple, dict]] = {}
_ID = re.compile(r"[0-9a-f]{6,40}")
# 〔D3 p.5〕〔D3 第 5 頁〕〔D3 p.5–7〕〔D3 p.5, p.9〕〔D3〕；模型偶爾用半形方括號
_CITE = re.compile(r"[〔\[]\s*(D\d{1,3})((?:\s*[,，、;；]?\s*(?:p\.?|pp\.?|第)\s*\d{1,4}(?:\s*[-–~～]\s*\d{1,4})?\s*頁?)*)\s*[〕\]]")  # i18n-ok
_PAGE = re.compile(r"(\d{1,4})(?:\s*[-–~～]\s*(\d{1,4}))?")  # i18n-ok


def parse(scope) -> dict | None:
    """前端送來的範圍；不是範圍（就問這份文件）回 None。"""
    if not isinstance(scope, dict):
        return None
    kind = scope.get("kind")
    if kind == "all":
        return {"kind": "all"}
    if kind == "tag" and str(scope.get("tag") or "").strip():
        return {"kind": "tag", "tag": str(scope["tag"]).strip()[:80]}
    if kind == "docs":
        ids = [str(x) for x in (scope.get("ids") or []) if _ID.fullmatch(str(x))][:MAX_DOCS]
        if ids:
            return {"kind": "docs", "ids": ids}
    return None


def _year(meta: dict) -> str:
    m = re.search(r"(19|20)\d\d", str(meta.get("year") or meta.get("date") or ""))
    return m.group(0) if m else ""


_JUNK = re.compile(r"^(microsoft (powerpoint|word)|powerpoint presentation|untitled)\s*[-–:]?\s*|\s*[-–]\s*copy$|\.(pptx?|docx?|pdf)$", re.I)


def _who(meta: dict) -> str:
    """出處連結上的名字：第一作者的姓＋年份（Karan 2026）；沒有作者就用短標題（投影片檔名的「Microsoft PowerPoint -」拿掉）。"""
    first = re.split(r",|，| and |;", str(meta.get("authors") or ""))[0].strip()  # i18n-ok
    last = first.split()[-1] if first else ""
    year = _year(meta)
    if last and len(last) <= 24 and not re.search(r"\d", last):
        return (last + " " + year).strip()
    title = str(meta.get("title_en") or meta.get("short_zh") or meta.get("title_zh") or "")
    for _ in range(3):
        title = _JUNK.sub("", title).strip()
    words = title.replace("_", " ").split()
    return (" ".join(words[:4]) if len(words) > 1 else title[:16]) or str(meta.get("short_zh") or "")[:16]


def card(ws: Workspace) -> dict:
    """一份文件給總覽、挑段落用的東西（照修改時間快取）。"""
    files = [ws.root / "paper.json", ws.root / "item.json", ws.root / "brief.json"]
    mark = tuple(search._stamp(f) for f in files)
    with _lock:
        hit = _cards.get(str(ws.root))
        if hit and hit[0] == mark:
            return hit[1]
    paper = read_json(files[0], {}) or {}
    item = read_json(files[1], {}) or {}
    meta = dict(paper.get("meta") or {})
    meta.update({k: v for k, v in (item.get("meta_override") or {}).items() if v})
    brief = preread.text(ws, BRIEF_PER)
    abstract = next((b.get("zh") or b.get("en") for b in paper.get("blocks", []) if b.get("role") == "abstract"), "") or meta.get("abstract_en", "")
    lead = next((p.strip() for p in brief.split("\n\n") if p.strip() and not p.lstrip().startswith(("-", "【"))), "") or abstract  # i18n-ok
    out = {
        "id": ws.id, "who": _who(meta), "year": _year(meta),
        "title": str(meta.get("title_en") or meta.get("title_zh") or meta.get("source") or ws.id),
        "tags": list(item.get("tags") or []), "opened": str(item.get("last_opened") or item.get("added") or ""),
        "lead": " ".join(str(lead).split())[:LEAD], "brief": brief,
        "gloss": [(str(g.get("zh") or ""), str(g.get("en") or "")) for g in paper.get("glossary") or [] if isinstance(g, dict)],
    }
    with _lock:
        if len(_cards) > 2000:
            _cards.clear()
        _cards[str(ws.root)] = (mark, out)
    return out


def members(lib, scope: dict, here: Workspace) -> list[Workspace]:
    """範圍裡的文件：目前這份排第一（D1），其餘照最近打開的排。"""
    others = [ws for ws in lib.all() if ws.id != here.id]
    if scope["kind"] == "tag":
        others = [ws for ws in others if scope["tag"] in card(ws)["tags"]]
    elif scope["kind"] == "docs":
        want = set(scope["ids"])
        others = [ws for ws in others if ws.id in want]
    others.sort(key=lambda ws: card(ws)["opened"], reverse=True)
    return [here] + others[:MAX_DOCS - 1]


def _tokens(question: str, cards: list[dict]) -> tuple[list[str], list[str]]:
    """（英文關鍵詞, 中文兩字詞）。中文的詞用每一份的術語表換成英文，才找得到英文的原文頁。"""
    q = question or ""
    en = {w.lower() for w in docmap._WORD.findall(q)} - docmap._STOP
    for c in cards:
        for zh, word in c["gloss"]:
            if zh and word and zh in q:
                en |= {w.lower() for w in docmap._WORD.findall(word)} - docmap._STOP
    s = q
    for w in docmap._STOP_ZH:
        s = s.replace(w, " ")
    zh = {run[i:i + 2] for run in re.findall(r"[一-鿿]{2,}", s) for i in range(len(run) - 1)}  # i18n-ok
    return sorted(en), sorted(zh)


def context(lib, here: Workspace, scope: dict, question: str, engine: str, pages_only: bool = False) -> tuple[str, dict]:
    """提示詞裡「範圍裡的文件」那一大段，和代號對照表 {"D3": {"id", "who", "title"}}。
    pages_only：追問（模型行程記得前面給過的總覽和筆記）只給這一問相關的幾頁原文。"""
    docs = members(lib, scope, here)
    cards = [card(ws) for ws in docs]
    codes = {f"D{i}": {"id": c["id"], "who": c["who"], "title": c["title"][:120]} for i, c in enumerate(cards, 1)}
    en, zh = _tokens(question, cards)
    # 預讀筆記：英文詞和中文兩字詞一起比（筆記是中文寫的，術語常保留英文）
    brief_rank = docmap._rank([c["brief"] for c in cards], en + zh) if (en or zh) else []
    # 原文頁：跨文件一起排（每頁都有的詞不算），每份最多幾頁、總字數有上限
    units = [(k, n, folded) for k, ws in enumerate(docs) for n, _shown, folded in search._paper_pages(ws.root)]
    page_rank = docmap._rank([u[2] for u in units], en) if en else []
    doc_score: dict[int, float] = {}
    for s, i in brief_rank:
        doc_score[i] = doc_score.get(i, 0) - s
    for s, i in page_rank[:60]:
        doc_score[units[i][0]] = doc_score.get(units[i][0], 0) - s * 0.5
    order = sorted(doc_score, key=lambda k: -doc_score[k])
    with_brief = [0] + [k for k in order if k != 0 and cards[k]["brief"]][:BRIEF_DOCS - 1]
    if len(with_brief) < BRIEF_DOCS:  # 問題裡沒有對得上的詞：最近打開的幾份
        with_brief += [k for k in range(1, len(cards)) if k not in with_brief and cards[k]["brief"]][:BRIEF_DOCS - len(with_brief)]
    budget = PAGES_TOTAL if engine in ("claude", "codex") else PAGES_TOTAL // 2
    picked, per_doc, used = [], {}, 0
    floor = -page_rank[0][0] * 0.3 if page_rank else 0  # 分數不到最高那頁三成的不帶：只是碰巧有一兩個常見詞
    for _s, i in page_rank:
        if -_s < floor:
            break
        k, n, _ = units[i]
        if per_doc.get(k, 0) >= PAGES_PER_DOC:
            continue
        text = next((shown for pn, shown, _f in search._paper_pages(docs[k].root) if pn == n), "")[:PAGE_PER]
        if not text or used + len(text) > budget:
            continue
        picked.append((k, n, text))
        per_doc[k] = per_doc.get(k, 0) + 1
        used += len(text)
        if used >= budget * 0.95:
            break
    picked.sort(key=lambda x: (x[0], x[1]))
    pages = ("和问题最相关的几页原文（〔代号 p.页码〕开头；公式和表格抽出来可能是乱的）：\n"  # i18n-ok
             + "\n\n".join(f"〔D{k + 1} p.{n}〕\n{text}" for k, n, text in picked)) if picked else ""  # i18n-ok
    if pages_only:
        return pages, codes
    lines = [f"D{k + 1} {c['who']}《{c['title'][:110]}》" + (f"：{c['lead']}" if c["lead"] else "") for k, c in enumerate(cards)]  # i18n-ok 提示詞
    parts = [f"范围里的 {len(cards)} 份文件（D1 是读者现在开着的这份）：\n" + "\n".join(lines)]  # i18n-ok
    briefs = [f"【D{k + 1} {cards[k]['who']}《{cards[k]['title'][:80]}》】\n{cards[k]['brief']}" for k in with_brief if cards[k]["brief"]]  # i18n-ok
    if briefs:
        parts.append("其中几份，你之前读完整份后写的全文笔记（页码是那一份自己的页码）：\n" + "\n\n".join(briefs))  # i18n-ok
    if pages:
        parts.append(pages)
    return "\n\n".join(parts), codes


RULES = ("这一问的范围是好几份文件（代号 D1、D2…）。回答时：每个来自文件的说法后面都标出处，写成〔D3 p.5〕（代号加页码；"  # i18n-ok
         "页码不确定就只写〔D3〕；同时来自几份就各标一个）。只根据下面给的内容回答，给的内容里找不到的就直说没找到、"  # i18n-ok
         "可能要看哪几份，不要编造。比较不同文件时，把相同和不同的地方讲清楚。行文里提到某一份时用作者和年份（例如 Karan 2026）"  # i18n-ok
         "或简短的标题称呼，不要只写代号。")  # i18n-ok


def link(text: str, codes: dict) -> str:
    """回答裡的〔D3 p.5〕換成連結 [Karan 2026 · p.5](/read/<id>#page=5)；對照表裡沒有的代號原樣留著。"""
    def one(m: re.Match) -> str:
        doc = codes.get(m.group(1))
        if not doc:
            return m.group(0)
        name = doc["who"].replace("[", "(").replace("]", ")")
        pages = [(int(a), int(b) if b else None) for a, b in _PAGE.findall(m.group(2) or "")]
        if not pages:
            return f"[{name}](/read/{doc['id']})"
        return " ".join(f"[{name} · p.{a}{'–' + str(b) if b else ''}](/read/{doc['id']}#page={a})" for a, b in pages[:4])
    return _CITE.sub(one, text or "")
