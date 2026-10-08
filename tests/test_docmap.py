"""全文地圖：每頁一行的大綱、按關鍵詞找相關頁、整份文字；問 AI 的提示詞帶上它們。"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import chat, docmap, paths, preread
from easyread.store import Workspace, write_json_atomic

PAGES = {
    1: "Finetuning with Sampling\nAayush Karan\nAbstract\nIntroducing new capabilities to frontier models has long been the goal of posttraining, which employs supervised finetuning.",
    2: "2 Related Works\nSFT vs. RL. Many recent works have investigated the performance gap between SFT and RL in posttraining.\nFigure 1: Overview of the pipeline.",
    3: "3 Method\nWe introduce a Markov chain Monte Carlo sampling algorithm. The Metropolis-Hastings acceptance ratio is defined as follows.",
    4: "4 Experiments\nWe evaluate on math and coding benchmarks. The acceptance ratio matters less here.",
    5: "",
}


class DocmapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        write_json_atomic(self.ws.paper_path, {"meta": {"title_en": "Test", "page_count": 5}, "blocks": [],
                                               "glossary": [{"en": "acceptance ratio", "zh": "接受率"}]})
        d = paths.derived(self.ws.root, "extract")
        d.mkdir(parents=True, exist_ok=True)
        for n, t in PAGES.items():
            (d / f"page-{n:03d}.txt").write_text(t, encoding="utf-8")

    def test_outline_one_line_per_page_with_headings(self):
        out = docmap.outline(self.ws)
        lines = out.splitlines()
        self.assertEqual(len(lines), 4)  # 空白頁不列
        self.assertTrue(lines[1].startswith("p2: 2 Related Works"))
        self.assertIn("Many recent works", lines[1])
        self.assertIn("Figure 1", lines[1])
        self.assertTrue(lines[2].startswith("p3: 3 Method"))
        self.assertLessEqual(len(out), docmap.OUTLINE_BUDGET)

    def test_outline_prefers_headings_from_paper_json(self):
        write_json_atomic(self.ws.paper_path, {"meta": {"page_count": 5}, "blocks": [{"id": "h", "type": "heading", "page": 3, "num": "3", "zh": "方法"}]})
        self.assertIn("p3: 3 方法", docmap.outline(self.ws))

    def test_relevant_pages_by_keywords_and_glossary(self):
        self.assertEqual(docmap.relevant(self.ws, "How is the Metropolis-Hastings acceptance ratio defined?", skip=()), [3, 4])
        self.assertEqual(docmap.relevant(self.ws, "接受率是怎麼定義的？", skip=()), [3, 4])  # 術語表把中文換成英文
        self.assertEqual(docmap.relevant(self.ws, "接受率是怎麼定義的？", skip={3}), [4])
        self.assertEqual(docmap.relevant(self.ws, "這篇在講什麼", skip=()), [])  # 沒有關鍵詞就不猜
        self.assertEqual(docmap.relevant(self.ws, "the and for", skip=()), [])

    def test_full_text_truncates_each_page_when_too_long(self):
        full = docmap.full_text(self.ws)
        self.assertIn("[第 1 页]", full)
        self.assertNotIn("[第 5 页]", full)
        (paths.derived(self.ws.root, "extract") / "page-004.txt").write_text(PAGES[4] * 20, encoding="utf-8")  # 一頁 1600 多字
        short = docmap.full_text(self.ws, budget=1000)
        self.assertIn("…（本页后面省略）", short)
        self.assertLess(len(short), 1000 + 4 * 80)
        self.assertIn("Finetuning with Sampling", short)  # 短的頁照舊

    def test_prompt_carries_the_whole_document_when_it_fits(self):
        msgs = [{"role": "user", "content": "acceptance ratio 在實驗裡重要嗎？"}]
        text = chat.prompt(self.ws, msgs, None, "", "openai", page=1)
        self.assertIn("整份文件的文字", text)
        for n in (1, 2, 3, 4):
            self.assertIn(f"[第 {n} 页]", text)
        self.assertNotIn("全文地图", text)             # 整份都在：不用地圖，也不用另外找相關頁
        self.assertNotIn("问题可能涉及的其他页", text)
        self.assertIn("第 1 页（这一页的文字在上面的全文里）", text)  # 正在看的那頁只說頁碼，不再貼一次
        self.assertLess(text.index("整份文件的文字"), text.index("读者正在看"))  # 不變的在前，吃得到快取
        self.assertLess(text.index("读者正在看"), text.index("读者现在问"))
        codex = chat.prompt(self.ws, msgs, None, "", "codex", page=1)
        self.assertIn(str(paths.derived(self.ws.root, "extract")), codex)  # Codex 也能自己去讀別頁
        follow = chat.prompt(self.ws, msgs, None, "", "openai", page=1, followup=True)
        self.assertNotIn("整份文件的文字", follow)       # 行程記得整份，追問不重送
        self.assertNotIn("[第 3 页]", follow)

    def test_long_document_gets_map_and_related_pages(self):
        msgs = [{"role": "user", "content": "acceptance ratio 在實驗裡重要嗎？"}]
        with mock.patch.object(preread, "WHOLE", 100):  # 當成整份放不下
            text = chat.prompt(self.ws, msgs, None, "", "openai", page=1)
            self.assertNotIn("整份文件的文字", text)
            self.assertIn("全文地图", text)
            self.assertIn("p3: 3 Method", text)
            self.assertIn("问题可能涉及的其他页", text)
            self.assertIn("[第 3 页]", text)
            self.assertIn("[第 4 页]", text)
            self.assertIn("这一页抽取的文字", text)       # 正在看的那頁要貼上
            self.assertLess(text.index("全文地图"), text.index("读者现在问"))
            follow = chat.prompt(self.ws, msgs, None, "", "openai", page=1, followup=True)
            self.assertNotIn("全文地图", follow)          # 行程記得地圖，追問只補相關頁
            self.assertIn("[第 3 页]", follow)

    def test_overview_mode_sends_the_whole_document(self):
        msgs = [{"role": "user", "content": "整份在講什麼？"}]
        text = chat.prompt(self.ws, msgs, None, "", "openai", mode="overview")
        self.assertIn("上课前先复习", text)
        self.assertIn("[第 1 页]", text)
        self.assertIn("[第 4 页]", text)
        self.assertIn("Markov chain Monte Carlo", text)
        self.assertNotIn("全文地图", text)
        follow = chat.prompt(self.ws, msgs, None, "", "openai", mode="overview", followup=True)
        self.assertNotIn("Markov chain Monte Carlo", follow)  # 追問不重送整份

    def test_aside_context_quotes_the_parent_answer(self):
        from easyread import chat_store
        tid = chat_store.new_id()
        m = chat_store.append(self.ws, tid, {"content": "MH 在做什麼？"}, "它用 acceptance ratio 決定要不要換成新候選。", "gpt", "GPT")
        ctx = chat.aside_context(self.ws, {"thread": tid, "msg": m["id"], "quote": "acceptance ratio 決定"})
        self.assertEqual(ctx["question"], "MH 在做什麼？")
        self.assertEqual(ctx["quote"], "acceptance ratio 決定")
        self.assertIsNone(chat.aside_context(self.ws, {"thread": tid, "msg": "nope"}))
        self.assertIsNone(chat.aside_context(self.ws, None))
        text = chat.prompt(self.ws, [{"role": "user", "content": "這是什麼意思？"}], None, "", "openai", page=3, aside=ctx)
        self.assertIn("他当时问的是「MH 在做什麼？」", text)
        self.assertIn("他指着回答里这一句", text)
        self.assertLess(text.index("他指着回答里这一句"), text.index("读者现在问"))
        # 小視窗裡開的對話：標題用那一句、記著它接在哪裡
        aside_tid = chat_store.new_id()
        chat_store.append(self.ws, aside_tid, {"content": "這是什麼意思？", "aside": {"thread": tid, "msg": m["id"], "quote": "acceptance ratio 決定"}}, "就是…", "gpt", "GPT")
        t = chat_store.get(self.ws, aside_tid)
        self.assertEqual(t["title"], "↳ acceptance ratio 決定")
        self.assertEqual(t["aside"]["thread"], tid)


if __name__ == "__main__":
    unittest.main()
