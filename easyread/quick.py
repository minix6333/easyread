"""選字翻譯：在閱讀頁選一段字按「翻譯」，譯文直接流回選字旁邊的小框。

和「問 AI」分開：不進對話記錄、不帶整篇上下文，只給文件標題讓模型知道領域，所以很快。
用哪個模型在「設定 → 模型」裡選（config.quick.translate_model，名單和問 AI 共用）；空著就跟問 AI 的預設一樣。
輸出格式和對話一樣：一行一個 JSON，{"model": …}、{"t": 片段} … 最後 {"done": true} 或 {"error": …}。
"""
from __future__ import annotations

import json
import threading

from . import chat, chat_models, config, engines, kinds, langs, tw
from .i18n import tr
from .log import log
from .prompts import localize
from .store import Workspace

MAX_TEXT = 6000


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


def model_id(cfg: dict, wanted=None) -> str | None:
    """用哪個模型：請求指定的 → 設定裡選的 → 翻譯用的那張卡片（換了翻譯模型，選字翻譯跟著換）→ 問 AI 的預設。名單裡已經沒有的當成沒選。"""
    ids = {m.get("id") for m in chat_models.models(cfg)}
    for mid in (wanted, (cfg.get("quick") or {}).get("translate_model"), chat_models.translation_id(cfg)):
        if mid and mid in ids:
            return str(mid)
    return None


def handle(handler, ws: Workspace, body: dict) -> None:
    """server.py 裡 POST /api/p/<id>/quick 調這裡；handler 是那次請求的 BaseHTTPRequestHandler。"""
    if body.get("mode", "translate") != "translate":
        raise ValueError(tr("mode 只能是 translate"))
    text = str(body.get("text") or "").strip()[:MAX_TEXT]
    if not text:
        raise ValueError(tr("沒有選到文字"))
    cfg = config.load()
    ecfg, m = chat_models.engine_cfg(cfg, model_id(cfg, body.get("model")))
    target = langs.of_paper(ws.load("paper").get("meta"))
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
        guard = tw.Stream(tw.is_tw(target))  # 繁體保險
        for piece in chat.stream(ecfg, prompt(ws, text), ws.root, cancel):
            piece = guard.feed(piece)
            if piece:
                send({"t": piece})
        tail = guard.flush()
        if tail:
            send({"t": tail})
        send({"done": True})
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
