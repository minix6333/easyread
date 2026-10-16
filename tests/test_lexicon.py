"""術語與符號表（lexicon.py）：AI 回答怎麼收、存的格式、問 AI 的提示詞帶著它。  python -m unittest tests.test_lexicon"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from easyread import config  # noqa: F401 —— 先載 config
from easyread import chat, lexicon
from easyread.library import Library


class Lexicon(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_LIBRARY"] = str(self.tmp)
        d = self.tmp / "aaaa1111"
        (d / "extract").mkdir(parents=True)
        (d / "paper.json").write_text(json.dumps({"meta": {"title_en": "Sampling", "page_count": 2, "target": "zh-TW"}, "blocks": []}), encoding="utf-8")
        (d / "extract" / "page-001.txt").write_text("We define projection sampling as ...", encoding="utf-8")
        (d / "extract" / "page-002.txt").write_text("Let kappa_C denote the proposal.", encoding="utf-8")
        self.ws = Library(self.tmp).ws("aaaa1111")

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)

    def test_parse_keeps_good_items_only(self):
        raw = '```json\n[{"t": "projection  sampling", "k": "term", "def": "一种采样方法", "page": 1, "quote": "We define projection sampling"},' \
              '{"t": "\\\\kappa_C", "k": "symbol", "def": "提議分佈", "page": 7}, {"t": "Projection Sampling", "def": "重複的"}, {"t": "x", "def": ""}]\n```'
        got = lexicon.parse(raw, pages=2, to_tw=True)
        self.assertEqual(got[0], {"t": "projection sampling", "k": "term", "def": "一種採樣方法", "page": 1, "quote": "We define projection sampling"})
        self.assertEqual(got[1], {"t": "\\kappa_C", "k": "symbol", "def": "提議分佈"})  # 第 7 頁不存在：拿掉
        self.assertEqual(len(got), 2)  # 大小寫不同的重複、沒有解釋的都不收
        self.assertEqual(lexicon.parse("沒有 JSON", 2, False), [])

    def test_prompt_and_chat_context(self):
        p = lexicon.prompt(self.ws)
        self.assertIn("We define projection sampling", p)
        self.assertIn("術語與符號表", p)
        (self.ws.root / "lexicon.json").write_text(json.dumps({"v": 1, "items": [
            {"t": "projection sampling", "k": "term", "def": "把資料轉成接近基礎模型分佈的取樣", "page": 1},
            {"t": "\\kappa_C", "k": "symbol", "def": "提議分佈", "page": 2}]}), encoding="utf-8")
        block = lexicon.prompt_block(self.ws)
        self.assertLess(block.index("$\\kappa_C$"), block.index("projection sampling"))  # 符號在前
        ctx = chat._context(self.ws, None, "", [], 1)
        self.assertIn("$\\kappa_C$：提議分佈", ctx)


if __name__ == "__main__":
    unittest.main()
