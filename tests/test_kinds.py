"""文件類型：自動判斷投影片、投影片／講義的提示詞、準備時記下類型。  python -m unittest tests.test_kinds"""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import kinds, prompts, prompts_en, translate
from easyread.store import write_json_atomic
from tests.test_translate import make_ws


class KindsTest(unittest.TestCase):
    def test_detect(self):
        with tempfile.TemporaryDirectory() as d:
            ex = Path(d)
            self.assertEqual(kinds.detect([{"n": 1, "w": 960, "h": 540}, {"n": 2, "w": 960, "h": 540}], ex), "slides")  # 橫向
            portrait = [{"n": n, "w": 612, "h": 792} for n in (1, 2)]
            (ex / "page-001.txt").write_text("Bayes Rule\n- prior\n- posterior", encoding="utf-8")
            (ex / "page-002.txt").write_text("Loss function\n- expected loss", encoding="utf-8")
            self.assertEqual(kinds.detect(portrait, ex), "slides")  # 每頁字很少
            for n in (1, 2):
                (ex / f"page-{n:03d}.txt").write_text("word " * 400, encoding="utf-8")
            self.assertEqual(kinds.detect(portrait, ex), "paper")
            self.assertEqual(kinds.detect([], ex), "paper")
        self.assertEqual(kinds.of({"kind": "notes"}), "notes")
        self.assertEqual(kinds.of({"kind": "junk"}), "paper")

    def test_slides_prompt(self):
        ws = make_ws(2)
        self.addCleanup(shutil.rmtree, ws.root, True)
        paper = ws.load("paper")
        paper["meta"].update(kind="slides", target="zh")
        write_json_atomic(ws.root / "paper.json", paper)
        text = prompts.translate(ws, [1], "text", "")
        self.assertIn("把一篇课程投影片译成中文，这次只处理第 1 页", text)
        self.assertIn("每一页是一张投影片", text)
        self.assertIs(prompts.rules("zh"), prompts.RULES)  # 論文照舊
        self.assertIn("每一頁是一張投影片", prompts.rules("zh-TW", "slides"))
        self.assertIn("定義、定理", prompts.rules("zh-TW", "notes"))
        self.assertIn("课程投影片的 PDF 整理成", prompts_en.structure(ws, [1], "text", ""))
        self.assertIn("每一页是一张投影片", prompts_en.fill(ws, [1], {"p1-1": "Hello"}))

    def test_prepare_records_kind_and_skips_lookup_for_slides(self):
        ws = make_ws(2)
        self.addCleanup(shutil.rmtree, ws.root, True)
        pages = [{"n": 1, "w": 960, "h": 540, "img": "pages/page-001.webp"}, {"n": 2, "w": 960, "h": 540, "img": "pages/page-002.webp"}]
        with mock.patch.object(translate.pdfwork, "prepare", lambda root: pages), \
                mock.patch.object(translate.sources, "enrich", side_effect=AssertionError("投影片不該查 arXiv")):
            translate.prepare(ws)
        self.assertEqual(ws.load("paper")["meta"]["kind"], "slides")
        paper = ws.load("paper")
        paper["meta"]["kind"] = "notes"  # 匯入時指定的不被自動判斷蓋掉
        write_json_atomic(ws.root / "paper.json", paper)
        with mock.patch.object(translate.pdfwork, "prepare", lambda root: pages), mock.patch.object(translate.sources, "enrich", lambda text, meta: {}):
            translate.prepare(ws)
        self.assertEqual(ws.load("paper")["meta"]["kind"], "notes")


if __name__ == "__main__":
    unittest.main()
