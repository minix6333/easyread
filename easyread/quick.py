"""選字翻譯：在閱讀頁選一段字按「翻譯」，譯文直接流回選字旁邊的小框。

和「問 AI」分開：不進對話記錄、不帶整篇上下文，只給文件標題讓模型知道領域，所以很快。
用哪個模型在「設定 → 模型」裡選（config.quick.translate_model，名單和問 AI 共用）；空著就跟翻譯用的那張卡片。
輸出格式和對話一樣：一行一個 JSON，{"model": …}、{"t": 片段} … 最後 {"done": true} 或 {"error": …}。

快的訣竅（都不影響譯文品質）：
- Claude 卡片沒指定思考強度就用 low（實測同一句首字快約 1 秒，譯法一樣）；不給工具、系統提示換成一句話（少約 3 千 token）。
- 行程預先啟動（讀者一選字就拉起來，見 claude_live.warm），按翻譯時只剩模型的時間。
- 同一段字再選一次直接給上次的譯文（記最近 300 條）。
"""
from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict

from . import chat, chat_models, config, engines, kinds, langs, tw
from .i18n import tr
from .log import log
from .prompts import localize
from .store import Workspace

MAX_TEXT = 6000
CACHE_MAX = 300
SYSTEM = "你是论文阅读器里的选字翻译。读者选中一段文字，你只输出译文（选的是一个词或短语时给译法和一句说明），不解释、不客套、不重复原文。"  # i18n-ok 提示词
_cache: OrderedDict[tuple, str] = OrderedDict()
_cache_lock = threading.Lock()


def prompt(ws: Workspace, text: str) -> str:
    meta = ws.load("paper").get("meta", {})
    target = langs.of_paper(meta)
    name = langs.prompt_name(target)
    noun = kinds.noun(kinds.of(meta))
    title = meta.get("title_en") or meta.get("title_zh") or ""
    head = (f"读者在读一篇{noun}" + (f"《{title}》" if title else "") + f"，选中了下面这段文字，请翻译成{name}。\n"  # i18n-ok 提示词
            "要求：\n"  # i18n-ok
            "- 只输出译文，不要解释、不要加引号、不要重复原文。\n"  # i18n-ok
            "- 这段文字是从 PDF 里抽出来的，可能有断行、连字符、乱掉的公式：按意思理顺再译。\n"  # i18n-ok
            "- 专业术语第一次出现时在译文后面用括号保留英文；人名、模型名、数据集名、引用编号原样保留；公式写成 $TeX$。\n"  # i18n-ok
            "- 如果选中的只是一个词或短语：先给译法，再另起一行用一句话说明它在这里的意思。\n"  # i18n-ok
            f"- 如果选中的文字本来就是{name}：翻译成英文。\n\n"  # i18n-ok
            "选中的文字：\n<<<\n")  # i18n-ok
    return localize(head, target) + text + "\n>>>"


def system(ws: Workspace) -> str:
    return localize(SYSTEM, langs.of_paper(ws.load("paper").get("meta", {})))


def model_id(cfg: dict, wanted=None) -> str | None:
    """用哪個模型：請求指定的 → 設定裡選的 → 翻譯用的那張卡片（換了翻譯模型，選字翻譯跟著換）→ 問 AI 的預設。名單裡已經沒有的當成沒選。"""
    ids = {m.get("id") for m in chat_models.models(cfg)}
    for mid in (wanted, (cfg.get("quick") or {}).get("translate_model"), chat_models.translation_id(cfg)):
        if mid and mid in ids:
            return str(mid)
    return None


def engine_cfg(cfg: dict, wanted=None) -> tuple[dict, dict]:
    """選字翻譯用的引擎設定：Claude 卡片沒寫思考強度就用 low。"""
    ecfg, m = chat_models.engine_cfg(cfg, model_id(cfg, wanted))
    if ecfg.get("engine") == "claude" and not ecfg["claude"].get("reasoning_effort"):
        ecfg["claude"] = {**ecfg["claude"], "reasoning_effort": "low"}
    return ecfg, m


def cached(key: tuple) -> str | None:
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
        return hit


def remember(key: tuple, text: str) -> None:
    if not text.strip():
        return
    with _cache_lock:
        _cache[key] = text
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)


def warm(ws: Workspace, body: dict) -> dict:
    """讀者一選字工具列就出現：先把翻譯用的模型行程拉起來（不連網、不花額度）。"""
    cfg = config.load()
    ecfg, _ = engine_cfg(cfg, body.get("model"))
    chat.warm(ecfg, ws.root, tools="", system=system(ws))
    return {"ok": True}


def handle(handler, ws: Workspace, body: dict) -> None:
    """server.py 裡 POST /api/p/<id>/quick 調這裡；handler 是那次請求的 BaseHTTPRequestHandler。"""
    if body.get("mode", "translate") != "translate":
        raise ValueError(tr("mode 只能是 translate"))
    text = str(body.get("text") or "").strip()[:MAX_TEXT]
    if not text:
        raise ValueError(tr("沒有選到文字"))
    cfg = config.load()
    ecfg, m = engine_cfg(cfg, body.get("model"))
    target = langs.of_paper(ws.load("paper").get("meta"))
    key = (m.get("id"), target, text)
    hit = cached(key)
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True
    cancel = threading.Event()

    def send(obj):
        handler.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        handler.wfile.flush()
    try:
        send({"model": chat_models.label(m)})
        if hit is not None:  # 同一段字翻過：直接給
            send({"t": hit})
            send({"done": True, "cached": True})
            return
        guard = tw.Stream(tw.is_tw(target))  # 繁體保險
        sys_prompt = system(ws)
        pieces = []
        t0 = time.time()
        for piece in chat.stream(ecfg, prompt(ws, text), ws.root, cancel, live={"tools": "", "system": sys_prompt}):
            piece = guard.feed(piece)
            if piece:
                if not pieces:
                    log.info("選字翻譯首字 %.1f 秒（%s）", time.time() - t0, chat_models.label(m))
                pieces.append(piece)
                send({"t": piece})
        tail = guard.flush()
        if tail:
            pieces.append(tail)
            send({"t": tail})
        remember(key, "".join(pieces))
        send({"done": True})
        chat.warm(ecfg, ws.root, tools="", system=sys_prompt)  # 用掉一個行程，再備一個給下次
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        cancel.set()  # 讀者關掉了小框或頁面
    except engines.Cancelled:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("選字翻譯出錯 %s", ws.id)
        try:
            send({"error": str(e)[:500]})
        except OSError:
            pass
