"""文件類型：論文（paper）、投影片（slides）、講義／教材（notes）。

存在 paper.json 的 meta.kind。匯入時可以指定；沒指定就在準備好頁面後自動判斷（横向頁或每頁字很少 → 投影片）。
類型決定提示詞怎麼說（投影片一頁一張、不找摘要和參考文獻）、要不要去查 arXiv／DOI、文獻庫列表上的標記。
"""
from __future__ import annotations

from pathlib import Path

KINDS = ("paper", "slides", "notes")
DEFAULT = "paper"
# 代碼 → (介面名, 提示詞裡怎麼稱呼這份文件, 英文名)
NAMES = {
    "paper": ("論文", "学术论文", "paper"),  # i18n-ok 提示詞
    "slides": ("投影片", "课程投影片", "slides"),  # i18n-ok
    "notes": ("講義", "课程讲义（教材）", "lecture notes"),  # i18n-ok
}
SLIDE_MAX_CHARS = 1200  # 每頁平均字元數少於這個，多半是投影片


def valid(kind) -> str | None:
    return kind if kind in KINDS else None


def of(meta: dict | None) -> str:
    return valid((meta or {}).get("kind")) or DEFAULT


def noun(kind: str | None) -> str:
    """提示詞裡的稱呼（簡體；繁體目標時整段提示詞會再轉）。"""
    return NAMES.get(kind or DEFAULT, NAMES[DEFAULT])[1]


def detect(pages: list[dict], extract_dir: Path) -> str:
    """横向頁佔多數，或每頁平均字很少 → 投影片；其餘當論文（講義只能手動選）。"""
    if not pages:
        return DEFAULT
    landscape = sum(1 for p in pages if (p.get("w") or 0) > (p.get("h") or 0))
    if landscape * 2 > len(pages):
        return "slides"
    total, counted = 0, 0
    for p in pages[:30]:
        f = extract_dir / f"page-{p['n']:03d}.txt"
        if f.exists():
            total += len(f.read_text(encoding="utf-8", errors="replace").split())
            counted += 1
    # 以詞數估：英文一頁 1200 字元約 200 詞；中文沒有空格，詞數偏低，所以再看字元
    if counted and total / counted < SLIDE_MAX_CHARS / 6:
        chars = sum(len(f.read_text(encoding="utf-8", errors="replace")) for f in (extract_dir / f"page-{p['n']:03d}.txt" for p in pages[:30]) if f.exists())
        if chars / counted < SLIDE_MAX_CHARS:
            return "slides"
    return DEFAULT


# ---------- 提示詞 ----------
# 翻譯和只讀原文共用：投影片一頁一張，講義按章節；都不要頁眉頁腳
RULES = {
    "slides": """- 这是课程投影片：每一页是一张投影片。每页先输出一个 heading 块（level 1，num 写页码，en / zh 是这张投影片的标题；没有标题就写“第 N 页”），再输出这页的内容：条列用 list 块（保持条列，不要合并成段落；子项目并入上一项，用“—”分隔），讲解文字用 para 块，公式用 math 块，图用 figure 块，表用 table 块。
- 不要找摘要、作者、机构、arXiv、参考文献；meta 只在第 1 页时填 title_en（课程或讲义名称）和 title_zh。页眉、页脚、课程代码、版权声明、页码不要输出。
- 讲者的备注、图里的标注文字也要译（放 image_zh）。""",
    "notes": """- 这是课程讲义或教材，不是论文：没有摘要和参考文献的格式要求，按原文的章节层级输出 heading（有编号就写 num）。
- 定义、定理、引理、例题、习题保留原文的标示和编号（如“定义 2.1”“定理 3”“例 4”），内容照译；证明结束的 □ 保留。
- 页眉、页脚、页码不要输出；习题答案和脚注照原文位置输出。""",
}


def rules(kind: str | None) -> str:
    return RULES.get(kind or DEFAULT, "")
