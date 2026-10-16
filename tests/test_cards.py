"""複習卡（cards.py）：存取、到期、整個文獻庫的佇列、AI 出卡的提示詞和回答。  python -m unittest tests.test_cards"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from easyread import config  # noqa: F401 —— 先載 config
from easyread import cards, cloudsync
from easyread.library import Library


def _paper(root: Path, pid: str, title: str, pages: list[str], notes: dict | None = None, brief: str = ""):
    d = root / pid
    (d / "extract").mkdir(parents=True)
    (d / "paper.json").write_text(json.dumps({"meta": {"title_en": title, "page_count": len(pages), "target": "zh-TW"}}), encoding="utf-8")
    (d / "item.json").write_text("{}", encoding="utf-8")
    (d / "reader.json").write_text(json.dumps({"notes": notes or {}}), encoding="utf-8")
    for i, text in enumerate(pages, 1):
        (d / "extract" / f"page-{i:03d}.txt").write_text(text, encoding="utf-8")
    if brief:
        (d / "brief.json").write_text(json.dumps({"v": 1, "state": "done", "parts": [{"label": "全", "text": brief}]}), encoding="utf-8")


class Cards(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_LIBRARY"] = str(self.tmp)
        self.lib = Library(self.tmp)
        _paper(self.tmp, "aaaa1111", "Finetuning with Sampling", ["Intro", "SFT forgets.", "MCMC sampling."],
               {"n1": {"id": "n1", "kind": "highlight", "page": 2, "quote": "SFT forgets quickly"}, "n2": {"id": "n2", "kind": "note", "page": 3, "quote": "MCMC", "body": "接受率怎麼算？"},
                "n3": {"id": "n3", "kind": "note", "page": 1, "body": "刪掉的", "deleted": True}}, brief="用取樣改造 SFT 的資料。")
        _paper(self.tmp, "bbbb2222", "Second", ["Only page."])
        self.ws = self.lib.ws("aaaa1111")

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)

    def test_add_update_review_delete(self):
        out = cards.change(self.ws, {"op": "add", "cards": [{"q": " 什麼是 MCMC？ ", "a": "馬可夫鏈蒙地卡羅", "page": 3, "src": "n2"}, {"q": "", "a": "沒有問題的不收"}]})
        self.assertEqual(len(out), 1)
        c = out[0]
        self.assertEqual((c["q"], c["page"], c["src"]), ("什麼是 MCMC？", 3, "n2"))
        self.assertTrue(c["id"].startswith("c"))
        cards.change(self.ws, {"op": "update", "id": c["id"], "fields": {"a": "Markov chain Monte Carlo", "srs": "不能從這裡改"}})
        due = (datetime.now(timezone.utc) + timedelta(days=4)).isoformat()
        cards.change(self.ws, {"op": "review", "id": c["id"], "srs": {"due": due, "s": 3.7, "d": 5.2, "reps": 1, "lapses": 0, "last": due, "state": "review", "x": 1}})
        got = cards.items(self.ws)[0]
        self.assertEqual(got["a"], "Markov chain Monte Carlo")
        self.assertEqual(set(got["srs"]), {"due", "s", "d", "reps", "lapses", "last", "state"})
        self.assertEqual(cards.due(self.ws), [])  # 四天後才到期
        with self.assertRaises(ValueError):
            cards.change(self.ws, {"op": "review", "id": c["id"], "srs": {"s": 1}})  # 沒有 due
        with self.assertRaises(ValueError):
            cards.change(self.ws, {"op": "delete", "id": "nope"})
        cards.change(self.ws, {"op": "delete", "id": c["id"]})
        self.assertEqual(cards.items(self.ws), [])

    def test_due_queue_across_the_library(self):
        cards.change(self.ws, {"op": "add", "cards": [{"q": "Q1", "a": "A1"}, {"q": "Q2", "a": "A2"}]})
        cards.change(self.lib.ws("bbbb2222"), {"op": "add", "cards": [{"q": "Q3", "a": "A3"}]})
        first = cards.items(self.ws)[0]
        later = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        cards.change(self.ws, {"op": "review", "id": first["id"], "srs": {"due": later, "s": 2, "d": 5, "last": later}})
        ov = cards.overview(self.lib)
        self.assertEqual((ov["cards"], ov["due"]), (3, 2))
        q = cards.queue(self.lib)
        self.assertEqual(sorted(c["q"] for c in q), ["Q2", "Q3"])
        self.assertEqual({c["pid"] for c in q}, {"aaaa1111", "bbbb2222"})
        self.assertEqual([c["q"] for c in cards.queue(self.lib, {"bbbb2222"})], ["Q3"])

    def test_prompts_use_the_marks_or_the_passage(self):
        whole = cards.prompt(self.ws, {"from": "doc"})
        self.assertIn("用取樣改造 SFT 的資料", whole)
        self.assertIn("SFT forgets quickly", whole)  # 劃線的地方
        self.assertIn("接受率怎麼算？", whole)  # 自己寫的筆記
        self.assertNotIn("刪掉的", whole)
        one = cards.prompt(self.ws, {"from": "note", "page": 3, "quote": "MCMC", "text": "接受率怎麼算？"})
        self.assertIn("出 2 張", one)
        self.assertIn("MCMC sampling.", one)  # 那一頁的文字

    def test_parse_drops_bad_pages_and_converts_to_traditional(self):
        got = cards.parse('```json\n[{"q": "什么是采样？", "a": "从分布里抽样本", "page": 2}, {"q": "x", "a": "y", "page": 99}, {"q": "空答案", "a": ""}]\n```', pages=3, to_tw=True)
        self.assertEqual(got[0], {"q": "什麼是採樣？", "a": "從分佈裡抽樣本", "page": 2})  # 簡體字轉成繁體（tw.to_tw）
        self.assertEqual(got[1], {"q": "x", "a": "y"})
        self.assertEqual(len(got), 2)
        self.assertEqual(cards.parse("not json", 3, False), [])

    def test_cards_merge_by_id_when_libraries_are_absorbed(self):
        a, b = self.tmp / "aaaa1111", self.tmp / "bbbb2222"
        cards.change(self.ws, {"op": "add", "cards": [{"q": "Q1", "a": "A1"}]})
        cards.change(self.lib.ws("bbbb2222"), {"op": "add", "cards": [{"q": "Q2", "a": "A2"}]})
        cloudsync._merge_list(a / "cards.json", b / "cards.json", "cards")
        self.assertEqual(sorted(c["q"] for c in json.loads((b / "cards.json").read_text(encoding="utf-8"))["cards"]), ["Q1", "Q2"])


if __name__ == "__main__":
    unittest.main()
