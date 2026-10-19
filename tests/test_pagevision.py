"""看圖讀頁（pagevision.py）：哪些頁要看圖、模型的回答怎麼拆成一頁一頁、讀出來的字怎麼疊到抽取的文字上。
python -m unittest tests.test_pagevision"""
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from easyread import config  # noqa: F401 —— 先載 config（模組之間有循環 import）
from easyread import docmap, pagevision, search
from easyread.store import Workspace


def _scan_pdf(path: Path, pages: int, same: bool = False):
    """每頁一張全頁的圖、沒有文字層（像掃描的講義、截圖貼成的作業）。same：每頁同一張圖（像投影片的底圖）。"""
    imgs = []
    for i in range(pages):
        im = Image.new("RGB", (850, 1100), "white")
        d = ImageDraw.Draw(im)
        d.text((80, 80 + (0 if same else i * 40)), "Problem 2-%d  Use the conditional densities" % (9 + (0 if same else i)), fill="black")
        imgs.append(im)
    imgs[0].save(path, "PDF", save_all=True, append_images=imgs[1:], resolution=100)


def _paper(root: Path, pages: int, same: bool = False) -> Path:
    root.mkdir(parents=True)
    _scan_pdf(root / "source.pdf", pages, same)
    (root / "paper.json").write_text(json.dumps({"meta": {"title_en": "HW3 problems", "page_count": pages}, "blocks": []}), encoding="utf-8")
    (root / "extract").mkdir()
    for n in range(1, pages + 1):
        (root / "extract" / f"page-{n:03d}.txt").write_text("", encoding="utf-8")
    return root


class PageVision(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_which_pages_need_to_be_looked_at(self):
        no = lambda **k: pagevision.needs_vision({"chars": 0, "cover": 0.0, "objs": 0, **k})  # noqa: E731
        self.assertTrue(no(chars=12, cover=0.9))      # 掃描、截圖：幾乎沒有字，整頁是圖
        self.assertTrue(no(chars=0, objs=40))         # 字型沒有對應表：抽出來沒有字，但頁面上畫了一堆東西
        self.assertTrue(no(chars=120, cover=0.4))     # 投影片：一個標題＋一大張圖
        self.assertTrue(no(chars=900, cover=0.8))     # 幾乎整頁是圖，只有幾行字
        self.assertFalse(no(chars=3000, cover=0.0))   # 一般的論文頁
        self.assertFalse(no(chars=1500, cover=0.3))   # 論文裡的一張圖：字很多，不用看
        self.assertFalse(no(chars=0, cover=0.0, objs=2))  # 空白頁

    def test_garbled_text_counts_as_no_text(self):
        junk = 'GIHKJLNMPO,QRSJTQR)C98U9VWEX4SY Z[]\\_^a`cb d0AeA8fCg8h.1Ei?@847698jlkmGLnLjnJporqTRMsRtJporGTkq/O,ouL,RMsv ' \
               'SOT9$1NUUWV>X9<B 5 9$FYZ;DXF2V[=NB\\5]V[=N;DY^B9= Ajik[lnmop>e g h A bc]ABaYe g h AqiknlnmP3?a'
        self.assertTrue(pagevision.garbled(junk))  # 字型沒有對應表抽出來的（L2 投影片的一頁）
        prose = ("Bayesian decision theory is a fundamental statistical approach to the problem of pattern classification. "
                 "It assumes the decision problem is posed in probabilistic terms, $P(\\omega_j|x) = p(x|\\omega_j)P(\\omega_j)/p(x)$, "
                 "and that all of the relevant probability values are known. def train(x, y): return model.fit(x, y)")
        self.assertFalse(pagevision.garbled(prose))  # 一般的英文（含公式、程式）
        self.assertFalse(pagevision.garbled("貝氏決策理論：在已知機率分布時，選擇後驗機率最大的類別。"))  # 中文
        self.assertFalse(pagevision.garbled("Xq Zk"))  # 字太少不判斷
        self.assertFalse(pagevision.garbled("ACGTTGCAAGCTTGCATGCCTGCAGGTCGACTCTAGAGGATCCCCGGGTACCGAGCTCGAATTCACTGGCCGTCGTTTTACAACG"))  # DNA 序列
        self.assertFalse(pagevision.garbled("PAGE1 " + "x" * 500))
        for other in ("Die Ergebnisse zeigen, dass das vorgeschlagene Verfahren die Klassifikationsgenauigkeit deutlich verbessert.",
                      "Les résultats montrent que la méthode proposée améliore nettement la précision de la classification.",
                      "Hasil penelitian menunjukkan bahwa metode yang diusulkan meningkatkan akurasi klasifikasi secara signifikan.",
                      "[12] K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image recognition. In CVPR, pages 770–778, 2016."):
            self.assertFalse(pagevision.garbled(other), other[:30])  # 別的語言、參考文獻
        self.assertTrue(pagevision.needs_vision({"chars": 900, "cover": 0.0, "objs": 3, "garbled": True}))
        root = _paper(self.tmp / "junk", 1)
        self.assertEqual(pagevision.overlay(root, 1, junk), "")  # 還沒看過：亂碼不給 AI、不進搜尋
        self.assertEqual(pagevision.overlay(root, 1, prose), prose)

    def test_formulas_whose_subscripts_came_out_as_indic_letters(self):
        # PowerPoint 的數學字型轉成 PDF：上下標被對到泰米爾、奧里亞文字（𝑎௜(௞) 是 a_i^(k)、𝑛௞ିଵ 是 n_{k-1}）
        slide = "Neuron\n𝑎௜\n(௞) Σ\n𝑎ଵ\n(௞ିଵ)\n𝑧௜\n(௞)\nThere are 𝑛௞ିଵ neurons in the previous layer = 𝑓 ௞ 𝑾௜"
        self.assertTrue(pagevision.misfont(slide))
        self.assertFalse(pagevision.garbled(slide))  # 一般的字是好的：不是整頁亂碼
        self.assertTrue(pagevision.misfont("Probability of an Event\n• 𝑃 ∅ = 0\n• 𝑃 𝐴 ∩ 𝐵ത = 𝑃 𝐴 − 𝑃 𝐴 ∩ 𝐵"))  # 一個就算：ത 是上橫線
        self.assertFalse(pagevision.misfont("𝑃(𝐴|𝐵) = 𝑃(𝐴 ∩ 𝐵)/𝑃(𝐵)"))  # 公式好好的
        self.assertFalse(pagevision.misfont("प्रायिकता सिद्धांत में घटनाओं की संभावना का अध्ययन किया जाता है, जैसे 𝑃(𝐴) और 𝑃(𝐵)।"))  # 真的印地文
        self.assertFalse(pagevision.misfont("நிகழ்தகவு கோட்பாட்டில் நிகழ்வுகளின் வாய்ப்பு படிக்கப்படுகிறது"))  # 真的泰米爾文、沒有公式
        root = _paper(self.tmp / "slides", 1)
        self.assertEqual(pagevision.overlay(root, 1, slide), slide)  # 還沒看過圖：標題、句子照樣給（只有公式要看圖）

    def test_background_reading_is_one_at_a_time_and_not_fast(self):
        root = _paper(self.tmp / "bgread", 3)
        calls = []
        keep = pagevision.read, pagevision.vision_cfg
        pagevision.vision_cfg = lambda model=None: {"engine": "codex", "codex": {"service_tier": "fast"}}
        pagevision.read = lambda r, pages, ecfg, cancel=None, **k: calls.append((pages, ecfg["codex"]["service_tier"])) or len(pages)
        try:
            self.assertEqual(pagevision.read_all(root), 3)
            self.assertEqual(calls, [([1, 2, 3], "default")])  # 背景不搶 Fast
            self.assertEqual(pagevision.read_all(root, limit=2), 0)  # 圖片頁太多：等讀者問到再看
            self.assertFalse(pagevision.busy(root))
        finally:
            pagevision.read, pagevision.vision_cfg = keep

    def test_a_scanned_pdf_is_flagged_but_a_repeated_background_is_not(self):
        scanned = _paper(self.tmp / "scan1", 3)
        self.assertEqual(pagevision.scan(scanned), [1, 2, 3])  # 每頁一張全頁圖（內容不一樣）：都要看
        bg = _paper(self.tmp / "bg1", 4, same=True)
        self.assertEqual(pagevision.scan(bg), [])  # 每頁同一張圖在同一個位置：是底圖，不算內容

    def test_the_answer_is_split_per_page_and_overlays_the_extracted_text(self):
        got = pagevision.parse("前言\n=== 第 2 頁 ===\nProblem 2-9\n$P(error)=\\frac12$\n=== 第 3 頁 ===\nProblem 2-12\n=== 第 9 頁 ===\n不在要的頁裡", [2, 3])
        self.assertEqual(got, {2: "Problem 2-9\n$P(error)=\\frac12$", 3: "Problem 2-12"})
        self.assertEqual(pagevision.parse("只有一頁、沒照格式", [5]), {5: "只有一頁、沒照格式"})
        root = _paper(self.tmp / "hw", 3)
        pagevision._save(root, lambda d: d.setdefault("pages", {}).update({"2": "Problem 2-9 Use the conditional densities"}))
        ws = Workspace(root)
        texts = docmap.page_texts(ws)
        self.assertEqual(texts[1], "Problem 2-9 Use the conditional densities")  # 看過的頁：問 AI、預讀用讀出來的字
        self.assertEqual(texts[0], "")
        self.assertEqual(pagevision.missing(root), [1, 3])
        self.assertIn(2, [n for n, _s, _f in search._paper_pages(root)])  # 全文搜尋也找得到

    def test_a_replaced_pdf_forgets_what_was_read(self):
        root = _paper(self.tmp / "re", 2)
        pagevision._save(root, lambda d: d.setdefault("pages", {}).update({"1": "舊的"}))
        self.assertEqual(pagevision.text(root, 1), "舊的")
        _scan_pdf(root / "source.pdf", 2)  # 換了一份 PDF（內容不同）
        with open(root / "source.pdf", "ab") as f:
            f.write(b"\n% changed\n")
        self.assertEqual(pagevision.text(root, 1), "")

    def test_pages_wanted_for_a_question(self):
        root = _paper(self.tmp / "many", 3)
        self.assertEqual(pagevision.wanted(root, 1, "這題怎麼做"), [1, 2, 3])  # 不多：整份都看
        pagevision.NOW_PAGES, keep = 1, pagevision.NOW_PAGES
        try:
            self.assertEqual(pagevision.wanted(root, 3, "看第 1 頁"), [1, 2, 3])  # 多的話：正在看的那頁前後＋問題裡提到的
        finally:
            pagevision.NOW_PAGES = keep


if __name__ == "__main__":
    unittest.main()
