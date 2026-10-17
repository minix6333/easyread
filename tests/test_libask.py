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
        hit = text.split("和问题最相关的几页原文")[1].split("问题比较广")[0]
        self.assertIn("〔D1 p.1〕", hit)
        self.assertIn("〔D2 p.2〕", hit)
        self.assertNotIn("〔D3 p.1〕", hit)  # 不相關的不算「最相關」……
        self.assertIn("〔D3 p.1〕\nSupport vector", text.split("问题比较广")[1])  # ……但額度還很多：照順序補上，沒有全文筆記的那份不會只剩標題
        pages, _ = libask.context(self.lib, self.here, {"kind": "all"}, "catastrophic forgetting", "codex", pages_only=True)
        self.assertTrue(pages.startswith("和问题最相关的几页原文"))
        self.assertNotIn("Data Agent", pages)

    def test_a_broad_question_still_shows_every_document(self):
        _paper(self.tmp, "dddd4444", {"title_en": "L2 Bayesian decision theory"}, [f"Slide {i} Bayes risk minimum error rate" for i in range(1, 30)],
               tags=["Course"], opened="2026-10-13")
        keep = libask.FILL_PAGES
        libask.FILL_PAGES = 5
        try:
            text, codes = libask.context(self.lib, self.here, {"kind": "tag", "tag": "Course"}, "整理一下這門課要知道的東西", "codex")
        finally:
            libask.FILL_PAGES = keep
        self.assertEqual([codes[k]["id"] for k in ("D1", "D2", "D3")], ["aaaa1111", "cccc3333", "dddd4444"])
        wide = text.split("问题比较广")[1]
        self.assertIn("〔D2 p.1〕\nSupport vector", wide)  # 對不到字的廣問題：每份從頭的幾頁
        self.assertIn("〔D3 p.5〕\nSlide 5", wide)
        self.assertNotIn("〔D3 p.6〕", wide)  # 每份最多 FILL_PAGES 頁……
        heads = text.split("还没有全文笔记的几份")[1]
        self.assertIn("D3：p6 Slide 6", heads)  # ……其餘的頁帶開頭幾個字，看得出整份講到哪裡
        self.assertIn("p29 Slide 29", heads)
        self.assertNotIn("D1：", heads)  # 有全文筆記的不用
        pages, _ = libask.context(self.lib, self.here, {"kind": "tag", "tag": "Course"}, "整理一下這門課要知道的東西", "codex", pages_only=True)
        self.assertEqual(pages, "")  # 追問不補（第一問補過，模型記得）
        self.assertEqual([ws.id for ws in libask.unread(self.lib, codes, self.here)], ["cccc3333", "dddd4444"])  # 答完在背景預讀的

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

    def test_codes_stay_the_same_within_a_conversation(self):
        # 讀者點開了回答裡的 D3（最近打開的順序變了）：同一個對話的代號照第一次的，D3 還是同一份
        first = [ws.id for ws in libask.members(self.lib, {"kind": "all"}, self.here)]
        item = self.tmp / "cccc3333" / "item.json"
        item.write_text(json.dumps({"tags": ["Course"], "last_opened": "2026-10-20"}), encoding="utf-8")
        libask._cards.clear()
        self.assertEqual([ws.id for ws in libask.members(self.lib, {"kind": "all"}, self.here)][1], "cccc3333")  # 沒有記著的順序：照最近打開
        _, codes = libask.context(self.lib, self.here, {"kind": "all"}, "遺忘", "codex", order=first)
        self.assertEqual([codes[f"D{i}"]["id"] for i in (1, 2, 3)], first)
        # 之後才加進文獻庫的排在最後面，原來的代號不動
        _paper(self.tmp, "dddd4444", {"title_en": "New One"}, ["text"], opened="2026-10-21")
        _, codes = libask.context(self.lib, self.here, {"kind": "all"}, "遺忘", "codex", order=first)
        self.assertEqual([codes[f"D{i}"]["id"] for i in (1, 2, 3, 4)], first + ["dddd4444"])

    def test_followup_says_so_when_no_page_matches(self):
        # 追問沒找到相關頁：還是問整個文獻庫的寫法，不會說「整份文字在上面」
        msgs = [{"role": "user", "content": "第一問"}, {"role": "assistant", "content": "答"}, {"role": "user", "content": "那後來呢"}]
        text = chat.prompt(self.here, msgs, None, "", "codex", [], page=2, followup=True, library_ctx=libask.followup(""))
        self.assertRegex(text, "代号同前|代號同前")
        self.assertRegex(text, "没找到特别相关的原文页|沒找到特別相關的原文頁")
        self.assertNotRegex(text, "在上面的全文|全文里|全文裡")
        with_pages = libask.followup("〔D2 p.2〕\nForgetting")
        self.assertIn("〔D2 p.2〕", with_pages)


if __name__ == "__main__":
    unittest.main()
