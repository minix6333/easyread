"""全文搜尋（search.py）：文件的內文、文件上自己寫的筆記、獨立筆記。  python -m unittest tests.test_search"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from easyread import config  # noqa: F401 —— 先載 config
from easyread import notes, search
from easyread.library import Library


def _paper(root: Path, pid: str, pages: list[str], my_notes: dict | None = None):
    d = root / pid
    (d / "extract").mkdir(parents=True)
    (d / "paper.json").write_text(json.dumps({"meta": {"title_en": pid}}), encoding="utf-8")
    for i, text in enumerate(pages, 1):
        (d / "extract" / f"page-{i:03d}.txt").write_text(text, encoding="utf-8")
    if my_notes is not None:
        (d / "reader.json").write_text(json.dumps({"notes": my_notes}), encoding="utf-8")


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_LIBRARY"] = str(self.tmp)
        self.lib = Library(self.tmp)
        _paper(self.tmp, "aaaa1111", [
            "Finetuning with Sampling\nIntroducing new capabilities which predominantly employs supervised fine-\ntuning (SFT).",
            "We sample trajectories according to\ntheir likelihoods.\nNothing else here.",
        ], {"n1": {"id": "n1", "kind": "note", "page": 2, "body": "**我的想法**：這裡的 likelihood 其實是對數的"},
            "n2": {"id": "n2", "kind": "note", "page": 1, "body": "已經刪掉的 likelihood", "deleted": True},
            "n3": {"id": "n3", "kind": "highlight", "page": 1, "body": ""}})
        _paper(self.tmp, "bbbb2222", ["梯度下降是機器\n學習的基礎。", "Gradient Descent\n• Finding the optimal parameters"])
        self.note = notes.create(self.tmp, title="課堂筆記", body="## 第一週\n\n- [ ] 複習**梯度**下降\n- [ ] 看完論文")

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)

    def find(self, q, **kw):
        return search.search(self.lib, q, **kw)["results"]

    def test_phrase_across_a_line_break_and_a_hyphenated_word(self):
        r = self.find("according to their likelihoods")
        self.assertEqual([(x["id"], x["hits"][0]["page"]) for x in r], [("aaaa1111", 2)])
        h = self.find("supervised finetuning")[0]["hits"][0]  # 原文是 fine-⏎tuning
        self.assertEqual(h["page"], 1)
        self.assertEqual(h["snippet"][h["mark"][0]:h["mark"][1]].lower(), "supervised finetuning")

    def test_case_insensitive_and_every_word_must_be_on_the_page(self):
        self.assertEqual(self.find("GRADIENT descent")[0]["id"], "bbbb2222")
        self.assertEqual([x["id"] for x in self.find("sampling capabilities")], ["aaaa1111"])  # 兩個詞不相鄰，但在同一頁
        self.assertEqual(self.find("sampling gradient"), [])  # 分別在不同文件：不算

    def test_chinese_across_a_line_break(self):
        r = self.find("機器學習")
        self.assertEqual(r[0]["id"], "bbbb2222")
        self.assertIn("機器學習", r[0]["hits"][0]["snippet"])

    def test_my_notes_on_a_paper_and_standalone_notes(self):
        r = self.find("likelihood")
        paper = next(x for x in r if x["id"] == "aaaa1111")
        self.assertEqual(paper["n"], 2)  # 內文一頁＋自己寫的一則；刪掉的那則不算
        mine = next(h for h in paper["hits"] if h["where"] == "note")
        self.assertEqual(mine["page"], 2)
        self.assertNotIn("**", mine["snippet"])
        r = self.find("梯度")
        self.assertEqual({x["kind"] for x in r}, {"paper", "note"})
        n = next(x for x in r if x["kind"] == "note")
        self.assertEqual(n["id"], self.note["id"])
        self.assertNotIn("- [ ]", n["hits"][0]["snippet"])
        self.assertNotIn("**", n["hits"][0]["snippet"])

    def test_too_short_or_empty_query_returns_nothing(self):
        self.assertEqual(self.find("x"), [])
        self.assertEqual(self.find("   "), [])

    def test_picks_up_changes(self):
        self.assertEqual(self.find("zebra"), [])
        (self.tmp / "aaaa1111" / "extract" / "page-003.txt").write_text("A zebra appears.", encoding="utf-8")
        self.assertEqual([x["hits"][0]["page"] for x in self.find("zebra")], [3])
        notes.save(self.tmp, self.note["id"], body="zebra 也在筆記裡")
        self.assertEqual({x["kind"] for x in self.find("zebra")}, {"paper", "note"})
        notes.delete(self.tmp, self.note["id"])
        self.assertEqual({x["kind"] for x in self.find("zebra")}, {"paper"})

    def test_ranks_exact_phrase_first_and_limits(self):
        _paper(self.tmp, "cccc3333", ["descent of the gradient, then more gradient talk"])  # 兩個詞都在但不相連
        r = self.find("gradient descent")
        self.assertEqual([x["id"] for x in r], ["bbbb2222", "cccc3333"])
        self.assertEqual(len(self.find("gradient descent", limit=1)), 1)


if __name__ == "__main__":
    unittest.main()
