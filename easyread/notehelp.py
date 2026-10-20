"""论文笔记的 AI 帮手：点评、帮我改、起草稿；还有“帮这一页写笔记”（mode = page）。

和“问 AI”对话分开：结果直接流回笔记面板，不进对话记录；由读者决定要不要替换或追加到笔记里。
输出格式和对话一样：一行一个 JSON，{"t": 片段} … 最后 {"done": true} 或 {"error": …}。
"""
from __future__ import annotations

import json
import re
import threading

from . import kinds, langs, tw
from . import chat, chat_models, config, engines, pdfwork, webimg, webtools
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


def _tone(code: str) -> str:
    """用詞和語氣（和問 AI 同一段，chat.tone）：筆記也要是人平常會講的話、台灣的用詞。提示詞其餘部分是簡體時這段也給簡體。"""
    text = chat.tone(code)
    return "\n" + (text if tw.is_tw(code) else tw.to_cn(text))


def _figures() -> str:
    """筆記 AI 要畫圖時的寫法（和問 AI 同一段，chat.figures）：筆記頁一樣會把這幾種區塊畫成真的圖。沒要它畫就不畫——筆記是讀者自己的。"""
    return ("\n只有他要你畫圖、或他選的那一段本來就有圖時才畫；畫的時候照下面的寫法（不要用文字或符號拼）。\n"  # i18n-ok 提示詞
            + chat.figures(webimg.enabled()))


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
    parts = [f"你在陪读者读一篇{noun}《{title}》。用{langs.reply_lang(meta)}。\n{PAGE_ASK}" + _tone(langs.reply_code(meta))]  # i18n-ok
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


# 筆記 AI（閱讀頁筆記面板最下面那一欄，見 web/js/reader/notes-ai.js）：
# edit＝讀者選了筆記裡的幾塊，說要怎麼改，只回改好的那幾塊；write＝沒選，照要求寫一段新的，接在筆記最後（或指定的那一塊後面）。
# 回的是 Markdown 本身，頁面先當「建議」預覽，讀者按採用才換上。
EDIT_ASK = (
    "讀者在寫這份文件的筆記，選了其中一段，要你照他的要求改。下面有整份筆記（看上下文和他的寫法）、選中的那一段、他的要求，"  # i18n-ok 提示詞
    "還有文件本身的內容（要補充、查證時以它為準）。\n"  # i18n-ok 提示詞
    "只輸出改好的那一段：Markdown，和筆記其他部分同一種寫法（標題層級、清單、行內 $TeX$），不要解釋、不要客套、不要加「以下是…」；"  # i18n-ok 提示詞
    "他沒要求動的內容照原樣保留（含他自己的措辭）；要刪的就不要輸出。\n"  # i18n-ok 提示詞
)
WRITE_ASK = (
    "讀者在寫這份文件的筆記，要你照他的要求寫一段新的內容，接在他指定的位置。下面有整份筆記（看他寫到哪、他的寫法、別重複寫過的）、"  # i18n-ok 提示詞
    "他的要求，還有文件本身的內容（以它為準，不要編造）。\n"  # i18n-ok 提示詞
    "只輸出要加進去的那一段：Markdown，和筆記其他部分同一種寫法（標題層級、清單、行內 $TeX$），簡潔、具體，不要解釋、不要客套。\n"  # i18n-ok 提示詞
)
NOTE_BUDGET = 16000  # 整份筆記最多帶幾個字

# 筆記 AI 照讀者的話改筆記（auto，閱讀頁的筆記面板和獨立筆記都用；web/js/common/note-ai.js 套用）：
# 整份筆記一塊一塊編號給模型，連同讀者選了哪幾塊、反白了哪些字、游標在哪一塊。模型先用筆記裡的操作名稱說它理解成要做什麼
# （「@@ do: 整理；轉成待辦」），再用 @@ 開頭的指令說要換掉、插入、刪掉、搬動哪幾塊。頁面先當「AI 的建議」預覽，讀者按採用才換上。
OPS = (
    "筆記編輯器的操作（讀者會用這些名稱說要做什麼，你回報時也用這些名稱）和它認得的 Markdown 寫法：\n"  # i18n-ok 提示詞
    "- 區塊種類（轉成…）：內文（一般段落）、大標題「# 」、副標題「## 」、標題「### 」、項目清單「- 」、編號清單「1. 」、"  # i18n-ok 提示詞
    "待辦「- [ ] 」（做完的「- [x] 」）、收合「> [!toggle] 標題」（內容接在下面的「> 」行）、引用「> 」、"  # i18n-ok 提示詞
    "說明框「> [!note] 標題」、訣竅框「> [!tip] 標題」、警示框「> [!warn] 標題」、分隔線「---」、程式碼（```語言 … ```）、"  # i18n-ok 提示詞
    "公式（獨立一段的 $$ … $$）、表格（| 欄 | 欄 |）、流程圖（```mermaid … ```）。清單縮排一層是兩個空格。\n"  # i18n-ok 提示詞
    "- 文字的標記：粗體 **字**、斜體 *字*、底線 ++字++、刪除線 ~~字~~、螢光 ==字==、行內程式碼 `字`、行內公式 $TeX$、連結 [字](網址)。\n"  # i18n-ok 提示詞
    "- 其他：整理（只動排版：分段、加簡短的小標題、並列的改成清單、有先後的改成編號清單、要做的事改成待辦、適合對照的排成表格，字句一個都不改）、"  # i18n-ok 提示詞
    "改寫、改短、補充說明、改成表格、查核、翻譯、上移、下移、移到最上面、移到最下面、縮排、取消縮排、刪除、複製一份、寫一段新的。\n"  # i18n-ok 提示詞
    "- 圖片「![…](…)」、出處卡「> [!ref …]」、@ 提到的連結照原樣保留（不要改寫、不要刪），除非讀者要你動它們。"  # i18n-ok 提示詞
)
AUTO_ASK = (
    "讀者在寫筆記，要你照他的話改。下面是整份筆記，一塊一塊編了號（[1]、[2]…；一塊就是一段 Markdown）。\n"  # i18n-ok 提示詞
    "先想清楚他要的是哪一種操作（對到下面列的名稱）、要動哪幾塊：他選了幾塊就只動那幾塊；他反白了一些字，就是那一塊裡的那幾個字；"  # i18n-ok 提示詞
    "他說「整份」「全部」「整篇」，或什麼都沒選、要的又是排版、整理這一類，就是整份筆記；他用位置或內容指出來的"  # i18n-ok 提示詞
    "（「第二個標題下面的清單」「講梯度的那一段」），就找出是哪幾塊；只是要寫新的內容，就寫在他游標那一塊後面（沒有游標就接在最後）。\n"  # i18n-ok 提示詞
    "他沒要求動的字句、數字、公式、頁碼、連結一個都不能改（包括他自己的措辭）；不要加他沒要的內容，不要客套、不要解釋。\n"  # i18n-ok 提示詞
)
AUTO_FORMAT = (
    "回覆一定照這個格式，不要多說別的話：\n"  # i18n-ok 提示詞
    "第一行：「@@ do: 」接你理解成的操作，用上面的名稱，一到三個，用「；」隔開，例如「@@ do: 整理」「@@ do: 轉成待辦；粗體」。\n"  # i18n-ok 提示詞
    "接著是一段或幾段修改。每段先一行指令，下一行起是那一段的 Markdown（刪除、搬動不用寫內容）：\n"  # i18n-ok 提示詞
    "@@ replace A-B　把第 A 到第 B 塊換成下面的內容（只有一塊就寫 @@ replace A）\n"  # i18n-ok 提示詞
    "@@ insert after N　在第 N 塊後面加上下面的內容（N 是 0 表示放在最前面）\n"  # i18n-ok 提示詞
    "@@ delete A-B　刪掉第 A 到第 B 塊\n"  # i18n-ok 提示詞
    "@@ move A-B after N　把第 A 到第 B 塊原封不動搬到第 N 塊後面\n"  # i18n-ok 提示詞
    "編號都是上面整份筆記的編號；幾段修改不要重疊；沒有要動的塊不要輸出。"  # i18n-ok 提示詞
)
AUTO_BUDGET = 24000  # 整份筆記帶全文的字數上限；超過時，沒選到、游標也不在的塊只給開頭


def _numbered(blocks: list[str], keep: set[int]) -> str:
    """[1]、[2]… 一塊一塊列出來。太長時，keep（選到的、游標在的）以外的長塊只給開頭——編號不變，模型也知道那幾塊不能改。"""
    long = sum(len(b) for b in blocks) > AUTO_BUDGET
    out = []
    for i, b in enumerate(blocks):
        if long and i not in keep and len(b) > 160:
            b = b[:120].rstrip() + "…（後面略過：這一塊沒有給全文，不要改它）"  # i18n-ok 提示詞
        out.append(f"[{i + 1}]\n{b}")
    return "\n".join(out)


def _conv(code: str):
    """FOLI 自己寫的說明照回答的語言轉（簡體／繁體）；讀者的筆記、反白的字、要求、回答原樣給，不經過轉換器（轉換器會動到用字）。"""
    return lambda text: localize(text if tw.is_tw(code) else tw.to_cn(text), code)


def _auto_parts(body: dict, conv) -> tuple[list[str], str]:
    """筆記（編號）、讀者選了哪裡、要求。回傳（幾段提示詞, 要求）——模板用 conv 轉，讀者的內容原樣放進去。"""
    blocks = [str(b)[:20000] for b in (body.get("blocks") or [])][:600]
    n = len(blocks)
    sc = body.get("scope") if isinstance(body.get("scope"), dict) else {}
    try:
        a, b = int(sc.get("from")), int(sc.get("to"))
        if not (0 <= a <= b < n):
            a = b = None
    except (TypeError, ValueError):
        a = b = None
    cur = body.get("cursor")
    cur = cur if isinstance(cur, int) and 0 <= cur < n else None
    picked = re.sub(r"\s+", " ", str(body.get("picked") or "")).strip()[:600]
    keep = set(range(a, b + 1)) if a is not None else set()
    if cur is not None:
        keep.add(cur)
    where = []
    if a is not None:
        where.append(conv(f"讀者選了第 {a + 1} 塊。" if a == b else f"讀者選了第 {a + 1}–{b + 1} 塊。"))  # i18n-ok 提示詞
    elif cur is not None:
        where.append(conv(f"讀者的游標在第 {cur + 1} 塊。"))  # i18n-ok 提示詞
    if picked:
        where.append(conv("他反白了這些字：") + "「" + picked + "」")  # i18n-ok 提示詞
    notes = _numbered(blocks, keep) if blocks else conv("（還是空的，一塊都沒有）")  # i18n-ok 提示詞
    if blocks and sum(len(x) for x in blocks) > AUTO_BUDGET:  # 略過的那幾塊的說明也照語言轉
        notes = notes.replace("…（後面略過：這一塊沒有給全文，不要改它）", conv("…（後面略過：這一塊沒有給全文，不要改它）"))  # i18n-ok 提示詞
    parts = [conv("讀者的整份筆記（一塊一塊編了號）：") + "\n<<<\n" + notes + "\n>>>",  # i18n-ok 提示詞
             "".join(where) or conv("他沒有選任何地方，游標也不在筆記裡。")]  # i18n-ok 提示詞
    ask = str(body.get("ask") or "").strip() or conv("把這份筆記排得更好讀")  # i18n-ok 提示詞
    return parts, ask


def auto_prompt(ws: Workspace, body: dict, engine: str) -> str:
    """閱讀頁筆記面板（本頁、總結）的筆記 AI：照讀者的話改筆記。文件本身的內容一起給（補充、查核要用）。"""
    from . import docmap, preread
    meta = ws.load("paper").get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or ""
    code = langs.reply_code(meta)
    conv = _conv(code)
    head = f"你在幫讀者寫《{title}》的筆記。用{langs.reply_lang(meta)}。" + AUTO_ASK + "要補充、查核時以文件本身的內容為準，不要編造。" + _tone(code) + _figures()  # i18n-ok 提示詞
    parts = [head, OPS, AUTO_FORMAT]
    notes, ask = _auto_parts(body, conv)
    brief = preread.text(ws, budget=6000)
    if brief:
        parts.append("這份文件的全文筆記（AI 之前讀完整份寫的，每個部分講什麼、東西在哪一頁）：\n" + brief)  # i18n-ok 提示詞
    near = docmap.nearby(ws, ask + " " + str(body.get("picked") or "")[:400], skip=(), k=3, per=2400)
    if near:
        parts.append("文件裡和這次要求最相關的幾頁（抽取的文字，公式和表格可能是亂的）：\n" + near)  # i18n-ok 提示詞
    try:
        page = int(body.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    if page:
        parts.append(f"讀者現在在第 {page} 頁，這一頁的文字：\n" + chat._page_text(ws, page)[:5000])  # i18n-ok 提示詞
    return "\n\n".join([conv("\n\n".join(parts))] + notes + [conv("讀者的要求：") + ask])  # i18n-ok 提示詞


# 回答收進筆記（asnote）：問 AI 的回答、提問紀錄、外部 AI 的回答「存成筆記」時，先改寫成筆記的樣子——不是一則回答
ASNOTE_ASK = (
    "讀者要把一段 AI 的回答收進自己的筆記。把它改寫成筆記，不是回答：\n"  # i18n-ok 提示詞
    "- 第一行是「### 」加上這則筆記的主題：幾個字的名詞片語，不是問句，也不要照抄問題。\n"  # i18n-ok 提示詞
    "- 接著第一句直接寫重點（結論），後面用條列；有先後的步驟用編號清單，適合對照的排成表格，關鍵詞用粗體；內容多的可以用「#### 」分成兩三小段。\n"  # i18n-ok 提示詞
    "- 拿掉回答的口吻：開場白（「好問題」「簡單來說」「我們來看看」）、結語和追問（「希望有幫助」「如果你想…我可以…」），"  # i18n-ok 提示詞
    "還有對讀者說話的「你」「我」「我們」。寫成讀者自己記下來的重點。\n"  # i18n-ok 提示詞
    "- 只根據這段回答，不要加新的內容；重要的條件、例外、具體的例子要留著。公式（$…$、$$…$$）、數字、頁碼（第 N 頁）、"  # i18n-ok 提示詞
    "程式碼、圖（```pic、```flow、```viz、```mermaid 這些區塊）原樣保留。\n"  # i18n-ok 提示詞
    "- 篇幅大約是原本的一半到三分之二（原本就很短的就差不多長）。只輸出筆記本身（Markdown），不要包在 ``` 裡。"  # i18n-ok 提示詞
)
ASNOTE_BUDGET = 30000  # 回答最多帶幾個字


def asnote_prompt(meta: dict | None, body: dict) -> str:
    """meta：文件的 meta（決定用什麼語言寫、標題）；獨立筆記、沒有文件時給 None。"""
    meta = meta or {}
    title = meta.get("title_zh") or meta.get("title_en") or ""
    code = langs.reply_code(meta)
    question = re.sub(r"\s+", " ", str(body.get("question") or "")).strip()[:1500]
    answer = str(body.get("answer") or "").strip()[:ASNOTE_BUDGET]
    conv = _conv(code)
    parts = [conv((f"讀者在讀《{title}》。" if title else "") + f"用{langs.reply_lang(meta)}寫。" + ASNOTE_ASK + _tone(code))]  # i18n-ok 提示詞
    if question:
        parts.append(conv("讀者原本問的是（只用來知道重點在哪，不要寫成問句）：") + question)  # i18n-ok 提示詞
    parts.append(conv("那段回答：") + "\n<<<\n" + answer + "\n>>>")  # i18n-ok 提示詞
    return "\n\n".join(parts)


def edit_prompt(ws: Workspace, body: dict, engine: str) -> str:
    from . import docmap, preread
    meta = ws.load("paper").get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or ""
    mode = body.get("mode")
    note = str(body.get("note") or "")
    selection = str(body.get("selection") or "")
    ask = str(body.get("ask") or "").strip()
    if len(note) > NOTE_BUDGET:
        note = note[:NOTE_BUDGET // 2] + "\n…（中間略）…\n" + note[-NOTE_BUDGET // 2:]  # i18n-ok 提示詞
    parts = [f"你在幫讀者寫《{title}》的筆記。用{langs.reply_lang(meta)}。" + (EDIT_ASK if mode == "edit" else WRITE_ASK) + _tone(langs.reply_code(meta)) + _figures()]  # i18n-ok 提示詞
    brief = preread.text(ws, budget=6000)
    if brief:
        parts.append("這份文件的全文筆記（AI 之前讀完整份寫的，每個部分講什麼、東西在哪一頁）：\n" + brief)  # i18n-ok 提示詞
    near = docmap.nearby(ws, ask + " " + selection[:400], skip=(), k=3, per=2400)
    if near:
        parts.append("文件裡和這次要求最相關的幾頁（抽取的文字，公式和表格可能是亂的）：\n" + near)  # i18n-ok 提示詞
    try:
        page = int(body.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    if page:
        parts.append(f"讀者現在在第 {page} 頁，這一頁的文字：\n" + chat._page_text(ws, page)[:5000])  # i18n-ok 提示詞
    parts.append("讀者的整份筆記：\n<<<\n" + (note.strip() or "（還是空的）") + "\n>>>")  # i18n-ok 提示詞
    if mode == "edit":
        parts.append("讀者選中、要你改的那一段：\n<<<\n" + selection + "\n>>>")  # i18n-ok 提示詞
    elif selection:
        parts.append("要接在這一段後面：\n<<<\n" + selection + "\n>>>")  # i18n-ok 提示詞
    parts.append("讀者的要求：" + (ask or ("把這一段寫得更清楚、更好讀" if mode == "edit" else "接著寫下一段")))  # i18n-ok 提示詞
    text = "\n\n".join(parts)
    code = langs.reply_code(meta)
    return localize(text if tw.is_tw(code) else tw.to_cn(text), code)


def prompt(ws: Workspace, mode: str, note: str, engine: str) -> str:
    meta = ws.load("paper").get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or ""
    paper = ("论文全文在当前目录的 paper.json 里（blocks 里是译文和原文），需要核对时用 Read 工具去读。"  # i18n-ok 提示词
             if engine == "claude" else "论文译文（节选）：\n" + _paper_text(ws))  # i18n-ok
    text = (f"你在帮读者整理读论文《{title}》的笔记。用{langs.reply_lang(meta)}。{ASK[mode]}{_tone(langs.reply_code(meta))}\n\n{paper}\n\n"  # i18n-ok
            + (f"读者的笔记：\n<<<\n{note}\n>>>" if note.strip() else ""))  # i18n-ok
    return localize(text, langs.reply_code(meta))


def handle(handler, ws: Workspace, body: dict) -> None:
    """server.py 里 POST /api/p/<id>/notehelp 调这里；handler 是那次请求的 BaseHTTPRequestHandler。"""
    mode = body.get("mode")
    note = str(body.get("note") or "")[:20000]
    if mode not in ("page", "edit", "write", "auto", "asnote") and mode not in ASK:
        raise ValueError(tr("mode 只能是 review / revise / draft"))
    if mode in ("review", "revise") and not note.strip():
        raise ValueError(tr("笔记还是空的"))
    if mode == "edit" and not str(body.get("selection") or "").strip():
        raise ValueError(tr("先選要改的那幾塊"))
    _check(mode, body)
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
    elif mode in ("edit", "write"):
        text = edit_prompt(ws, body, ecfg["engine"])
    elif mode == "auto":
        text = auto_prompt(ws, body, ecfg["engine"])
    elif mode == "asnote":
        text = asnote_prompt(ws.load("paper").get("meta"), body)
    else:
        text = prompt(ws, mode, note, ecfg["engine"])
    web = mode in ("edit", "write", "auto") and _web(body, ecfg)  # 筆記 AI 照讀者的要求寫、改時可以上網查（幫這頁寫筆記、點評、收成筆記不用）
    if web:
        text = localize_web(text, langs.reply_code(ws.load("paper").get("meta")))
    return _stream(handler, ecfg, m, text, ws.root, images, langs.reply_code(ws.load("paper").get("meta")), web)


def _check(mode: str, body: dict) -> None:
    """auto 要有編好號的筆記（可以是空的）和要求；asnote 要有回答。"""
    if mode == "auto":
        if not isinstance(body.get("blocks"), list) or len(body["blocks"]) > 600:
            raise ValueError(tr("blocks 要是筆記一塊一塊的 Markdown（最多 600 塊）"))
        if not str(body.get("ask") or "").strip():
            raise ValueError(tr("先說要怎麼改"))
    if mode == "asnote" and not str(body.get("answer") or "").strip():
        raise ValueError(tr("沒有要收進筆記的回答"))


def _web(body: dict, ecfg: dict) -> bool:
    """頁面上那顆地球（和問 AI 共用）；沒帶就照設定。模型不能上網的當成沒開。"""
    return (bool(body["web"]) if "web" in body else webtools.enabled_default()) and webtools.supported(ecfg)


def localize_web(text: str, code: str) -> str:
    """上網那一段接在提示詞最後（照回答的語言）。"""
    part = webtools.PROMPT if tw.is_tw(code) else tw.to_cn(webtools.PROMPT)
    return text + "\n\n" + part


def _stream(handler, ecfg: dict, m: dict, text: str, cwd, images, code: str, web: bool = False) -> None:
    """把模型的回答一行一個 JSON 流給頁面：{"model"} {"t": 片段}… {"done": true} 或 {"error"}。"""
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True
    cancel = threading.Event()
    watching = chat.cancel_when_gone(handler, cancel)  # 讀者按停止：馬上知道

    def send(obj):
        handler.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        handler.wfile.flush()
    try:
        send({"model": chat_models.label(m)})
        guard = tw.Stream(tw.is_tw(code))  # 繁體保險
        for piece in chat.stream(ecfg, text, cwd, cancel, images=images, web=web, on_status=lambda st: send({"status": st})):
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
        log.exception("笔记帮手出错 %s", cwd)
        try:
            send({"error": str(e)[:500]})
        except OSError:
            pass
    finally:
        watching()


# ---------- 獨立筆記（notes.py）的 AI：沒有文件可以對照，只看筆記本身 ----------
def note_auto_prompt(note: dict, body: dict) -> str:
    """獨立筆記的筆記 AI：照讀者的話改筆記（沒有文件可以對照，只看筆記本身）。"""
    code = langs.reply_code(None)
    conv = _conv(code)
    head = f"你在幫讀者寫一份筆記《{str(note.get('title') or '')}》。用{langs.reply_lang(None)}。" + AUTO_ASK + _tone(code) + _figures()  # i18n-ok 提示詞
    parts, ask = _auto_parts(body, conv)
    return "\n\n".join([conv("\n\n".join([head, OPS, AUTO_FORMAT]))] + parts + [conv("讀者的要求：") + ask])  # i18n-ok 提示詞


def note_prompt(note: dict, body: dict) -> str:
    mode = body.get("mode")
    md = str(body.get("note") if body.get("note") is not None else note.get("body") or "")
    selection = str(body.get("selection") or "")
    ask = str(body.get("ask") or "").strip()
    if len(md) > NOTE_BUDGET:
        md = md[:NOTE_BUDGET // 2] + "\n…（中間略）…\n" + md[-NOTE_BUDGET // 2:]  # i18n-ok 提示詞
    title = str(note.get("title") or "")
    parts = [f"你在幫讀者寫一份筆記《{title}》。用{langs.reply_lang(None)}。" + (EDIT_ASK if mode == "edit" else WRITE_ASK).replace("，還有文件本身的內容（要補充、查證時以它為準）", "").replace("，還有文件本身的內容（以它為準，不要編造）", "") + _tone(langs.reply_code(None)) + _figures()]  # i18n-ok 提示詞
    parts.append("讀者的整份筆記：\n<<<\n" + (md.strip() or "（還是空的）") + "\n>>>")  # i18n-ok 提示詞
    if mode == "edit":
        parts.append("讀者選中、要你改的那一段：\n<<<\n" + selection + "\n>>>")  # i18n-ok 提示詞
    elif selection:
        parts.append("要接在這一段後面：\n<<<\n" + selection + "\n>>>")  # i18n-ok 提示詞
    parts.append("讀者的要求：" + (ask or ("把這一段寫得更清楚、更好讀" if mode == "edit" else "接著寫下一段")))  # i18n-ok 提示詞
    text = "\n\n".join(parts)
    code = langs.reply_code(None)
    return localize(text if tw.is_tw(code) else tw.to_cn(text), code)


def handle_note(handler, body: dict, note: dict, cwd) -> None:
    mode = body.get("mode")
    if mode not in ("edit", "write", "auto", "asnote"):
        raise ValueError(tr("mode 只能是 edit / write / auto"))
    if mode == "edit" and not str(body.get("selection") or "").strip():
        raise ValueError(tr("先選要改的那幾塊"))
    _check(mode, body)
    ecfg, m = chat_models.engine_cfg(config.load(), body.get("model"))
    web = mode != "asnote" and _web(body, ecfg)
    text = note_auto_prompt(note, body) if mode == "auto" else asnote_prompt(None, body) if mode == "asnote" else note_prompt(note, body)
    return _stream(handler, ecfg, m, localize_web(text, langs.reply_code(None)) if web else text, cwd, [], langs.reply_code(None), web)
