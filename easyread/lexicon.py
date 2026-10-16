"""術語與符號：AI 整理一份文件裡讀者要懂的術語（方法名、概念、縮寫）和數學符號——在這份文件裡的意思、第一次定義在第幾頁、
原文裡定義它的那一句。（翻譯用的術語表在 paper.json 的 glossary，terms.py 管；這份是給讀者「看懂」用的。）

存在論文資料夾的 lexicon.json（跟著雲端同步）：
{"v": 1, "at", "model", "items": [{"t", "k": "term"|"symbol", "def", "page", "quote"}]}
- t：術語照原文寫（英文就是英文）；符號是 TeX（不含 $），例如 \\kappa_C
- def：在這份文件裡是什麼意思（讀者的語言，一兩句）；page：第一次定義（或出現）的頁；quote：原文的定義句（可能沒有）
用在：左邊欄的「術語」分頁、選到這個詞時工具列上的「術語」、問 AI 的提示詞（回答照這份文件的符號和說法講）、做成複習卡。
"""
from __future__ import annotations

import json
import re
import threading

from . import chat, chat_models, chat_options, config, docmap, kinds, langs, preread, tw
from .i18n import tr
from .prompts import localize
from .store import Workspace, now_iso, write_json_atomic

MAX_ITEMS = 60
WHOLE = 60000

SYSTEM = "你在帮读者整理一份文件的术语与符号表：只根据给你的全文，只输出要求的 JSON。"  # i18n-ok 提示詞


def load(ws: Workspace) -> dict:
    try:
        data = json.loads((ws.root / "lexicon.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"items": []}
    return data if isinstance(data, dict) else {"items": []}


def items(ws: Workspace) -> list[dict]:
    return [x for x in load(ws).get("items") or [] if isinstance(x, dict) and x.get("t")]


def prompt(ws: Workspace) -> str:
    meta = (ws.load("paper") or {}).get("meta") or {}
    noun = kinds.noun(kinds.of(meta))
    lang = langs.reply_lang(meta)
    brief = preread.text(ws, 8000)
    head = (f"读者在读一份{noun}《{meta.get('title_en') or meta.get('title_zh') or ''}》，想要一份「术语与符号表」。"  # i18n-ok 提示詞
            f"从下面的全文找出读懂这份{noun}需要知道的术语（方法名、概念、专有名词、缩写）和数学符号，最多 {MAX_ITEMS - 20} 个，照第一次出现的顺序。每一个给：\n"  # i18n-ok
            "- t：术语照原文写（英文就写英文，缩写写成「全称 (缩写)」）；符号写成 TeX，不加 $，例如 \\kappa_C、p_{\\theta}(x)\n"  # i18n-ok
            "- k：term 或 symbol\n"  # i18n-ok
            f"- def：在这份{noun}里是什么意思（用{lang}，一两句，具体；符号要说代表什么，必要时说维度或取值范围）\n"  # i18n-ok
            "- page：第一次定义（没有明确定义就是第一次出现）在第几页\n"  # i18n-ok
            "- quote：原文里定义它的那一句，照抄、40 个字以内；没有明确的定义句就留空\n"  # i18n-ok
            "不要列太普通的词（model、data、loss 这种）；不确定的不要写。只输出一个 JSON 数组，不要别的文字、不要代码块：\n"  # i18n-ok
            '[{"t": "…", "k": "term", "def": "…", "page": 3, "quote": "…"}]\n\n')  # i18n-ok
    body = (("你之前读完整份后写的全文笔记：\n" + brief + "\n\n") if brief else "") + "整份文件的文字（按页；公式可能是乱的）：\n" + docmap.full_text(ws, WHOLE)  # i18n-ok
    return localize(head + body, langs.reply_code(meta))


def parse(text: str, pages: int, to_tw: bool) -> list[dict]:
    m = re.search(r"\[.*\]", text or "", re.S)
    try:
        data = json.loads(m.group(0)) if m else []
    except ValueError:
        data = []
    out, seen = [], set()
    for raw in data if isinstance(data, list) else []:
        if not isinstance(raw, dict):
            continue
        t = " ".join(str(raw.get("t") or "").split())[:120]
        d = " ".join(str(raw.get("def") or "").split())[:500]
        if not t or not d or t.lower() in seen:
            continue
        seen.add(t.lower())
        item = {"t": t, "k": "symbol" if raw.get("k") == "symbol" else "term", "def": tw.to_tw(d) if to_tw else d}
        try:
            page = int(raw.get("page") or 0)
        except (TypeError, ValueError):
            page = 0
        if 1 <= page <= max(1, pages):
            item["page"] = page
        q = " ".join(str(raw.get("quote") or "").split())[:240]
        if q:
            item["quote"] = q
        out.append(item)
    return out[:MAX_ITEMS]


def build(handler, ws: Workspace, body: dict) -> dict:
    """請 AI 整理（一次請求；讀者關掉了就停）。整理好就存起來，回傳整份。"""
    meta = (ws.load("paper") or {}).get("meta") or {}
    cfg = config.load()
    ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
    if ecfg.get("engine") in ("claude", "codex"):
        try:
            chat_options.apply(ecfg, {"reasoning_effort": "low"})
        except ValueError:
            pass
    cancel = threading.Event()
    watching = chat.cancel_when_gone(handler, cancel)
    try:
        text = "".join(chat.stream(ecfg, prompt(ws), ws.root, cancel, live={"tools": "", "system": localize(SYSTEM, langs.reply_code(meta))}))
    finally:
        watching()
    pages = int(meta.get("page_count") or len(meta.get("pages") or []) or 0) or len(docmap.page_texts(ws))
    got = parse(text, pages, tw.is_tw(langs.reply_code(meta)))
    if not got:
        raise ValueError(tr("AI 沒整理出術語（可能是文字太少，或模型沒照格式回答）"))
    data = {"v": 1, "at": now_iso(), "model": chat_models.label(m), "items": got}
    write_json_atomic(ws.root / "lexicon.json", data)
    return data


def prompt_block(ws: Workspace, budget: int = 2600) -> str:
    """問 AI 的提示詞用：符號在前（回答照這份文件的記號講），太長就截。"""
    its = items(ws)
    if not its:
        return ""
    its = [x for x in its if x.get("k") == "symbol"] + [x for x in its if x.get("k") != "symbol"]
    rows, used = [], 0
    for x in its:
        row = (f"${x['t']}$" if x.get("k") == "symbol" else x["t"]) + "：" + x["def"] + (f"（第 {x['page']} 页）" if x.get("page") else "")  # i18n-ok 提示詞
        if used + len(row) > budget:
            break
        rows.append(row)
        used += len(row)
    return "这份文件的术语与符号（回答时照这里的记号和说法）：\n" + "\n".join(rows)  # i18n-ok
