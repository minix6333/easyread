"""預讀：匯入、翻譯的時候就讓 AI 把整份文件（含補充資料）完整讀過一遍，寫成「全文筆記」，之後每一問都帶著它。

- 筆記存在論文資料夾的 brief.json（很小，跟著論文同步，另一台電腦不用再讀一次）：
  {"v": 1, "state": "done", "at", "model", "sig", "parts": [{"label": "第 1–12 頁", "text": …}], "error": ""}
- 整份一次讀不完就分段（每段 CHUNK 字），一段一次請求；超過 AUTO_MAX 的（整本書）不自動讀，讀者自己按。
- 什麼時候讀：匯入準備好頁面之後、開始翻譯的時候、第一次問 AI 的時候（都在背景，不擋住別的事）；
  補充資料加了、刪了，筆記就算舊的，會再讀一次。設定裡「匯入時讓 AI 先讀過整份」可以關（config["preread"]）。
- 問 AI 時怎麼用：chat.py 把筆記放在提示詞最前面；整份文字放得下就一起帶，放不下就靠筆記＋相關頁。
"""
from __future__ import annotations

import hashlib
import threading
import time

from . import chat_models, config, docmap, engines, kinds, langs, supp, tw
from .i18n import tr
from .log import log
from .prompts import localize
from .store import Workspace, now_iso, read_json, write_json_atomic

FILE = "brief.json"
CHUNK = 110000         # 一次請求讀多少字（約 3 萬 token）：一般的論文、講義一次讀完
AUTO_MAX = 440000      # 自動預讀最多這麼多字（4 次請求）；更長的（整本書）要讀者自己按
DIGEST_BUDGET = 12000  # 每次提問帶的全文筆記最多幾個字

_guard = threading.Lock()
_running: dict[str, dict] = {}    # 論文 id → {"cancel", "done", "total"}
_gate = threading.Semaphore(1)    # 一次只讀一份

ASK = (
    "你要替讀者把下面這份{noun}從頭到尾完整讀一遍，寫成一份「全文筆記」。之後回答讀者的問題時會帶著這份筆記，"  # i18n-ok 提示詞
    "所以它要讓人不看原文也知道：這份文件每個部分講了什麼、東西在哪一頁。用{lang}寫。要求：\n"  # i18n-ok 提示詞
    "- 開頭 3 到 5 句寫整份的主線：要解決什麼問題、怎麼做、主要結論是什麼。\n"  # i18n-ok 提示詞
    "- 接著照文件自己的結構一節一節寫（投影片按主題把連續幾頁分成一組），每節標題後面標頁碼範圍。每節寫：\n"  # i18n-ok 提示詞
    "  這一節在講什麼、關鍵主張或結論；定義和記號（符號 → 意思）；核心式子（TeX，照原樣）；"  # i18n-ok 提示詞
    "圖和表各在說明什麼（圖幾、表幾、在第幾頁）；重要的數字結果；和其他部分的關係（用到哪一節、被哪一節用到）。\n"  # i18n-ok 提示詞
    "- 附錄和補充資料一樣要讀完，另外寫清楚哪些內容只在附錄或補充資料裡才有（證明、額外實驗、超參數、實作細節），標明是哪一份的第幾頁。\n"  # i18n-ok 提示詞
    "- 最後兩張清單：「記號表」（全篇通用的符號和意思）、「在哪裡找什麼」（讀者常會問的東西 → 頁碼）。\n"  # i18n-ok 提示詞
    "- 忠於原文：數字、符號、專有名詞照抄，原文沒有的不要加；抽取的文字裡公式、表格可能是亂的，照上下文還原，還原不了就標「公式抽取不全」。\n"  # i18n-ok 提示詞
    "- 寫成緊湊的條列，不要客套、不要評論；行內公式用 $TeX$。全部不超過 {limit} 字。\n"  # i18n-ok 提示詞
)
ASK_PART = "這份文件很長，分成 {total} 段給你讀，這是第 {i} 段（{label}）。只寫這一段的筆記，格式同上；開頭的主線改成一兩句說這一段在整份裡的位置。\n"  # i18n-ok 提示詞


def _path(ws: Workspace):
    return ws.root / FILE


def load(ws: Workspace) -> dict:
    data = read_json(_path(ws), {}) or {}
    return data if isinstance(data, dict) else {}


def signature(ws: Workspace) -> str:
    """文件的內容有沒有變（頁數、字數、補充資料）：變了筆記就算舊的。"""
    pages = docmap.page_texts(ws)
    raw = f"{len(pages)}:{sum(len(p) for p in pages)}|{supp.stamp(ws.root)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _chunks(ws: Workspace) -> list[tuple[str, str]]:
    """整份切成幾段：[(「第 1–12 頁」, 文字)]；一頁不拆開，補充資料接在本文後面。"""
    out, cur, first, last, used = [], [], "", "", 0
    for u in docmap.units(ws):
        text = u["text"].strip()
        if not text:
            continue
        piece = f"[{u['label']}]\n{text[:CHUNK - 200]}"
        if cur and used + len(piece) > CHUNK:
            out.append((first if first == last else f"{first} – {last}", "\n\n".join(cur)))
            cur, used, first = [], 0, ""
        first = first or u["label"]
        last = u["label"]
        cur.append(piece)
        used += len(piece) + 2
    if cur:
        out.append((first if first == last else f"{first} – {last}", "\n\n".join(cur)))
    return out


def text(ws: Workspace, budget: int = DIGEST_BUDGET) -> str:
    """給提示詞用的全文筆記；還沒讀過就是空字串。太長就每段等比例截短。"""
    data = load(ws)
    parts = [p for p in data.get("parts") or [] if isinstance(p, dict) and str(p.get("text") or "").strip()]
    if not parts:
        return ""
    per = max(600, budget // len(parts))
    multi = len(parts) > 1
    return "\n\n".join((f"【{p.get('label', '')}】\n" if multi else "") + str(p["text"])[:per] for p in parts)  # i18n-ok 提示詞


def status(ws: Workspace) -> dict:
    data = load(ws)
    cfg = config.load()
    chars = docmap.size(ws)
    pages = len(docmap.page_texts(ws))
    with _guard:
        run = dict(_running.get(ws.id) or {})
    state = "none"
    if run:
        state = "running"
    elif data.get("parts"):
        state = "done" if data.get("sig") == signature(ws) else "stale"
    elif data.get("error"):
        state = "error"
    return {
        "state": state, "done": run.get("done", 0), "total": run.get("total", 0),
        "at": data.get("at", ""), "model": data.get("model", ""), "error": data.get("error", "") if state == "error" else "",
        "pages": pages, "chars": chars, "supp": supp.listing(ws.root),
        "calls": max(1, -(-chars // CHUNK)) if chars else 0,
        "whole": 0 < chars <= WHOLE,           # 每一問都把整份文字帶上
        "auto": bool(cfg.get("preread", True)), "too_long": chars > AUTO_MAX,
        "engine": cfg.get("engine") != "none",
    }


WHOLE = 120000  # 整份不超過這麼多字（約 3 萬 token）時，每個對話的第一問就把整份文字帶上；chat.py 用


def _ask(ws: Workspace, label: str, body: str, i: int, total: int) -> str:
    meta = ws.load("paper").get("meta") or {}
    title = meta.get("title_en") or meta.get("title_zh") or ""
    limit = 5000 if total == 1 else max(1800, 10000 // total)
    head = ASK.format(noun=kinds.noun(kinds.of(meta)), lang=langs.reply_lang(meta), limit=limit)
    if total > 1:
        head += ASK_PART.format(total=total, i=i + 1, label=label)
    code = langs.reply_code(meta)
    if not tw.is_tw(code):  # 提示詞是繁體寫的；回答不是繁體時轉成簡體，免得模型跟著寫繁體
        head = tw.to_cn(head)
    return localize(head + f"\n文件：《{title}》\n\n" + body + "\n\n現在寫全文筆記：", code)  # i18n-ok 提示詞


def _run(ws: Workspace, mid: str | None, info: dict) -> None:
    from . import chat  # chat 也用到這個模組的 text()，放在這裡避免互相 import
    cancel: threading.Event = info["cancel"]
    with _gate:
        for _ in range(2):  # 讀的時候補充資料又變了：再讀一次（最多兩次）
            sig = signature(ws)
            try:
                ecfg, m = chat_models.engine_cfg(config.load(), mid)
                chunks = _chunks(ws)
                if not chunks:
                    return
                info.update(total=len(chunks), done=0)
                meta = ws.load("paper").get("meta") or {}
                parts = []
                t0 = time.time()
                for i, (label, body) in enumerate(chunks):
                    if cancel.is_set():
                        return
                    guard = tw.Stream(tw.is_tw(langs.reply_code(meta)))  # 繁體保險：模型夾帶的簡體字轉掉
                    out = "".join(guard.feed(piece) for piece in chat.stream(ecfg, _ask(ws, label, body, i, len(chunks)), ws.root, cancel)) + guard.flush()
                    if out.strip():
                        parts.append({"label": label, "text": out.strip()})
                    info["done"] = i + 1
                if not parts:
                    raise engines.EngineError(tr("模型沒有回任何內容"))
                write_json_atomic(_path(ws), {"v": 1, "state": "done", "at": now_iso(), "model": chat_models.label(m), "sig": sig, "parts": parts, "error": ""})
                log.info("預讀完成 %s（%d 段，%.0f 秒）", ws.id, len(parts), time.time() - t0)  # i18n-ok 終端機記錄
            except engines.Cancelled:
                return
            except Exception as e:  # noqa: BLE001
                log.exception("預讀出錯 %s", ws.id)  # i18n-ok
                old = load(ws)
                write_json_atomic(_path(ws), {**old, "v": 1, "error": str(e)[:400], "error_sig": sig, "error_at": now_iso()})
                return
            if signature(ws) == sig:
                return


def start(ws: Workspace, model: str | None = None) -> bool:
    """在背景開始讀；已經在讀就不重複開。"""
    with _guard:
        if ws.id in _running:
            return False
        info = {"cancel": threading.Event(), "done": 0, "total": 0}
        _running[ws.id] = info

    def go():
        try:
            _run(ws, model, info)
        finally:
            with _guard:
                _running.pop(ws.id, None)
    threading.Thread(target=go, daemon=True, name="preread-" + ws.id).start()
    return True


def cancel(ws: Workspace) -> None:
    with _guard:
        info = _running.get(ws.id)
    if info:
        info["cancel"].set()


def auto(ws: Workspace) -> bool:
    """該讀而還沒讀（或筆記舊了）就在背景開始讀。設定關了、沒有模型、文件太長、上次同一份內容讀失敗過，就不讀。"""
    try:
        cfg = config.load()
        if not cfg.get("preread", True) or cfg.get("engine") == "none":
            return False
        with _guard:
            if ws.id in _running:
                return False
        data = load(ws)
        sig = signature(ws)
        if data.get("parts") and data.get("sig") == sig:
            return False
        if data.get("error") and data.get("error_sig") == sig:
            return False
        chars = docmap.size(ws)
        if not chars or chars > AUTO_MAX:
            return False
        return start(ws)
    except Exception:  # noqa: BLE001 預讀是加分的，出錯不能擋住匯入和問答
        log.exception("預讀沒開始 %s", ws.id)  # i18n-ok
        return False
