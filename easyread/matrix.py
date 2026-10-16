"""比較表：幾份文件（多半是論文）× 幾個問題（欄），AI 一份一份填，每一格附頁碼；畫面上可以加欄、存成筆記（library/matrix.js）。

POST /api/matrix {"ids": [...], "columns": [{"name", "ask"?}], "model"?} → 串流（一行一個 JSON）：
  {"model": 名稱}，每份填好送 {"row": id, "cells": {欄名: {"text", "pages": [3, 5]}}}，出錯 {"row": id, "error": …}，最後 {"done": true}。
- 一份一次請求（同時兩份），給模型的：那份的 AI 預讀筆記（短，分段寫了頁碼）＋摘要，再加上按欄的問題找到的幾頁原文；
  還沒預讀過的就給整份文字（有上限）。
- 模型只回 JSON：{欄名: {"text": 一兩句, "pages": [頁碼]}}；文件裡沒寫的寫「未提及」、不猜。頁碼只留那份真的有的。
- 用「問 AI」的預設模型（或指定的），思考強度用低（填表不需要長考）；回答是繁體時再轉一次（tw.to_tw）。
"""
from __future__ import annotations

import json
import queue
import re
import threading

from . import aijson, chat, chat_models, chat_options, config, docmap, kinds, langs, preread, tw
from .i18n import tr
from .log import log
from .prompts import localize
from .store import Workspace

MAX_DOCS = 30
MAX_COLS = 10
WORKERS = 2
BRIEF = 7000
PAGES = 3
WHOLE = 40000

DEFAULT_COLUMNS = [  # 前端第一次打開時的欄（名字是給人看的，ask 是給模型的說明）
    {"name": "研究問題", "ask": "要解決什麼問題、為什麼重要"},  # i18n-ok 提示詞（前端另有翻譯）
    {"name": "方法", "ask": "核心做法：方法名稱、關鍵設計"},  # i18n-ok
    {"name": "資料與實驗", "ask": "用了哪些資料集、模型、實驗設定"},  # i18n-ok
    {"name": "主要結果", "ask": "最重要的數字和結論"},  # i18n-ok
    {"name": "限制", "ask": "作者承認的或明顯的限制、還沒解決的地方"},  # i18n-ok
]


def parse_columns(cols) -> list[dict]:
    out, seen = [], set()
    for c in cols or []:
        if isinstance(c, str):
            c = {"name": c}
        if not isinstance(c, dict):
            continue
        name = " ".join(str(c.get("name") or "").split())[:60]
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "ask": " ".join(str(c.get("ask") or "").split())[:200]})
    return out[:MAX_COLS]


# 預設的欄是中文，論文多半是英文：找相關頁時帶上這幾個英文詞（自己加的欄就看問題裡的英文詞和這份的術語表）
HINTS = {
    "研究問題": "problem motivation challenge address goal",  # i18n-ok
    "方法": "method approach propose framework algorithm model architecture",  # i18n-ok
    "資料與實驗": "dataset datasets benchmark benchmarks experiments setup training evaluation",  # i18n-ok
    "主要結果": "results accuracy outperforms improvement performance table",  # i18n-ok
    "限制": "limitation limitations future work fail failure drawback",  # i18n-ok
    "資料集": "dataset datasets benchmark corpus",  # i18n-ok
    "評估指標": "metric metrics evaluation measure",  # i18n-ok
}


def _material(ws: Workspace, columns: list[dict]) -> str:
    """給模型看的那份文件：預讀筆記＋摘要＋按欄找到的幾頁；沒預讀過就整份文字（有上限）。"""
    paper = ws.load("paper") or {}
    meta = paper.get("meta") or {}
    brief = preread.text(ws, BRIEF)
    abstract = next((b.get("en") or b.get("zh") for b in paper.get("blocks", []) if b.get("role") == "abstract"), "") or meta.get("abstract_en", "")
    head = f"《{meta.get('title_en') or meta.get('title_zh') or ''}》{meta.get('authors', '')[:160]}"  # i18n-ok 提示詞
    if not brief:
        return head + "\n\n整份文件的文字（按页）：\n" + docmap.full_text(ws, WHOLE)  # i18n-ok 提示詞
    question = " ".join(c["name"] + " " + c.get("ask", "") + " " + HINTS.get(c["name"], "") for c in columns)
    nums = docmap.relevant(ws, question, k=PAGES)
    parts = [head]
    if abstract:
        parts.append("摘要：" + str(abstract)[:2000])  # i18n-ok
    parts.append("你之前读完整份后写的全文笔记（分段写了页码）：\n" + brief)  # i18n-ok
    if nums:
        parts.append("几页原文（公式和表格抽出来可能是乱的）：\n" + docmap.pages_block(ws, sorted(nums), 2600))  # i18n-ok
    return "\n\n".join(parts)


def prompt(ws: Workspace, columns: list[dict]) -> str:
    meta = (ws.load("paper") or {}).get("meta") or {}
    noun = kinds.noun(kinds.of(meta))
    lang = langs.reply_lang(meta)
    spec = "\n".join(f"{i}. {c['name']}" + (f"：{c['ask']}" if c.get("ask") else "") for i, c in enumerate(columns, 1))  # i18n-ok 提示詞
    keys = ", ".join(json.dumps(c["name"], ensure_ascii=False) for c in columns)
    text = (f"你在帮读者做文献比较表。下面是一份{noun}的资料。按每一栏的问题，从这份{noun}里找出答案。\n"  # i18n-ok 提示詞
            f"要求：用{lang}；每栏一到两句，具体（写出方法名、数据集、数字），不要空泛；附上依据所在的页码（这份文件自己的页码）。"  # i18n-ok
            "文件里没写的，text 写「未提及」、pages 留空，不要猜。\n"  # i18n-ok
            "只输出一个 JSON 对象，不要别的文字、不要代码块：\n"  # i18n-ok
            '{"栏名": {"text": "…", "pages": [页码, …]}, …}\n'  # i18n-ok
            f"栏名必须一字不差，依序是：{keys}\n\n栏位：\n{spec}\n\n"  # i18n-ok
            + "资料：\n")  # i18n-ok
    return localize(text + _material(ws, columns), langs.reply_code(meta))


def _pages(value, total: int) -> list[int]:
    """模型給的頁碼：[3, 5]、5、"12"、"p.14"、"12-14"、"第 3、5 頁" 都收；不在這份文件頁數裡的不要。"""
    out: list[int] = []
    for p in value if isinstance(value, list) else [value]:
        if isinstance(p, bool) or p is None:
            continue
        if isinstance(p, (int, float)):
            nums = [int(p)]
        else:
            s = str(p)
            span = re.search(r"(\d{1,4})\s*[-–~～]\s*(\d{1,4})", s)  # i18n-ok（全形波浪號）
            nums = list(range(int(span.group(1)), int(span.group(2)) + 1))[:6] if span else [int(x) for x in re.findall(r"\d{1,4}", s)]
        for n in nums:
            if 1 <= n <= max(1, total) and n not in out:
                out.append(n)
    return out[:6]


def parse_answer(text: str, columns: list[dict], pages: int, to_tw: bool) -> dict:
    """模型的回答 → {欄名: {"text", "pages"}}；抓不到 JSON 就整段放第一欄，讓讀者看得到發生什麼。"""
    raw = (text or "").strip()
    data = aijson.first(raw, "{")  # 前後多的話、TeX 的單條反斜線都收（aijson.py）
    if not isinstance(data, dict):
        data = None
    out = {}
    for c in columns:
        # 提示詞整段轉過繁簡（欄名「軟件」→「軟體」、「信息」→「資訊」），模型照轉過的寫：兩種都找
        cell = None
        if data is not None:
            for key in (c["name"], tw.to_tw(c["name"]), tw.to_cn(c["name"])):
                if key in data:
                    cell = data[key]
                    break
        if isinstance(cell, str):
            cell = {"text": cell}
        if not isinstance(cell, dict):
            cell = {"text": ""}
        txt = " ".join(str(cell.get("text") or "").split())[:600]
        out[c["name"]] = {"text": tw.to_tw(txt) if to_tw else txt, "pages": _pages(cell.get("pages"), pages)}
    if data is None and columns:
        out[columns[0]["name"]] = {"text": tw.to_tw(raw[:600]) if to_tw else raw[:600], "pages": [], "raw": True}
    return out


def _fill(ws: Workspace, columns: list[dict], ecfg: dict, cancel: threading.Event) -> dict:
    meta = (ws.load("paper") or {}).get("meta") or {}
    pages = int(meta.get("page_count") or len(meta.get("pages") or []) or len(docmap.page_texts(ws)) or 1)
    text = "".join(chat.stream(ecfg, prompt(ws, columns), ws.root, cancel, live={"tools": "", "system": localize(SYSTEM, langs.reply_code(meta))}))
    return parse_answer(text, columns, pages, tw.is_tw(langs.reply_code(meta)))


SYSTEM = "你在帮读者填文献比较表：只根据给你的资料回答，只输出要求的 JSON。"  # i18n-ok 提示詞


def handle(handler, lib, body: dict) -> None:
    """server.py 的 POST /api/matrix。handler 是那次請求的 BaseHTTPRequestHandler。"""
    ids = [str(x) for x in (body.get("ids") or []) if isinstance(x, str)][:MAX_DOCS]
    columns = parse_columns(body.get("columns"))
    if not ids or not columns:
        raise ValueError(tr("要選幾份文件、至少一欄"))
    docs = [ws for ws in (lib.ws(i) for i in ids) if ws]
    cfg = config.load()
    ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
    if ecfg.get("engine") in ("claude", "codex"):  # 填表不需要長考：思考強度用低（模型不支援就照卡片上的）
        try:
            chat_options.apply(ecfg, {"reasoning_effort": "low"})
        except ValueError:
            pass
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True
    cancel = threading.Event()
    watching = chat.cancel_when_gone(handler, cancel)
    results: queue.Queue = queue.Queue()
    todo: queue.Queue = queue.Queue()
    for ws in docs:
        todo.put(ws)

    def work():
        while not cancel.is_set():
            try:
                ws = todo.get_nowait()
            except queue.Empty:
                return
            try:
                results.put({"row": ws.id, "cells": _fill(ws, columns, ecfg, cancel)})
            except Exception as e:  # noqa: BLE001  一份出錯不影響別份
                if not cancel.is_set():
                    log.warning("比較表這份沒填成 %s：%s", ws.id, e)
                results.put({"row": ws.id, "error": str(e)[:300]})

    def send(obj):
        handler.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        handler.wfile.flush()
    try:
        send({"model": chat_models.label(m), "rows": [ws.id for ws in docs]})
        workers = [threading.Thread(target=work, daemon=True) for _ in range(min(WORKERS, len(docs)))]
        for t in workers:
            t.start()
        left = len(docs)
        while left and not cancel.is_set():
            try:
                got = results.get(timeout=0.5)
            except queue.Empty:
                continue
            send(got)
            left -= 1
        if not cancel.is_set():
            send({"done": True})
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        cancel.set()  # 讀者關掉了比較表
    finally:
        watching()
