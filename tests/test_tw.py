"""繁體中文（台灣）：簡轉繁、模型輸出的保險、提示詞轉繁。  python -m unittest tests.test_tw"""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread import chat, engines, langs, translate, tw
from easyread.store import write_json_atomic
from tests.test_translate import make_ws


class TwTest(unittest.TestCase):
    def test_to_tw_only_touches_han(self):
        self.assertEqual(tw.to_tw("软件的数据在服务器上"), "軟體的資料在伺服器上")
        self.assertEqual(tw.to_tw("台湾、平台"), "台灣、平台")  # 不寫「臺」
        self.assertEqual(tw.to_tw("$\\frac{a}{b}$ and {n}"), "$\\frac{a}{b}$ and {n}")
        self.assertEqual(tw.to_tw(""), "")
        self.assertIsNone(tw.to_tw(None))
        self.assertEqual(tw.to_cn("標紅的筆記"), "标红的笔记")

    def test_convert_keeps_original_and_ids(self):
        data = {"blocks": [{"id": "p1-1", "type": "para", "en": "data 软件", "zh": "软件", "tex": "x_i", "items": [{"en": "a", "zh": "网络"}]}],
                "glossary": [{"en": "network", "zh": "网络"}], "meta": {"title_zh": "标题", "title_en": "Title 简体"}}
        out = tw.convert(data)
        b = out["blocks"][0]
        self.assertEqual((b["en"], b["zh"], b["tex"], b["items"][0]["zh"]), ("data 软件", "軟體", "x_i", "網路"))
        self.assertEqual(out["glossary"][0]["zh"], "網路")
        self.assertEqual((out["meta"]["title_zh"], out["meta"]["title_en"]), ("標題", "Title 简体"))
        self.assertEqual(data["blocks"][0]["zh"], "软件")  # 原物件不動

    def test_stream_waits_for_a_boundary(self):
        s = tw.Stream(True)
        self.assertEqual(s.feed("这是软"), "")  # 詞還沒完整，先留著
        self.assertEqual(s.feed("件，很好"), "這是軟體，")
        self.assertEqual(s.flush(), "很好")
        self.assertEqual(s.flush(), "")
        off = tw.Stream(False)
        self.assertEqual(off.feed("软件"), "软件")
        long = tw.Stream(True)
        self.assertNotEqual(long.feed("软" * 70), "")  # 太久沒標點也會送出

    def test_translation_output_is_guarded(self):
        ws = make_ws(1)
        self.addCleanup(shutil.rmtree, ws.root, True)

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            self.assertIn("繁體中文", prompt)
            self.assertNotIn("译成", prompt)
            return json.dumps({"glossary": [{"en": "software", "zh": "软件"}],
                               "blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "Software ‖ runs.", "zh": "软件 ‖ 运行。"}]}, ensure_ascii=False)
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}, "target": "zh-TW"}
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.netcheck, "problem", lambda cfg: ""), \
                mock.patch.object(translate.pdfwork, "locate", lambda root: None), mock.patch.object(translate, "tex_problems", lambda tex: []):
            self.assertEqual(translate.translate_pages(ws, cfg, [1], threading.Event(), lambda *a: None), {})
        paper = ws.load("paper")
        self.assertEqual(paper["meta"]["target"], "zh-TW")
        b = paper["blocks"][0]
        self.assertEqual(b["zh"], "軟體執行。")  # 轉了繁體、‖ 也正常去掉（中文句間不留空格）
        self.assertEqual(b["en"], "Software runs.")
        self.assertIn("sents", b)  # 句子對齊在轉換之後算，位置對得上
        self.assertEqual(paper["glossary"], [{"en": "software", "zh": "軟體"}])

    def test_chat_prompt_follows_reply_language(self):
        ws = make_ws(1)
        self.addCleanup(shutil.rmtree, ws.root, True)
        paper = ws.load("paper")
        paper["meta"]["target"] = "zh-TW"
        paper["blocks"] = [{"id": "p1-1", "type": "para", "page": 1, "en": "Hello.", "zh": "你好。"}]
        write_json_atomic(ws.root / "paper.json", paper)
        text = chat.prompt(ws, [{"role": "user", "content": "這段在說什麼"}], "p1-1", "", "openai")
        self.assertIn("用繁體中文（台灣用語）", text)
        self.assertNotIn("读者", text)
        self.assertIn("這段在說什麼", text)
        with mock.patch("easyread.i18n.lang", lambda: "zh"):
            paper["meta"]["target"] = "zh"
            write_json_atomic(ws.root / "paper.json", paper)
            self.assertIn("用中文，直接", chat.prompt(ws, [{"role": "user", "content": "问"}], "p1-1", "", "openai"))

    def test_marks_detected_in_traditional_chinese(self):
        self.assertEqual(chat.wants_marks("我標紅的那些公式有什麼關係"), (True, {"红"}))
        self.assertEqual(chat.wants_marks("把我畫過線的內容串起來")[0], True)
        self.assertEqual(chat.wants_marks("這段在說什麼"), (False, None))

    def test_reply_code(self):
        with mock.patch("easyread.i18n.lang", lambda: "zh-TW"):
            self.assertEqual(langs.reply_code({"target": "zh"}), "zh-TW")
            self.assertEqual(langs.reply_code({"target": "ja"}), "ja")
            self.assertEqual(langs.reply_code({}), "zh-TW")
        with mock.patch("easyread.i18n.lang", lambda: "en"):
            self.assertEqual(langs.reply_code({}), "en")
            self.assertEqual(langs.reply_code({"title_zh": "旧"}), "zh-TW")


if __name__ == "__main__":
    unittest.main()
