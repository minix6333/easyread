"""複習卡：一份文件的卡片存在它資料夾裡的 cards.json（和 chat.json 一樣跟著雲端同步、合併時以 id 聯集）。

一張卡 {"id", "q", "a", "page", "quote", "src", "created", "updated", "srs"}：
- q／a：問題和答案（Markdown，可以有 $TeX$）；page：依據在第幾頁；quote：依據的原話（從劃線出的卡）；src：從哪一則筆記出的
- srs：FSRS 間隔重複的狀態 {"due"（ISO 時間）, "s"（穩定度，天）, "d"（難度 1–10）, "reps", "lapses", "last", "state"}；
  排程在前端算（web/js/common/srs.js），這裡只存。沒有 srs 的是新卡，馬上可以複習。
AI 出卡（draft）：從一則劃線／筆記（那段原話、自己寫的、那一頁的文字），或整份文件（預讀筆記＋自己劃線、寫筆記的地方）
出幾張問答卡，回傳給讀者挑，勾了才 add 進來。
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from uuid import uuid4

from . import chat, chat_models, chat_options, config, docmap, kinds, langs, preread, tw
from .i18n import tr
from .prompts import localize
from .store import Workspace, now_iso

MAX_Q, MAX_A = 600, 2000
DRAFT_MAX = 20


def _clean(c: dict) -> dict | None:
    q = str(c.get("q") or "").strip()[:MAX_Q]
    a = str(c.get("a") or "").strip()[:MAX_A]
    if not q or not a:
        return None
    out = {"q": q, "a": a}
    try:
        page = int(c.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    if page > 0:
        out["page"] = page
    for k, n in (("quote", 1200), ("src", 64)):
        v = str(c.get(k) or "").strip()[:n]
        if v:
            out[k] = v
    return out


def _srs(s) -> dict | None:
    if not isinstance(s, dict):
        return None
    out = {}
    for k in ("due", "last"):
        v = str(s.get(k) or "")
        if re.fullmatch(r"\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?", v):
            out[k] = v
    for k, lo, hi in (("s", 0, 36500), ("d", 1, 10)):
        try:
            out[k] = min(hi, max(lo, float(s.get(k))))
        except (TypeError, ValueError):
            pass
    for k in ("reps", "lapses"):
        try:
            out[k] = max(0, int(s.get(k) or 0))
        except (TypeError, ValueError):
            out[k] = 0
    if s.get("state") in ("learning", "review", "relearning"):
        out["state"] = s["state"]
    return out if "due" in out else None


def items(ws: Workspace) -> list[dict]:
    data = ws.load("cards") or {}
    return [c for c in data.get("cards") or [] if isinstance(c, dict) and c.get("id")]


def change(ws: Workspace, body: dict) -> list[dict]:
    """op：add（cards: […]）、update（id, fields）、review（id, srs）、delete（id）。回傳改完的整份清單。"""
    op = body.get("op")
    stamp = now_iso()

    def apply(data):
        cards = [c for c in data.get("cards") or [] if isinstance(c, dict)] if isinstance(data, dict) else []
        if op == "add":
            for raw in (body.get("cards") or [])[:50]:
                c = _clean(raw if isinstance(raw, dict) else {})
                if c:
                    cards.append({"id": "c" + uuid4().hex[:12], **c, "created": stamp, "updated": stamp})
        elif op in ("update", "review", "delete"):
            cid = str(body.get("id") or "")
            card = next((c for c in cards if c.get("id") == cid), None)
            if card is None:
                raise ValueError(tr("沒有這張卡"))
            if op == "delete":
                cards.remove(card)
            elif op == "update":
                fields = _clean({**card, **{k: v for k, v in (body.get("fields") or {}).items() if k in ("q", "a", "page")}})
                if not fields:
                    raise ValueError(tr("問題和答案都要有字"))
                card.update(fields, updated=stamp)
            else:
                s = _srs(body.get("srs"))
                if not s:
                    raise ValueError(tr("複習的狀態不對"))
                card.update(srs=s, updated=stamp)
        else:
            raise ValueError(tr("op 只能是 add / update / review / delete"))
        data.clear()
        data["cards"] = cards
    ws.update("cards", apply)
    return items(ws)


def due(ws: Workspace, now: datetime | None = None) -> list[dict]:
    """到期（或還沒複習過）的卡。"""
    now = now or datetime.now(timezone.utc)
    out = []
    for c in items(ws):
        s = c.get("srs")
        if not s:
            out.append(c)
            continue
        try:
            when = datetime.fromisoformat(str(s["due"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            out.append(c)
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        if when <= now:
            out.append(c)
    return out


def overview(lib) -> dict:
    """整個文獻庫：每份有幾張、幾張到期（側欄的「複習」、複習頁用）。"""
    docs, total, waiting = [], 0, 0
    for ws in lib.all():
        if not (ws.root / "cards.json").exists():
            continue
        cs = items(ws)
        if not cs:
            continue
        d = due(ws)
        meta = (ws.load("paper") or {}).get("meta") or {}
        docs.append({"id": ws.id, "title": meta.get("title_en") or meta.get("title_zh") or ws.id, "cards": len(cs), "due": len(d)})
        total += len(cs)
        waiting += len(d)
    return {"docs": docs, "cards": total, "due": waiting}


def queue(lib, ids=None) -> list[dict]:
    """要複習的卡（到期的），每張帶上 pid 和文件標題；ids 給了就只看那幾份。"""
    out = []
    for ws in lib.all():
        if ids and ws.id not in ids:
            continue
        if not (ws.root / "cards.json").exists():
            continue
        meta = (ws.load("paper") or {}).get("meta") or {}
        title = meta.get("title_en") or meta.get("title_zh") or ws.id
        out += [{**c, "pid": ws.id, "doc": title} for c in due(ws)]
    return out


# ---------- AI 出卡 ----------
SYSTEM = "你在帮读者做间隔重复用的复习卡：只根据给你的资料出题，只输出要求的 JSON。"  # i18n-ok 提示詞
RULES = ("出卡原则：一张只考一个观念；问题要能单独看懂（不要写「这段」「本文」「作者」，要写出是什么方法、哪篇的什么）；"  # i18n-ok
         "答案简短（一两句，必要时带公式 $TeX$），不要照抄整段原文；优先考读者划线、写笔记的地方；"  # i18n-ok
         "定义、为什么、和别的东西有什么不同、公式每一项的意思，都是好题目；不要出只考记数字、记作者名的题。")  # i18n-ok


def _marks(ws: Workspace, limit: int = 40) -> str:
    """讀者自己劃線、寫筆記的地方（出整份的卡時，優先考這些）。"""
    notes = [n for n in (ws.load("reader") or {}).get("notes", {}).values() if isinstance(n, dict) and not n.get("deleted")]
    notes.sort(key=lambda n: (int(n.get("page") or 0), str(n.get("created") or "")))
    rows = []
    for n in notes[:limit]:
        quote, body = " ".join(str(n.get("quote") or "").split())[:400], " ".join(str(n.get("body") or "").split())[:400]
        if quote or body:
            rows.append(f"[第 {n.get('page') or '?'} 页] " + (f"「{quote}」" if quote else "") + (f" 读者写：{body}" if body else ""))  # i18n-ok 提示詞
    return "\n".join(rows)


def prompt(ws: Workspace, body: dict) -> str:
    meta = (ws.load("paper") or {}).get("meta") or {}
    noun = kinds.noun(kinds.of(meta))
    lang = langs.reply_lang(meta)
    try:
        n = max(1, min(DRAFT_MAX, int(body.get("n") or 0) or (2 if body.get("from") == "note" else 10)))
    except (TypeError, ValueError):
        n = 10
    head = (f"读者在读一份{noun}《{meta.get('title_en') or meta.get('title_zh') or ''}》，想做复习卡。用{lang}出 {n} 张问答卡（题目真的不够就少出）。\n"  # i18n-ok
            + RULES + "\n只输出一个 JSON 数组，不要别的文字、不要代码块：\n"  # i18n-ok
            '[{"q": "问题", "a": "答案", "page": 依据所在的页码}]\n\n')  # i18n-ok
    if body.get("from") == "note":
        page = int(body.get("page") or 0) or None
        quote, mine = str(body.get("quote") or "")[:2000], str(body.get("text") or "")[:2000]
        stuff = ((f"读者在第 {page} 页划的原话：「{quote}」\n" if quote else "")  # i18n-ok
                 + (f"读者在那里写的笔记：{mine}\n" if mine else "")  # i18n-ok
                 + (("\n那一页的文字（公式和表格可能是乱的）：\n" + docmap.pages_block(ws, [page], 3500)) if page else ""))  # i18n-ok
    else:
        brief = preread.text(ws, 9000)
        marks = _marks(ws)
        stuff = ((("你之前读完整份后写的全文笔记（分段写了页码）：\n" + brief + "\n\n") if brief else ("整份文件的文字（按页）：\n" + docmap.full_text(ws, 40000) + "\n\n"))  # i18n-ok
                 + (("读者划线、写笔记的地方（优先出这些）：\n" + marks) if marks else ""))  # i18n-ok
    return localize(head + "资料：\n" + stuff, langs.reply_code(meta))  # i18n-ok


def parse(text: str, pages: int, to_tw: bool) -> list[dict]:
    m = re.search(r"\[.*\]", text or "", re.S)
    try:
        data = json.loads(m.group(0)) if m else []
    except ValueError:
        data = []
    out = []
    for raw in data if isinstance(data, list) else []:
        c = _clean(raw if isinstance(raw, dict) else {})
        if not c:
            continue
        if c.get("page") and not 1 <= c["page"] <= max(1, pages):
            c.pop("page")
        if to_tw:
            c["q"], c["a"] = tw.to_tw(c["q"]), tw.to_tw(c["a"])
        out.append(c)
    return out[:DRAFT_MAX]


def draft(handler, ws: Workspace, body: dict) -> list[dict]:
    """請 AI 出卡（不存，回給讀者挑）。讀者關掉了就停。"""
    meta = (ws.load("paper") or {}).get("meta") or {}
    cfg = config.load()
    ecfg, _m = chat_models.engine_cfg(cfg, body.get("model"))
    if ecfg.get("engine") in ("claude", "codex"):  # 出題不需要長考
        try:
            chat_options.apply(ecfg, {"reasoning_effort": "low"})
        except ValueError:
            pass
    cancel = threading.Event()
    watching = chat.cancel_when_gone(handler, cancel)
    try:
        text = "".join(chat.stream(ecfg, prompt(ws, body), ws.root, cancel, live={"tools": "", "system": localize(SYSTEM, langs.reply_code(meta))}))
    finally:
        watching()
    pages = int(meta.get("page_count") or len(meta.get("pages") or []) or 0) or len(docmap.page_texts(ws))
    return parse(text, pages, tw.is_tw(langs.reply_code(meta)))
