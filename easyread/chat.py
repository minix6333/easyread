"""阅读页右侧的“问 AI”：提示词和流式输出（回答一个字一个字流出来）。

- 用哪个模型：chat_models.py（设置里的一张短名单）。
- 对话记录：chat_store.py（每篇论文可以有多个对话）。
- 上下文：整份文件（預讀的全文筆記＋整份文字，見 _document、preread.py、docmap.py），再加论文标题、摘要、读者指着的段落和前后几段、读者引用的几处原文、术语表。
  读者的标记（按颜色分好的划线、笔记、问题）只在问题提到“标红的”“划线”“笔记”时才带上，
  提到具体颜色就只带那种颜色，所以可以问“我标红的那些公式之间有什么联系”。
  Claude Code 还能自己 Read paper.json、reader.json 看全文和全部标记。
"""
from __future__ import annotations

import json
import re
import threading
from collections.abc import Iterator
from pathlib import Path

from . import paths
from . import answer_styles, claude_live, codex_live, docmap, engines, netcheck, openai_api, preread, usage
from . import kinds, langs, tw
from .i18n import tr
from .log import log
from .prompts import _block_text, localize
from .store import Workspace

HISTORY = 12  # 带上最近几轮对话
COLOR_NAMES = {"yellow": "黄", "green": "绿", "blue": "蓝", "pink": "红"}  # i18n-ok
MARKS_BUDGET = 9000  # 标记部分最多带多少字
PAPER_BUDGET = 30000  # STE 问答带上正文，长论文各段取节选，保留后面的结果和结论


# ---------- 提示词 ----------
def _page_text(ws: Workspace, n) -> str:
    """原 PDF 某一頁抽取的文字（還沒整理成段落的 PDF，問 AI 時拿這個當上下文）。"""
    try:
        from . import derive  # 這台沒有這篇的抽取文字（另一台匯入的）就先重做
        p = derive.extract(ws.root) / f"page-{int(n):03d}.txt"
        return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""
    except (TypeError, ValueError):
        return ""


def _context(ws: Workspace, anchor: str | None, quote: str, refs: list[dict] | None = None, page=None, whole: bool = False) -> str:
    """讀者正指著哪裡。whole：整份文字已經在提示詞裡（_document），原 PDF 的頁就只說頁碼，不再貼一次那頁的文字。"""
    paper = ws.load("paper")
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    lines = [f"论文：《{meta.get('title_zh') or ''}》{meta.get('title_en') or ''}，{meta.get('authors', '')[:200]}。"]  # i18n-ok
    abstract = next((_block_text(b) for b in blocks if b.get("role") == "abstract"), "")
    if abstract:
        lines.append("摘要：" + abstract[:1500])  # i18n-ok
    idx = next((i for i, b in enumerate(blocks) if b.get("id") == anchor), None)
    if idx is None and page and whole:
        lines.append(f"读者正在看原 PDF 的第 {page} 页（这一页的文字在上面的全文里）。")  # i18n-ok
    elif idx is None and page:  # 讀者在原 PDF 上（沒對到段落，或這篇還沒整理）：給那一頁抽取的文字
        lines.append(f"读者正在看原 PDF 的第 {page} 页，这一页抽取的文字（公式和表格可能是乱的）：\n" + _page_text(ws, page)[:6000])  # i18n-ok
    if idx is not None:
        h = next((b for b in reversed(blocks[:idx + 1]) if b.get("type") == "heading"), None)
        if h:
            lines.append(f"读者正在读的章节：{h.get('num', '')} {h.get('zh') or h.get('en', '')}")  # i18n-ok
        near = blocks[max(0, idx - 3): idx + 3]
        lines.append("附近的段落（有译文用译文，没译的是原文）：\n" + "\n\n".join(f"[{b['id']}] {_block_text(b)}" for b in near))  # i18n-ok
        focus = blocks[idx]
        lines.append(f"读者指着的段落 [{focus['id']}]：\n译文：{_block_text(focus)}\n原文：{focus.get('en') or focus.get('caption_en') or focus.get('tex', '')}")  # i18n-ok
    if quote:
        lines.append(f"读者选中的原话：「{quote}」")  # i18n-ok
    extra = [r for r in (refs or []) if r.get("anchor") != anchor or (r.get("quote") or "") != quote]
    if extra:
        by_id = {b.get("id"): b for b in blocks}
        parts = []
        for r in extra[:12]:
            b = by_id.get(r.get("anchor")) or {}
            q = (r.get("quote") or "").strip()
            if not b and r.get("page"):  # PDF 上選的、沒對到段落：給原話，沒原話就給整頁文字
                parts.append(f"[原 PDF 第 {r['page']} 页] " + (f"读者选中：「{q[:800]}」" if q else "（整页，文字在上面的全文里）" if whole else "这一页的文字：\n" + _page_text(ws, r["page"])[:2000]))  # i18n-ok
                continue
            parts.append(f"[{r.get('anchor')}] " + (f"读者选中：「{q[:800]}」\n  所在段落：" if q else "") + _block_text(b)[:1200])  # i18n-ok
        lines.append("读者引用了这几处（问题可能是在问它们之间的关系）：\n" + "\n".join(parts))  # i18n-ok
    gl = paper.get("glossary", [])
    if gl:
        lines.append("术语表：" + "；".join(f"{g['en']} = {g['zh']}" for g in gl[:80]))  # i18n-ok
    return "\n\n".join(lines)


def _paper_context(ws: Workspace) -> str:
    """跨段或全文问题也能读到后面的结果；明确标出未提供的内容。"""
    paper = ws.load("paper")
    blocks = paper.get("blocks", [])
    parts = []
    for b in blocks:
        text = b.get("en") or b.get("caption_en") or _block_text(b)
        if b.get("type") == "list":
            text = "\n".join("- " + (it.get("en") or it.get("zh", "")) for it in b.get("items", []))
        elif b.get("type") == "table":
            rows = b.get("head", []) + b.get("rows", [])
            text += "\n" + "\n".join(" | ".join(str(cell) for cell in row) for row in rows)
        if text:
            page = f"第 {b['page']} 页" if b.get("page") else ""  # i18n-ok
            parts.append(f"[{b.get('id', '')}] {page}\n{text}")
    if not parts:
        return "论文正文尚未提供；只能依据摘要、引用和当前段落回答。"  # i18n-ok
    complete = sum(map(len, parts)) + 2 * (len(parts) - 1) <= PAPER_BUDGET
    if not complete:
        limit = max(0, PAPER_BUDGET // len(parts) - 2)
        marker = "\n…（本段节选）…\n"  # i18n-ok
        clipped = []
        for part in parts:
            if len(part) > limit:
                room = max(0, limit - len(marker))
                head = (room + 1) // 2
                tail = room - head
                part = (part[:head] + marker + (part[-tail:] if tail else "")) if room else part[:limit]
            clipped.append(part)
        parts = clipped
    label = "当前已导入的正文" if complete else "正文节选（长文超出上下文预算，各段只保留部分内容）"  # i18n-ok
    total = paper.get("meta", {}).get("page_count")
    done = paper.get("translation", {}).get("done_pages")
    if total and done is not None and len(set(done)) < total:
        label += f"（只完成整理 {len(set(done))} / {total} 页）"  # i18n-ok
    return label + "；没有提供的页面和省略部分不能视为已读：\n\n" + "\n\n".join(parts)  # i18n-ok


def _marks(ws: Workspace, colors: set[str] | None = None) -> str:
    """读者的全部标记，按颜色分组；每处带上所在段落的译文（含 $TeX$），这样问“红色那些公式”也答得上。"""
    paper = ws.load("paper")
    blocks = {b.get("id"): b for b in paper.get("blocks", [])}
    order = {b.get("id"): i for i, b in enumerate(paper.get("blocks", []))}
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    notes.sort(key=lambda n: order.get(n.get("anchor"), 1e9))
    kinds = {"highlight": "划线", "note": "笔记", "question": "问题"}  # i18n-ok
    groups: dict[str, list[str]] = {}
    shown: set[str] = set()
    for n in notes:
        color = COLOR_NAMES.get(n.get("color") or "yellow", "黄") if n.get("quote") else "无颜色"  # i18n-ok
        if colors and color not in colors:
            continue
        b = blocks.get(n.get("anchor")) or {}
        line = f"- [{n.get('anchor')}] {kinds.get(n.get('kind'), '笔记')}"  # i18n-ok
        if n.get("quote"):
            line += f"：「{n['quote']}」" + ("（英文原文）" if n.get("side") == "en" else "")  # i18n-ok 发给模型的上下文
        if n.get("body"):
            line += f"；读者写道：{n['body'][:300]}"  # i18n-ok
        if b and b.get("id") not in shown:
            shown.add(b["id"])
            line += f"\n  所在段落：{_block_text(b)[:600]}"  # i18n-ok
        groups.setdefault(color, []).append(line)
    parts, used = [], 0
    for color in ["红", "黄", "绿", "蓝", "无颜色"]:  # i18n-ok
        for line in groups.get(color, []):
            if used > MARKS_BUDGET:
                break
            if not parts or not parts[-1].startswith(f"【{color}"):  # i18n-ok 发给模型的上下文
                parts.append(f"【{color}色】" if color != "无颜色" else "【没有颜色的笔记和问题】")  # i18n-ok
            parts.append(line)
            used += len(line)
    return ("读者在译文上做的标记（按颜色分组，读者说“红的”“黄色那些”就是指这里；每处附所在段落译文，行内公式是 $TeX$）：\n"  # i18n-ok
            + "\n".join(parts) + ("\n（标记太多，只列了一部分；Claude Code 可以 Read reader.json 看全部）" if used > MARKS_BUDGET else ""))  # i18n-ok


MARK_WORDS = re.compile(r"标[红黄绿蓝记了过的出注]|划线|划过|划的|画线|画过|画的|高亮|涂|颜色|[红黄绿蓝][色的]|笔记|批注|标记|我的问题|highlight", re.I)  # i18n-ok


def wants_marks(text: str) -> tuple[bool, set[str] | None]:
    """问题里提到“标红的”“划线”“我的笔记”这类词，才把读者的标记带上；提到具体颜色就只带那几种。
    讀者用繁體問（「標紅的」「畫線」「筆記」）：先轉成簡體再比對。"""
    text = tw.to_cn(text or "")
    if not MARK_WORDS.search(text):
        return False, None
    colors = {c for c in "红黄绿蓝" if re.search(c + "[色的]|标" + c, text)}  # i18n-ok
    return True, (colors | {"无颜色"} if colors and re.search(r"笔记|问题|批注", text) else colors or None)  # i18n-ok


def _marks_summary(ws: Workspace) -> str:
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    counts: dict[str, int] = {}
    for n in notes:
        k = COLOR_NAMES.get(n.get("color") or "yellow", "黄") + "色" if n.get("quote") else "无颜色笔记"  # i18n-ok
        counts[k] = counts.get(k, 0) + 1
    return "读者在论文上做过 " + str(len(notes)) + " 处标记（" + "、".join(f"{k} {v}" for k, v in counts.items()) + "），这次问题没提到，就没附上。"  # i18n-ok


def images_note(images) -> str:
    """對話記錄裡，之前某一問附過圖：在那句後面記一筆（Claude Code 需要時可以再 Read 一次）。"""
    names = [str(x) for x in (images or []) if x]
    return ("\n（这一问附了图片：" + "、".join(names) + "）") if names else ""  # i18n-ok 提示词


def _images_hint(images, engine: str) -> str:
    """這次提問附了圖（在原 PDF 上框選的區域、貼進來的圖片）：告訴模型圖在哪。
    Claude Code 走 claude_live 時圖直接放在訊息裡（和 Codex、API 一樣，少一個 Read 來回）；舊版才要它自己 Read。"""
    names = [str(x) for x in (images or []) if x]
    if not names:
        return ""
    if engine == "claude" and not claude_live.enabled():
        return ("\n\n读者这次附了 " + str(len(names)) + " 张图片，先用 Read 工具把每一张都看过再回答（路径相对当前目录）：\n"  # i18n-ok
                + "\n".join("- " + n for n in names)
                + "\n以图片里看到的内容为准；图里的公式、表格、坐标轴、图例都要读仔细。")  # i18n-ok
    return ("\n\n读者这次附了 " + str(len(names)) + " 张图片（就在这条消息的附件里），先看图再回答；"  # i18n-ok
            "图里的公式、表格、坐标轴、图例都要读仔细。")  # i18n-ok


# 整份導讀：上課（或讀）之前先知道每個部分在講什麼、要懂什麼。整份文字都附上（docmap.full_text）。
OVERVIEW = (
    "读者准备上课（或读这份之前）想先知道它会讲什么、要先会什么。请按文件自己的结构分部分"  # i18n-ok 提示词
    "（论文按章节；投影片按连续的几页一组，一组讲一个主题），每个部分写：\n"  # i18n-ok
    "- 页码范围和主题（一句话）\n"  # i18n-ok
    "- 要懂的观念：每个观念一句话说它是什么、在这里扮演什么角色\n"  # i18n-ok
    "- 先备知识：读这部分前要会什么（具体到定理、方法或概念的名字）\n"  # i18n-ok
    "- 用到的数学：哪些工具；核心的一两条式子写出来，说明符号\n"  # i18n-ok
    "- 容易卡住的地方\n"  # i18n-ok
    "开头先用一小段讲整份的主线（它在解决什么问题、各部分怎么接起来）；最后给一张「上课前先复习」的清单"  # i18n-ok
    "（按重要性排，每项说为什么要先会）。用小标题和清单，简短、具体，标出页码；不要空泛的话。"  # i18n-ok
    "内容照文件写；文件没讲到的先备知识可以补，但要标明是补充。\n"  # i18n-ok
)

# 一般的寫法：讓人一次看懂、讀得下去。參考的是讀者自己覺得最好懂的那種講解——先講核心、小節標題就是結論、
# 一個具體例子貫穿到底、式子後面馬上解釋符號、句子之間接得上。問題小就短答，不硬套。
STYLE = (
    "寫法（目標是讓讀者一次看懂、讀得下去）：\n"  # i18n-ok 提示詞
    "1. 第一段直接講核心：這裡在做什麼、結論是什麼；整段最關鍵的那一句用粗體。不要先鋪陳背景。\n"  # i18n-ok 提示詞
    "2. 問題小（問一個事實、一個詞、是不是）就幾句話答完，不要分節。要講懂一段內容、一個方法、一個概念時才分成幾小節，"  # i18n-ok 提示詞
    "小節用「## 1. 標題」，標題本身就是那一節的結論（例如「3. Dynamic Data Selection：資料的重要性會隨訓練改變」），不要只寫名詞。\n"  # i18n-ok 提示詞
    "3. 每一節照這個順序走：出發點（為什麼需要它、前一個做法哪裡不夠）→ 關鍵觀念（單獨一行、粗體）→ 一個具體例子 → 式子或細節 → 所以得到什麼。"  # i18n-ok 提示詞
    "句子之間要接得上：用「因為、所以、但是、也就是說、因此」把道理連起來，上一句的結尾是下一句的開頭；不要丟出一串互不相干的條列。\n"  # i18n-ok 提示詞
    "4. 新名詞、新符號第一次出現時當場用一句白話說它是什麼，名詞寫成「中文（English）」；之後一直用同一個說法，不要換詞。讀者還沒看過的符號不能直接拿來用。\n"  # i18n-ok 提示詞
    "5. 例子要具體：有對象、有數字（像「CIFAR-10 的 50,000 張圖只挑 10,000 張來訓練」），而且整個回答用同一個例子，後面每一節都回到它。\n"  # i18n-ok 提示詞
    "6. 式子寫出來之後，下一句就說明每個符號（「其中 $\\theta_t$ 是…」），再用一句白話說這條式子在講什麼。\n"  # i18n-ok 提示詞
    "7. 比較幾種做法、流程、結構、隨時間的變化、數量的對比，用圖比用字清楚：這種地方畫示意圖（見下面「示意圖」），圖在前、解釋在後。不適合就不畫。\n"  # i18n-ok 提示詞
    "8. 段落短（兩三句一段）；重點用粗體，但一段最多一處；條列只用在真的並列的東西上。\n"  # i18n-ok 提示詞
)

# 示意圖：模型寫一小段受限的 HTML（只用下面這些部件），頁面畫成卡片（web/js/common/viz.js 會過濾掉其他東西）
VIZ = (
    "示意圖：寫在 ```viz 程式碼區塊裡，內容是一小段 HTML，只能用下面這些部件（class 名稱照抄），頁面會把它畫成卡片：\n"  # i18n-ok 提示詞
    "<div class=\"viz\"><h4>圖的標題（一句話說這張圖在比什麼）</h4>\n"  # i18n-ok 提示詞
    "  <div class=\"row\">　　　　　　並排的幾格，會自動換行；一張圖 2 到 4 格\n"  # i18n-ok 提示詞
    "    <div class=\"panel\"><h5>① 小標題</h5>\n"  # i18n-ok 提示詞
    "      <div class=\"cells\" data-map=\"10010010/01001001\"></div>　一排排小方塊：1 亮、0 暗、2 和 3 是另外兩種顏色、x 是劃掉，/ 換行（表示一批資料裡挑了哪些、矩陣、遮罩…）\n"  # i18n-ok 提示詞
    "      <div class=\"arrow down\"></div>　　箭頭：down 或 right，加 dashed 是虛線，可以寫字 <div class=\"arrow right\">訓練中重算</div>\n"  # i18n-ok 提示詞
    "      <div class=\"big\">🐶</div>　　　　大圖示：一個 emoji、一兩個字或一個數字\n"  # i18n-ok 提示詞
    "      <div class=\"bar\" style=\"--v:76\">標籤<b>76.2</b></div>　橫條，--v 是 0 到 100 的長度\n"  # i18n-ok 提示詞
    "      <p class=\"cap\">這一格的一句說明</p>\n"  # i18n-ok 提示詞
    "    </div>\n"
    "  </div>\n"
    "  <p class=\"note\">補充（例如：這是示意，不是原文的圖）</p>\n"  # i18n-ok 提示詞
    "</div>\n"
    "另外可以用 <b>、<br>、<span class=\"tag\">標籤</span>、<span class=\"hl\">重點</span>、<table>，以及簡單的 <svg viewBox=\"0 0 320 160\">（畫曲線、座標軸、幾何關係；"  # i18n-ok 提示詞
    "線條和文字的顏色用 class=\"ink\"、\"accent\"、\"muted\"、\"c2\"、\"c3\"，不要自己寫顏色）。文字裡可以寫 $TeX$。不能用 script、style、img、連結。\n"  # i18n-ok 提示詞
    "一個回答最多兩三張圖，每張只講一件事，格子裡的字要短；圖的內容必須忠於原文，自己編的示意例子要在 note 裡說明是示意。"  # i18n-ok 提示詞
    "流程、架構、因果關係改用 ```flow（Mermaid flowchart 的寫法：flowchart LR、A[方框] --> B(圓角)、A -->|說明| B、subgraph 名稱 … end）。\n"  # i18n-ok 提示詞
)

# 提問的幾種專門寫法（卡片上的小按鈕：推導、圖解）。key 由頁面隨問題送來（body.mode），沒有就照一般寫法。
MODES = {
    "explain": (
        "這次讀者要你把這裡完整講懂（以下要求優先）：照上面的寫法寫一份完整的講解——開頭一段講核心，接著分成幾個小節（標題就是結論），"  # i18n-ok 提示詞
        "每節有出發點、粗體的關鍵觀念、同一個貫穿的具體例子、式子和符號說明；適合的地方配示意圖或流程圖（一般至少一張）。"  # i18n-ok 提示詞
        "最後用「一句話記住」收尾：整段內容濃縮成一句。講的是選中的這一處，但要放回整份文件裡看：它前面接什麼、後面拿它做什麼。\n"  # i18n-ok 提示詞
    ),
    "derive": (
        "这次读者要看的是推导（以下要求优先于上面的一般写法）。像一位认真的教授在黑板上边写边讲：\n"  # i18n-ok 提示词
        "1. 先交代：从什么出发（已知条件、定义、假设），要推到什么（目标式子），会用到哪些记号。\n"  # i18n-ok
        "2. 一步一步推，不跳步。每一步先写式子（行间公式；连续几步用 aligned 环境把等号对齐），紧接着用一两句话讲清这一步为什么可以这样写："  # i18n-ok
        "用了哪个定义、定理、恒等式或假设，做的是哪一种数学操作（例如“对 c 求导并令导数为 0”“$a^Tb$ 是标量，所以等于 $b^Ta$”）。"  # i18n-ok
        "不许写“显然”“易得”“同理可得”。\n"  # i18n-ok
        "3. 整个推导里最关键的那一步（想法所在）要特别点出来：它在做什么，直觉是什么。\n"  # i18n-ok
        "4. 最后写出结果，再用两三句话说明：结果的含义、成立的条件、容易弄错的地方。\n"  # i18n-ok
        "严谨优先：记号前后一致；维度、定义域、取等条件、哪些量被当作常数都写清楚。页面上的推导跳了步就补上；页面有错就指出来；"  # i18n-ok
        "页面没有给推导，就根据页面的定义自己推，并说明哪些步骤是你补的。讲解的话要直白，让学生跟得上，但不能为了好懂而牺牲正确性。\n"  # i18n-ok
    ),
    "solve": (
        "这次读者要的是把选中的题目完整解出来（以下要求优先于上面的一般写法）。像一位认真的助教写标准解答：\n"  # i18n-ok 提示词
        "1. 先用一两句话复述题目要求什么、已知什么（图里、框里的条件都要读进去；有几小题就逐题解）。\n"  # i18n-ok
        "2. 解题过程完整写出来：每一步的算式用行间公式（连续几步用 aligned 环境把等号对齐），式子旁边一句话说明依据——"  # i18n-ok
        "用了哪个定义、定理或公式，为什么可以这样做。不跳步，不写“显然”；数值计算把代入的数字写出来，单位一起带着。\n"  # i18n-ok
        "3. 最后把答案单独写出来：用 **答：** 开头，公式或数值答案放进 $\\boxed{…}$；有几小题就逐题给答案。\n"  # i18n-ok
        "4. 答完检查一遍：单位或量纲、取值范围、特殊情况、答案是否合理，有问题就改正。题目条件不够或有歧义时，说明你补了什么假设。\n"  # i18n-ok
        "5. 有更简洁的解法时，最后用两三句话点一下。\n"  # i18n-ok
        "题目里的符号照用；不要只给答案不给过程，也不要为了简短省掉关键步骤。\n"  # i18n-ok
    ),
    "diagram": (
        "这次读者想用图看懂这里（以下要求优先于上面的一般写法）：主要靠图，文字只当图注。\n"  # i18n-ok 提示词
        "- 画 1 到 3 张图。自己判断哪种图最能说明问题：流程图（步骤、数据怎么流动）、架构图（由哪些部分组成，怎么分层分组，谁连着谁）、"  # i18n-ok
        "关系图（概念之间的因果、依赖、包含）；并列比较用 Markdown 表格。\n"  # i18n-ok
        "- 图写在 ```flow 代码块里，语法只能用 Mermaid flowchart 的这个子集（别的图种这里画不出来）：\n"  # i18n-ok
        "  第一行 `flowchart LR`（从左到右）或 `flowchart TD`（从上到下）。\n"  # i18n-ok
        "  节点：`A[方框]`、`B(圆角)`、`C([起点或终点])`、`D{判断}`、`E[(数据或存储)]`。文字里有括号或引号时，整段用双引号包起来，如 `A[\"f(x)\"]`；"  # i18n-ok
        "换行用 <br>；可以写 $TeX$。\n"  # i18n-ok
        "  连线：`A --> B`，带说明 `A -->|说明| B`，虚线 `A -.-> B`，粗线 `A ==> B`，双向 `A <--> B`，无箭头 `A --- B`；可以连写 `A --> B --> C`。\n"  # i18n-ok
        "  分组（架构图的层、模块）：`subgraph enc[编码器]` 换行写组里的节点和连线，最后一行 `end`；组里可以写 `direction LR` 或 `direction TD`；"  # i18n-ok
        "组可以嵌套，也可以用组的 id 直接连线（`输入 --> enc`）。\n"  # i18n-ok
        "- 图要清楚好看：节点文字短（一般不超过 12 个字），一张图不超过 12 个节点，内容多就拆成两张；先想好布局再写，尽量不让线交叉。\n"  # i18n-ok
        "- 每张图下面用一两句话说怎么看这张图、关键在哪里。不要大段文字，不要把图里已有的内容再用文字重复一遍。\n"  # i18n-ok
        "- 图里的内容必须忠于原文，不能为了画图而简化到失真；原文的术语、符号照用。\n"  # i18n-ok
    ),
}


def noun_of(ws: Workspace) -> str:
    return kinds.noun(kinds.of(ws.load("paper").get("meta")))


def aside_context(ws: Workspace, aside: dict | None) -> dict | None:
    """小視窗追問：讀者指著之前某段回答裡的一句話另外問。找出那段回答和它回答的問題，給提示詞用。"""
    if not isinstance(aside, dict) or not aside.get("thread"):
        return None
    from . import chat_store
    t = chat_store.get(ws, str(aside.get("thread")))
    msgs = (t or {}).get("messages", [])
    i = next((k for k, m in enumerate(msgs) if m.get("id") == aside.get("msg") and m.get("role") == "assistant"), None)
    if i is None:
        return None
    q = msgs[i - 1].get("content", "") if i and msgs[i - 1].get("role") == "user" else ""
    return {"answer": msgs[i].get("content", ""), "question": q, "quote": str(aside.get("quote") or "")[:600]}


def _aside_text(aside: dict | None) -> str:
    if not aside:
        return ""
    return ("读者正在看你之前的一段回答" + (f"（他当时问的是「{aside['question'][:300]}」）" if aside.get("question") else "") + "：\n"  # i18n-ok
            + aside.get("answer", "")[:3500] + "\n\n"
            + (f"他指着回答里这一句，想把它弄懂：「{aside['quote']}」。围绕这一句回答，需要时才引用文件。" if aside.get("quote") else "")).rstrip()  # i18n-ok


def same_spot(prev: dict | None, user: dict, refs, page) -> bool:
    """追問時讀者還指著上一問那一處（同一段、同一頁、同一句、同幾處引用）：位置上下文不用再送一遍。"""
    if not prev:
        return False
    keys = lambda rs: [((r.get("anchor") or ""), (r.get("quote") or ""), (r.get("page") or 0)) for r in (rs or [])]  # noqa: E731
    return ((prev.get("anchor") or "") == (user.get("anchor") or "") and (prev.get("page") or None) == (page or None)
            and (prev.get("quote") or "") == (user.get("quote") or "") and keys(prev.get("refs")) == keys(refs))


def prompt(ws: Workspace, messages: list[dict], anchor: str | None, quote: str, engine: str, refs: list[dict] | None = None,
           answer_style: str = answer_styles.DEFAULT, page=None, images=None, followup: bool = False, with_context: bool = True,
           mode: str | None = None, aside: dict | None = None) -> str:
    """followup：這個對話的模型行程還活著、記著前面幾輪（claude_live / codex_live），只送新問題，不再重發說明和對話記錄；
    with_context=False 表示讀者還指著同一處（same_spot），位置上下文也省掉。mode：這一問的專門寫法（MODES 的 key：推導、圖解；
    overview 是整份導讀）。aside：小視窗追問（aside_context 的結果）。
    整份文件（_document）：預讀寫的全文筆記＋整份文字（本文和補充資料，不超過 whole_budget 時）；更長的帶筆記＋全文地圖，
    再按問題的關鍵詞找最相關的幾頁；Claude／Codex 還能自己去讀別頁。"""
    answer_style = answer_styles.parse(answer_style)
    history = messages[-HISTORY:]
    convo = "\n\n".join(("读者" if m["role"] == "user" else "你") + "：" + m["content"] for m in history[:-1])  # i18n-ok
    ask = history[-1]["content"] if history else ""
    meta = ws.load("paper").get("meta") or {}
    # 這個分支新寫的提示詞（STYLE、VIZ、講解）是繁體；回答不是繁體時轉成簡體，和其餘（上游的簡體提示詞）一致
    cn = (lambda t: t) if tw.is_tw(langs.reply_code(meta)) else tw.to_cn
    special = cn(MODES.get(mode or "", ""))
    total = int(meta.get("page_count") or 0)
    files = f"（一页一个文件，page-001.txt 到 page-{total:03d}.txt）" if total else "（一页一个文件）"  # i18n-ok
    # 上下文够用就别让模型去读文件：Opus / Fable 一读 paper.json 就是十几秒、上万 token（实测首字 2 秒变 13 秒）
    extract_dir = str(paths.derived(ws.root, "extract"))
    tool = (("下面给的内容一般就够了，直接回答。确实需要别的页时，用 Read 工具读 " if engine == "claude" else "下面给的内容一般就够了，直接回答。确实需要别的页时，可以读 ")  # i18n-ok
            + extract_dir + " 里那一页抽取的文字" + files + "；不要整本读 paper.json。读者的全部标记在 reader.json 的 notes 里，问到标记时才去看。\n"  # i18n-ok
            if engine in ("claude", "codex") else "")
    want, colors = wants_marks(ask)
    marks = _marks(ws, colors) if want else ("" if followup else _marks_summary(ws))
    seen = {page} | {r.get("page") for r in (refs or []) if r.get("page")}
    # 整份文件：預讀寫的全文筆記＋整份文字（放得下時）；放不下就是筆記＋全文地圖，再按問題找最相關的幾頁
    doc, has_all = _document(ws, engine)
    near_text = "" if has_all or mode == "overview" else docmap.nearby(ws, ask, skip=seen, k=3, per=2400 if followup else docmap.PAGE_BUDGET)
    aside_text = _aside_text(aside)
    if mode == "overview" and not followup:  # 導讀的追問走一般的追問（行程記得整份文字）
        brief = preread.text(ws)
        text = (f"你在陪读者读一篇{noun_of(ws)}《{meta.get('title_zh') or meta.get('title_en') or ''}》。"  # i18n-ok
                + "用" + langs.reply_lang(meta) + "。" + OVERVIEW  # i18n-ok
                + "行内公式只用 $TeX$，行间公式只用 $$TeX$$（$$ 单独占一行）。只输出内容本身，不要客套。\n\n"  # i18n-ok
                + (("你之前读完整份后写的全文笔记：\n" + brief + "\n\n") if brief else "")  # i18n-ok
                + "整份文件的文字（按页；公式和表格可能是乱的）：\n" + docmap.full_text(ws)  # i18n-ok
                + f"\n\n读者现在问：{ask}")  # i18n-ok
        return localize(text, langs.reply_code(meta))
    if followup:
        text = ((_context(ws, anchor, quote, refs, page, whole=has_all) + "\n\n") if with_context else "读者还指着刚才那一处。\n\n")  # i18n-ok
        text += (marks + "\n\n") if marks else ""
        hint = _images_hint(images, engine).strip()
        text += (hint + "\n\n") if hint else ""
        text += ("问题可能涉及的其他页：\n" + near_text + "\n\n") if near_text else ""  # i18n-ok
        text += (aside_text + "\n\n") if aside_text else ""
        text += (special + "\n") if special else ""
        text += f"读者接着问：{ask}"  # i18n-ok
        return localize(text, langs.reply_code(meta))
    ste = answer_style == answer_styles.STE100
    style = (answer_styles.STE100_INSTRUCTIONS if ste else "用" + langs.reply_lang(meta) + "。" + cn(STYLE))  # i18n-ok
    whole = _paper_context(ws) if ste and not has_all else ""
    noun = noun_of(ws)
    # 順序：不變的在前（說明、整份文件），會變的在後（讀者指著哪、對話、問題）——同一份文件接著問時前面那一大段吃得到快取
    text = (f"你在陪读者读一篇{noun}，回答他边读边冒出来的问题。你已经把整份{noun}读完了（下面有全文），回答时要放在整份里看，不要只看读者指着的那一小段。\n" + style  # i18n-ok
            + "区分“文件里写了什么”和“你的补充解释”，文件里没有的内容不要说成是文件说的。"  # i18n-ok
            "行内公式只用 $TeX$，行间公式只用 $$TeX$$。"  # i18n-ok
            r"不要用 \(\) 或 \[\]，不要把公式放进反引号或代码块。"  # i18n-ok
            "行间公式的 $$ 单独占一行。公式内部可以换行，但不要在公式中插入空行；多行推导使用 aligned 环境。"  # i18n-ok
            "保留完整的上下标、括号和单位。提到原文位置时说“式 5”“第 4 页那段”，不要写 [p4-5] 这类内部编号。只输出回答本身，不要客套，不要重复问题。\n"  # i18n-ok
            + ("" if ste else cn(VIZ)) + tool
            + doc
            + "\n\n" + _context(ws, anchor, quote, refs, page, whole=has_all)
            + (("\n\n问题可能涉及的其他页（按问题里的关键词找到的）：\n" + near_text) if near_text else "")  # i18n-ok
            + ("\n\n" + whole if whole else "")
            + ("\n\n" + marks if marks else "")
            + (f"\n\n之前的对话：\n{convo}" if convo else "")  # i18n-ok
            + _images_hint(images, engine)
            + ("\n\n" + aside_text if aside_text else "")
            + ("\n\n" + special.rstrip() if special else "")
            + f"\n\n读者现在问：{ask}")  # i18n-ok
    # 回答語言是繁體時整段提示詞轉成繁體，模型才不會跟著提示詞寫簡體（讀者的問題、原文和 TeX 不受影響）
    return localize(text, langs.reply_code(meta))


def whole_budget(engine: str) -> int:
    """整份文字不超過多少字就每個對話都帶上。按量計費的 API 門檻低一半（每一問都要重送一次）。"""
    return preread.WHOLE if engine in ("claude", "codex") else preread.WHOLE // 2


def _document(ws: Workspace, engine: str) -> tuple[str, bool]:
    """提示詞裡「整份文件」那一段，和整份文字是不是都在裡面。
    放得下：全文筆記（預讀寫的，有就帶）＋整份文字（本文和補充資料）。放不下：全文筆記＋全文地圖（每頁一行），相關頁由 prompt 另外找。"""
    brief = preread.text(ws)
    size = docmap.size(ws)
    has_all = 0 < size <= whole_budget(engine)
    parts = []
    if brief:
        parts.append("你之前把整份读完后写的全文笔记（每个部分讲什么、东西在哪一页；回答整体性的问题先看这里）：\n" + brief)  # i18n-ok
    if has_all:
        parts.append("整份文件的文字（按页，补充资料接在后面；公式和表格抽出来可能是乱的，以上下文为准）：\n" + docmap.full_text(ws, whole_budget(engine)))  # i18n-ok
    else:
        nav = docmap.outline(ws)
        if nav:
            parts.append("全文地图（每页在讲什么；问到别处时按页码去找）：\n" + nav)  # i18n-ok
    return ("\n\n" + "\n\n".join(parts)) if parts else "", has_all


# ---------- 流式输出 ----------
def stream(ecfg: dict, text: str, cwd: Path, cancel: threading.Event, on_model=None, meter=None, images=None, live=None,
           on_live=None) -> Iterator[str]:
    """on_model(实际模型名)：Claude Code 开头会报它实际用的模型。meter：传了就记下这次回答的 token 用量。
    images：這次附的圖片檔，直接放進訊息（舊版 Claude Code 退回讓它自己 Read，提示詞裡寫了路徑）。
    live：{"thread", "turns", "followup_text", "tools", "system"}——接著哪個對話問；模型行程還記著前面幾輪時只送 followup_text
    （見 claude_live / codex_live）。on_live()：Codex 真的在逐字串流時叫一下（頁面就不用提示「寫完才會一次顯示」）。"""
    e = ecfg.get("engine")
    images = list(images or [])
    live = dict(live or {})
    bad = netcheck.quick_problem(ecfg)  # 不等探测：每问一次都等 0.1–0.6 秒太慢，连不上时引擎自己会报
    if bad:
        raise engines.EngineError(bad)
    try:
        if e == "claude":
            yield from _stream_claude(ecfg["claude"], text, cwd, cancel, on_model, meter, images, live)
        elif e == "openai":
            yield from openai_api.stream(ecfg["openai"], text, cancel, meter, images)
        else:
            yield from _stream_codex(ecfg, text, cwd, cancel, meter, images, live, on_live)
    except engines.EngineError as err:
        msg = netcheck.explain(ecfg, str(err))
        if images and e == "openai" and tr("（這個模型可能不能看圖") not in msg:
            msg += "\n" + tr("（這個模型可能不能看圖：換一個能看圖的模型，或不附圖片再問）")
        raise engines.EngineError(msg) from None


def warm(ecfg: dict, cwd: Path, tools: str | None = "Read", system: str | None = None) -> None:
    """讀者打開面板、開始打字、選了字：先把模型行程拉起來，按送出時少等一秒（不連網、不花額度）。"""
    e = ecfg.get("engine")
    if e == "claude":
        claude_live.warm(ecfg["claude"], cwd, tools, system)
    elif e == "codex":
        codex_live.warm(engines.for_translation(ecfg)["codex"])


def bound_turns(ecfg: dict, ws: Workspace, thread: str | None) -> int | None:
    """這個對話的模型行程還活著、記著幾輪；沒有回 None（server 用它決定要不要只送追問）。"""
    e = ecfg.get("engine")
    if e == "claude":
        return claude_live.bound_turns(thread)
    if e == "codex":
        return codex_live.bound_turns(ws.id, thread, ecfg["codex"].get("model") or "", ws.root)
    return None


def _stream_codex(ecfg: dict, text: str, cwd: Path, cancel, meter, images, live: dict, on_live) -> Iterator[str]:
    """先走 app-server（逐字串流、記著對話）；起不來、或還沒出字就斷了，退回 codex exec 整段給。
    两条路都不拉起用户的 MCP 和用不到的功能（见 codex_lean）。"""
    lean = engines.for_translation(ecfg)
    if codex_live.enabled():
        got = False
        try:
            for piece in codex_live.stream(lean["codex"], text, cwd, cancel, meter, images, live.get("thread"), live.get("turns"),
                                           live.get("followup_text"), on_live):
                got = True
                yield piece
            return
        except codex_live.Unavailable as e:
            if got:
                raise
            log.warning("Codex app-server 用不了，这次改用 codex exec：%s", str(e)[-300:])
    yield engines.run(lean, text, cwd, images or None, cancel, meter)


def _stream_claude(c: dict, text: str, cwd: Path, cancel, on_model=None, meter=None, images=None, live=None) -> Iterator[str]:
    """先走常駐行程（claude_live：預先啟動、記著對話、圖直接附上）；這版 Claude Code 不認那些參數就退回一次性呼叫。
    一次性呼叫只给 Read 一个工具（--tools Read）：其余内置工具的定义每问一次都要发，约 2.7 万 token。
    这版 Claude Code 不认 --tools、还没输出任何字时，去掉它再问一次。"""
    live = dict(live or {})
    images = list(images or [])
    lean = True
    if claude_live.enabled():
        try:
            yield from _stream_live(c, text, cwd, cancel, on_model, meter, images, live)
            return
        except claude_live.Unsupported as e:
            log.warning("Claude Code 不认 --input-format stream-json，改用一次性调用：%s", str(e)[-300:])
            claude_live.disable()
            if images:  # 提示词是按“图在消息里”写的：补一句让它自己 Read
                text += _images_hint(images, "claude")
            lean = not (engines.option_unknown(e) and "--tools" in str(e))
    exe = engines.claude_path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 Claude Code 命令（先装好并登录 Claude Code）"))
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--allowedTools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    if c.get("model"):
        args += ["--model", c["model"]]
    if c.get("reasoning_effort"):
        args += ["--effort", c["reasoning_effort"]]
    if not lean:
        yield from _stream_once(args, text, cwd, cancel, on_model, meter)
        return
    said = []
    try:
        for piece in _stream_once(args + engines.CLAUDE_LEAN, text, cwd, cancel, on_model, meter):
            said.append(piece)
            yield piece
    except engines.EngineError as e:
        if said or not engines.option_unknown(e):
            raise
        log.warning("Claude Code 不认 --tools，照旧调用：%s", str(e)[-300:])
        yield from _stream_once(args, text, cwd, cancel, on_model, meter)


def _stream_live(c: dict, text: str, cwd: Path, cancel, on_model, meter, images: list, live: dict) -> Iterator[str]:
    """常駐行程：綁著這個對話、輪數對得上的就接著問（只送 followup_text）；否則拿預熱好的或現開一個，送完整提示詞。"""
    tools = live.get("tools", "Read")
    system = live.get("system")
    thread = live.get("thread")
    s = claude_live.acquire(c, cwd, tools, system, thread, live.get("turns"))
    follow = live.get("followup_text") if s.turns > 0 else None
    if s.model and on_model:
        on_model(s.model)  # 追問時 init 事件不會再來一次
    ok = False
    try:
        for piece in s.turn(claude_live.content(follow or text, images), cancel, on_model, meter):
            yield piece
        ok = True
    finally:
        claude_live.release(s, keep=ok and bool(thread))


def _stream_once(args: list[str], text: str, cwd: Path, cancel, on_model=None, meter=None) -> Iterator[str]:
    proc = engines._popen(args, cwd)
    proc.stdin.write(text)
    proc.stdin.close()
    done = threading.Event()

    def kill_on_cancel():
        while not done.wait(0.2):
            if cancel.is_set():
                if proc.poll() is None:
                    proc.kill()
                return

    threading.Thread(target=kill_on_cancel, daemon=True).start()
    got = False
    rate = None
    try:
        for line in proc.stdout:
            if cancel.is_set():
                raise engines.Cancelled()
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "system" and ev.get("subtype") == "init" and ev.get("model") and on_model:
                on_model(ev["model"])
            if ev.get("type") == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    got = True
                    yield d["text"]
            elif ev.get("type") == "rate_limit_event":
                rate = ev
            elif ev.get("type") == "result":
                if meter is not None:
                    meter.add(**usage.from_claude(ev, rate))
                if ev.get("is_error"):
                    raise engines.EngineError(tr("Claude Code 出错：{detail}", detail=str(ev.get("result") or ev.get("subtype"))))
                if not got and ev.get("result"):
                    yield ev["result"]
                return
        err = proc.stderr.read()[-400:]
        if not got:
            raise engines.EngineError(err or tr("Claude Code 没有输出"))
    finally:
        if proc.poll() is None:
            proc.kill()
        done.set()  # 让 kill_on_cancel 线程退出
