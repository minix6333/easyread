"""比較表（matrix.py）：欄的整理、給模型的資料、模型回答的 JSON 怎麼收。  python -m unittest tests.test_matrix"""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import config  # noqa: F401 —— 先載 config
from easyread import matrix
from easyread.library import Library


def _paper(root: Path, pid: str, meta: dict, pages: list[str], brief: str = ""):
    d = root / pid
    (d / "extract").mkdir(parents=True)
    meta = {"page_count": len(pages), "target": "zh-TW", **meta}
    (d / "paper.json").write_text(json.dumps({"meta": meta, "blocks": [{"role": "abstract", "en": "We study sampling."}]}), encoding="utf-8")
    (d / "item.json").write_text("{}", encoding="utf-8")
    for i, text in enumerate(pages, 1):
        (d / "extract" / f"page-{i:03d}.txt").write_text(text, encoding="utf-8")
    if brief:
        (d / "brief.json").write_text(json.dumps({"v": 1, "state": "done", "parts": [{"label": "全", "text": brief}]}), encoding="utf-8")


class Matrix(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_LIBRARY"] = str(self.tmp)
        self.lib = Library(self.tmp)
        _paper(self.tmp, "aaaa1111", {"title_en": "Finetuning with Sampling", "authors": "Aayush Karan"},
               ["Introduction", "We evaluate on MATH and GPQA datasets.", "Results: 65.5% accuracy."], brief="用取樣改造 SFT 的資料。\n\n- 第 2 頁：資料集")
        _paper(self.tmp, "bbbb2222", {"title_en": "Plain Paper"}, ["Only one page about data."])
        self.cols = matrix.parse_columns([{"name": "方法", "ask": "核心做法"}, {"name": "資料集"}])

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)

    def test_columns_are_cleaned_and_deduplicated(self):
        cols = matrix.parse_columns(["  研究  問題 ", {"name": "研究 問題"}, {"name": ""}, 7, {"name": "x" * 90, "ask": "y"}] + [f"c{i}" for i in range(20)])
        self.assertEqual(cols[0], {"name": "研究 問題", "ask": ""})
        self.assertEqual(len(cols[1]["name"]), 60)
        self.assertEqual(len(cols), matrix.MAX_COLS)

    def test_prompt_lists_the_columns_and_uses_the_brief_and_relevant_pages(self):
        text = matrix.prompt(self.lib.ws("aaaa1111"), self.cols)
        self.assertIn('"方法", "資料集"', text)
        self.assertIn("用取樣改造 SFT 的資料", text)  # 預讀筆記
        self.assertIn("MATH and GPQA", text)  # 「資料集」找到的那一頁
        plain = matrix.prompt(self.lib.ws("bbbb2222"), self.cols)  # 沒預讀過：整份文字
        self.assertIn("Only one page about data.", plain)

    def test_answers_are_parsed_with_page_checks_and_fallback(self):
        ans = '```json\n{"方法": {"text": "取樣  改造資料", "pages": [2, "3", 9, 2]}, "資料集": "MATH、GPQA"}\n```'
        out = matrix.parse_answer(ans, self.cols, pages=3, to_tw=True)
        self.assertEqual(out["方法"], {"text": "取樣 改造資料", "pages": [2, 3]})  # 不存在的頁、重複的拿掉
        self.assertEqual(out["資料集"], {"text": "MATH、GPQA", "pages": []})
        bad = matrix.parse_answer("抱歉，我無法回答", self.cols, pages=3, to_tw=False)
        self.assertTrue(bad["方法"]["raw"])
        self.assertEqual(bad["資料集"]["text"], "")

    def test_handle_streams_one_row_per_document(self):
        reply = lambda *a, **k: iter(['{"方法": {"text": "取樣", "pages": [1]}, "資料集": {"text": "未提及", "pages": []}}'])  # noqa: E731
        handler = mock.Mock()
        handler.wfile = io.BytesIO()
        with mock.patch.object(matrix.chat, "stream", side_effect=reply), mock.patch.object(matrix.chat, "cancel_when_gone", return_value=lambda: None):
            matrix.handle(handler, self.lib, {"ids": ["aaaa1111", "bbbb2222", "zzzz"], "columns": self.cols})
        lines = [json.loads(x) for x in handler.wfile.getvalue().decode("utf-8").splitlines()]
        self.assertEqual(lines[0]["rows"], ["aaaa1111", "bbbb2222"])  # 不存在的那份不算
        rows = {x["row"]: x["cells"] for x in lines if "row" in x}
        self.assertEqual(set(rows), {"aaaa1111", "bbbb2222"})
        self.assertEqual(rows["aaaa1111"]["方法"], {"text": "取樣", "pages": [1]})
        self.assertTrue(lines[-1]["done"])
        with self.assertRaises(ValueError):
            matrix.handle(handler, self.lib, {"ids": [], "columns": self.cols})


if __name__ == "__main__":
    unittest.main()
