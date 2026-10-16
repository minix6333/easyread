"""問整個文獻庫（libask.py）：範圍、挑哪幾份的筆記和哪幾頁、出處換成連結。  python -m unittest tests.test_libask"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from easyread import config  # noqa: F401 —— 先載 config
from easyread import chat, libask
from easyread.library import Library


def _paper(root: Path, pid: str, meta: dict, pages: list[str], brief: str = "", tags=(), opened: str = "", glossary=()):
    d = root / pid
    (d / "extract").mkdir(parents=True)
    (d / "paper.json").write_text(json.dumps({"meta": meta, "glossary": list(glossary), "blocks": []}), encoding="utf-8")
    (d / "item.json").write_text(json.dumps({"tags": list(tags), "last_opened": opened}), encoding="utf-8")
    for i, text in enumerate(pages, 1):
        (d / "extract" / f"page-{i:03d}.txt").write_text(text, encoding="utf-8")
    if brief:
        (d / "brief.json").write_text(json.dumps({"v": 1, "state": "done", "parts": [{"label": "全", "text": brief}]}), encoding="utf-8")


class LibAsk(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_LIBRARY"] = str(self.tmp)
        self.lib = Library(self.tmp)
        _paper(self.tmp, "aaaa1111", {"title_en": "Finetuning with Sampling", "authors": "Aayush Karan, Sitan Chen", "date": "2026 年 10 月"},
               ["Introduction. Supervised finetuning suffers from catastrophic forgetting.", "Projection sampling keeps the base distribution."],
               brief="本文用取樣改造 SFT 的資料，減少災難性遺忘。\n\n- 第 1 頁：問題", tags=["Paper"], opened="2026-10-16",
               glossary=[{"en": "catastrophic forgetting", "zh": "災難性遺忘"}])
        _paper(self.tmp, "bbbb2222", {"title_en": "Data Agent: Learning to Select Data", "authors": "Lin Wei and Y. Zhou", "year": "2025"},
               ["We study data selection with reinforcement learning agents.", "Forgetting is measured on held-out tasks; catastrophic forgetting drops."],
               brief="以強化學習挑選訓練資料。\n\n- 第 2 頁：遺忘", tags=["Paper"], opened="2026-10-15")
        _paper(self.tmp, "cccc3333", {"title_en": "Microsoft PowerPoint - Classification III - Copy"}, ["Support vector machines and margins."],
               tags=["Course"], opened="2026-10-14")
        self.here = self.lib.ws("aaaa1111")

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)

    def test_scope_parsing(self):
        self.assertEqual(libask.parse({"kind": "all"}), {"kind": "all"})
        self.assertEqual(libask.parse({"kind": "tag", "tag": " Paper "}), {"kind": "tag", "tag": "Paper"})
        self.assertEqual(libask.parse({"kind": "docs", "ids": ["bbbb2222", "../etc", 3]}), {"kind": "docs", "ids": ["bbbb2222"]})
        for bad in (None, {}, {"kind": "tag", "tag": ""}, {"kind": "docs", "ids": []}, "all"):
            self.assertIsNone(libask.parse(bad))

    def test_members_put_this_document_first_and_follow_the_scope(self):
        ids = lambda scope: [ws.id for ws in libask.members(self.lib, scope, self.here)]  # noqa: E731
        self.assertEqual(ids({"kind": "all"}), ["aaaa1111", "bbbb2222", "cccc3333"])
        self.assertEqual(ids({"kind": "tag", "tag": "Course"}), ["aaaa1111", "cccc3333"])
        self.assertEqual(ids({"kind": "docs", "ids": ["cccc3333"]}), ["aaaa1111", "cccc3333"])

    def test_context_has_an_overview_the_relevant_briefs_and_pages(self):
        text, codes = libask.context(self.lib, self.here, {"kind": "all"}, "這幾篇怎麼處理災難性遺忘？", "codex")
        self.assertEqual(codes["D1"]["id"], "aaaa1111")
        self.assertEqual(codes["D1"]["who"], "Karan 2026")
        self.assertEqual(codes["D2"]["who"], "Wei 2025")
        self.assertEqual(codes["D3"]["who"], "Classification III")  # 投影片檔名的 Microsoft PowerPoint、Copy 拿掉
        self.assertIn("D2 Wei 2025《Data Agent", text)
        self.assertIn("以強化學習挑選訓練資料", text)  # 預讀筆記
        # 中文的「災難性遺忘」用 D1 的術語表換成 catastrophic forgetting，找得到兩份的英文頁
        self.assertIn("〔D1 p.1〕", text)
        self.assertIn("〔D2 p.2〕", text)
        self.assertNotIn("〔D3 p.1〕", text)  # 不相關的不帶
        pages, _ = libask.context(self.lib, self.here, {"kind": "all"}, "catastrophic forgetting", "codex", pages_only=True)
        self.assertTrue(pages.startswith("和问题最相关的几页原文"))
        self.assertNotIn("Data Agent", pages)

    def test_citations_become_links(self):
        codes = {"D1": {"id": "aaaa1111", "who": "Karan 2026"}, "D2": {"id": "bbbb2222", "who": "Wei 2025"}}
        out = libask.link("見〔D1 p.2〕和〔D2 第 5–6 頁〕，也見〔D2〕、[D1 p.3, p.9]；〔D7 p.1〕不在範圍裡。", codes)
        self.assertIn("[Karan 2026 · p.2](/read/aaaa1111#page=2)", out)
        self.assertIn("[Wei 2025 · p.5–6](/read/bbbb2222#page=5)", out)
        self.assertIn("[Wei 2025](/read/bbbb2222)", out)
        self.assertIn("[Karan 2026 · p.3](/read/aaaa1111#page=3) [Karan 2026 · p.9](/read/aaaa1111#page=9)", out)
        self.assertIn("〔D7 p.1〕", out)

    def test_prompt_uses_the_library_context_instead_of_the_whole_document(self):
        ctx, _ = libask.context(self.lib, self.here, {"kind": "all"}, "誰提到遺忘？", "codex")
        msgs = [{"role": "user", "content": "誰提到遺忘？"}]
        text = chat.prompt(self.here, msgs, None, "", "codex", [], page=1, library_ctx=ctx)
        self.assertIn("〔D3 p.5〕", text)  # 出處的寫法
        self.assertRegex(text, "读者现在开着的是 D1|讀者現在開著的是 D1")
        self.assertNotIn("整份文件的文字", text)
        self.assertIn("誰提到遺忘？", text)


if __name__ == "__main__":
    unittest.main()
