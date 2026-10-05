"""论文笔记的 AI 帮手：点评、帮我改、起草稿；还有“帮这一页写笔记”（mode = page）。

和“问 AI”对话分开：结果直接流回笔记面板，不进对话记录；由读者决定要不要替换或追加到笔记里。
输出格式和对话一样：一行一个 JSON，{"t": 片段} … 最后 {"done": true} 或 {"error": …}。
"""
from __future__ import annotations

import json
import threading

from . import kinds, langs, tw
from . import chat, chat_models, config, engines, pdfwork
from .i18n import tr
from .log import log
from .prompts import _block_text, localize
from .store import Workspace

PAPER_BUDGET = 14000  # 不能自己读文件的引擎：随提示词附上的译文字数上限

ASK = {
    "review": ("请点评这份笔记：哪些理解是准确的；哪些地方和论文不符或理解有误（说清论文实际怎么说、在哪一节）；"  # i18n-ok 提示词
               "漏掉了哪些重要内容；还可以往哪想。直接、具体，分条写，不要客套，不要重写整份笔记。"),  # i18n-ok
    "revise": ("请帮读者修改这份笔记：保留他的观点、结构和口吻，修正和论文不符的地方，补上明显漏掉的要点，把表达理顺。"  # i18n-ok
               "只输出修改后的完整笔记（Markdown，公式写 $TeX$），不要解释改了什么。"),  # i18n-ok
    "draft": ("读者还没写笔记。请帮他起一个读书笔记草稿，留出他自己思考的空间：核心问题、方法要点、主要结论、"  # i18n-ok
              "局限或疑问（这一项只列问题，不替他下结论）。用 Markdown，简洁，公式写 $TeX$。只输出笔记本身。"),  # i18n-ok
}


# 幫這一頁寫筆記：不是摘要。講明白、好回想，但不簡化到失真。
PAGE_ASK = (
    "请替读者写这一页的笔记。不是摘要，也不是把原文缩写或翻译一遍：要把这一页真正在讲的东西讲明白，"  # i18n-ok 提示词
    "让读者过几个星期回来，看一眼这份笔记就能想起来、看得懂。\n"  # i18n-ok
    "写法：\n"  # i18n-ok
    "- 第一行用一句话写出这一页的重点：它在回答什么问题，答案是什么。\n"  # i18n-ok
    "- 接着顺着这一页自己的思路分成两到四小段来讲。每一小段的第一句用粗体写出这一段的结论（只看这几句粗体就能回想起整页），"  # i18n-ok
    "后面再讲它是什么、为什么成立、和前后怎么接上。用直白的话，像讲给同组的同学听；短句，一句一个意思，不绕。\n"  # i18n-ok
    "- 好懂，但不能失真：术语、符号、公式照原文保留；这篇文章自己引入的术语和关键符号，第一次出现时用一句话说清它指什么"  # i18n-ok
    "（读者是研究生，领域里的常识不用解释）；重要的式子写出来，并用一句话说它在表达什么；"  # i18n-ok
    "条件、假设、适用范围、例外不能省；不要用不准确的比喻代替定义。举例就举具体的小例子（带数字更好）。\n"  # i18n-ok
    "- 原文跳过的关键推理（“为什么可以这样做”“这一步怎么来的”）用一两句补上，并标明是补充说明，不是原文写的。"  # i18n-ok
    "证明只讲思路和最关键的一步，不逐行重写。\n"  # i18n-ok
    "- 最容易误解或最容易忘的一两点，放在最后单独点出来。\n"  # i18n-ok
    "- 这一页有图或表时：说清它在展示什么、该怎么看、能得出什么结论。\n"  # i18n-ok
    "篇幅：要让读者回头看时一两分钟读得完——一般 300 到 800 字，内容特别密的页也不要超过 1200 字；"  # i18n-ok
    "每一句都要有用，原文已经写得很清楚的细节不必复述，内容少就短，不要凑字数。\n"  # i18n-ok
    "格式：Markdown。小标题最多两三个（也可以不用），列表不要层层嵌套；"  # i18n-ok
    "行内公式 $TeX$，行间公式 $$TeX$$（$$ 单独占一行）；不要用代码块。"  # i18n-ok
    "不要客套，不要“这一页主要介绍了”这类空话。只输出笔记本身。"  # i18n-ok
)


def page_prompt(ws: Workspace, page: int, note: str, engine: str, with_image: bool) -> str:
    """幫這一頁寫筆記的提示詞：這一頁的文字（圖另外附上）、上一頁的結尾（接上文用）、讀者在這一頁劃的重點和已經寫的筆記。"""
    meta = ws.load("paper").get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or ""
    noun = kinds.noun(kinds.of(meta))
    parts = [f"你在陪读者读一篇{noun}《{title}》。用{langs.reply_lang(meta)}。\n{PAGE_ASK}"]  # i18n-ok
    if with_image:
        parts.append(f"附件是第 {page} 页的原页图：以图为准（公式、图、表都在图上），下面抽取的文字只用来对照。")  # i18n-ok
    parts.append(f"第 {page} 页抽取的文字（公式和表格可能是乱的）：\n" + (chat._page_text(ws, page)[:8000] or "（没有抽到文字）"))  # i18n-ok
    prev = chat._page_text(ws, page - 1)[-700:] if page > 1 else ""
    if prev.strip():
        parts.append("上一页的结尾（只用来接上文，不要写进笔记）：\n" + prev)  # i18n-ok
    marks = [str(n.get("quote") or "").strip()[:300] for n in (ws.load("reader").get("notes") or {}).values()
             if not n.get("deleted") and n.get("page") == page and str(n.get("quote") or "").strip()]
    if marks:
        parts.append("读者在这一页划了这些地方（他在意的重点，笔记里要讲到）：\n" + "\n".join("- " + m for m in marks[:12]))  # i18n-ok
    if note.strip():
        parts.append("读者自己已经在这一页写了下面这些笔记：不要重复它，写的是接在它后面的补充；发现它和原文不符时，在笔记里指出来。\n"  # i18n-ok
                     f"<<<\n{note}\n>>>")
    return localize("\n\n".join(parts), langs.reply_code(meta))


def _paper_text(ws: Workspace) -> str:
    out, used = [], 0
    for b in ws.load("paper").get("blocks", []):
        if b.get("type") == "references":
            break
        t = _block_text(b) if b.get("type") != "heading" else "\n## " + (b.get("zh") or b.get("en") or "")
        if not t:
            continue
        if used + len(t) > PAPER_BUDGET:
            out.append("……（后面的内容略）")  # i18n-ok 提示词
            break
        out.append(t)
        used += len(t)
    return "\n".join(out)


def prompt(ws: Workspace, mode: str, note: str, engine: str) -> str:
    meta = ws.load("paper").get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or ""
    paper = ("论文全文在当前目录的 paper.json 里（blocks 里是译文和原文），需要核对时用 Read 工具去读。"  # i18n-ok 提示词
             if engine == "claude" else "论文译文（节选）：\n" + _paper_text(ws))  # i18n-ok
    text = (f"你在帮读者整理读论文《{title}》的笔记。用{langs.reply_lang(meta)}。{ASK[mode]}\n\n{paper}\n\n"  # i18n-ok
            + (f"读者的笔记：\n<<<\n{note}\n>>>" if note.strip() else ""))  # i18n-ok
    return localize(text, langs.reply_code(meta))


def handle(handler, ws: Workspace, body: dict) -> None:
    """server.py 里 POST /api/p/<id>/notehelp 调这里；handler 是那次请求的 BaseHTTPRequestHandler。"""
    mode = body.get("mode")
    note = str(body.get("note") or "")[:20000]
    if mode != "page" and mode not in ASK:
        raise ValueError(tr("mode 只能是 review / revise / draft"))
    if mode in ("review", "revise") and not note.strip():
        raise ValueError(tr("笔记还是空的"))
    ecfg, m = chat_models.engine_cfg(config.load(), body.get("model"))
    images = []
    if mode == "page":
        try:
            page = int(body.get("page") or 0)
        except (TypeError, ValueError):
            page = 0
        total = int((ws.load("paper").get("meta") or {}).get("page_count") or 0)
        if page < 1 or (total and page > total) or not (ws.root / "source.pdf").exists():
            raise ValueError(tr("找不到这一页"))
        try:
            images = [pdfwork.engine_image(ws.root, page)]  # 原頁圖：公式、圖表以圖為準
        except Exception:  # noqa: BLE001 圖做不出來就只靠抽取的文字
            log.warning("第 %s 頁的原頁圖做不出來，只用文字寫筆記", page)  # i18n-ok 終端機記錄
        text = page_prompt(ws, page, note, ecfg["engine"], bool(images))
    else:
        text = prompt(ws, mode, note, ecfg["engine"])
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
        guard = tw.Stream(tw.is_tw(langs.reply_code(ws.load("paper").get("meta"))))  # 繁體保險
        for piece in chat.stream(ecfg, text, ws.root, cancel, images=images):
            piece = guard.feed(piece)
            if piece:
                send({"t": piece})
        tail = guard.flush()
        if tail:
            send({"t": tail})
        send({"done": True})
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        cancel.set()  # 读者点了停止或关了页面
    except engines.Cancelled:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("笔记帮手出错 %s", ws.id)
        try:
            send({"error": str(e)[:500]})
        except OSError:
            pass
