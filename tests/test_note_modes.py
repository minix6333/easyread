"""提問的專門寫法（推導、圖解）和「幫這頁寫筆記」的提示詞。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import chat, notehelp, paths
from easyread.store import Workspace, write_json_atomic


class NoteModesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        write_json_atomic(self.ws.paper_path, {"meta": {"title_en": "Test paper", "page_count": 3}, "blocks": [
            {"id": "b", "type": "para", "page": 2, "en": "A source fact with $x$.", "zh": "当前段落"},
        ]})
        extract = paths.derived(self.ws.root, "extract")
        extract.mkdir(parents=True, exist_ok=True)
        (extract / "page-001.txt").write_text("PREVIOUS PAGE TAIL", encoding="utf-8")
        (extract / "page-002.txt").write_text("We minimise the loss L(w) by gradient descent.", encoding="utf-8")
        write_json_atomic(self.ws.reader_path, {"notes": {
            "n1": {"id": "n1", "side": "pdf", "page": 2, "quote": "gradient descent", "kind": "highlight"},
            "n2": {"id": "n2", "side": "pdf", "page": 3, "quote": "other page", "kind": "highlight"},
            "n3": {"id": "n3", "side": "pdf", "page": 2, "quote": "deleted mark", "deleted": True},
        }})

    def test_modes_change_the_prompt_only_when_asked(self):
        msgs = [{"role": "user", "content": "推導這裡"}]
        plain = chat.prompt(self.ws, msgs, "b", "", "openai")
        derive = chat.prompt(self.ws, msgs, "b", "", "openai", mode="derive")
        diagram = chat.prompt(self.ws, msgs, "b", "", "openai", mode="diagram")
        self.assertNotIn("推导", plain.replace("多行推导使用 aligned", ""))
        self.assertNotIn("```flow", plain)
        self.assertIn("为什么可以这样写", derive)
        self.assertIn("不许写“显然”", derive)
        self.assertIn("```flow", diagram)
        self.assertIn("架构图", diagram)
        self.assertIn("subgraph", diagram)
        for text in (derive, diagram):  # 專門的要求放在問題前面、上下文後面
            self.assertLess(text.index("当前段落"), text.index("以下要求优先"))
            self.assertLess(text.index("以下要求优先"), text.index("读者现在问"))
        self.assertEqual(chat.prompt(self.ws, msgs, "b", "", "openai", mode="nope"), plain)
        solve = chat.prompt(self.ws, msgs, "b", "", "openai", mode="solve")
        self.assertIn("boxed", solve)
        self.assertIn("**答：**", solve)
        self.assertIn("不跳步", solve)

    def test_followup_carries_the_mode(self):
        msgs = [{"role": "user", "content": "一"}, {"role": "assistant", "content": "答"}, {"role": "user", "content": "畫成圖"}]
        text = chat.prompt(self.ws, msgs, "b", "", "claude", followup=True, with_context=False, mode="diagram")
        self.assertIn("```flow", text)
        self.assertTrue(text.rstrip().endswith("读者接着问：畫成圖"))

    def test_page_note_prompt(self):
        text = notehelp.page_prompt(self.ws, 2, "", "openai", True)
        self.assertIn("不是摘要", text)
        self.assertIn("不能失真", text)
        self.assertIn("We minimise the loss", text)
        self.assertIn("PREVIOUS PAGE TAIL", text)
        self.assertIn("原页图", text)
        self.assertIn("- gradient descent", text)
        self.assertNotIn("other page", text)
        self.assertNotIn("deleted mark", text)
        self.assertNotIn("读者自己已经在这一页写了", text)
        mine = notehelp.page_prompt(self.ws, 2, "我的筆記：學習率要小", "openai", False)
        self.assertIn("我的筆記：學習率要小", mine)
        self.assertIn("不要重复它", mine)
        self.assertNotIn("原页图", mine)

    def test_page_note_request_streams_and_attaches_the_page_image(self):
        sent, seen = [], {}

        class H:  # 只要 handle() 用到的那幾樣
            def send_response(self, code): seen["code"] = code
            def send_header(self, *a): pass
            def end_headers(self): pass
            class wfile:  # noqa: N801
                @staticmethod
                def write(b): sent.append(b.decode("utf-8"))
                @staticmethod
                def flush(): pass

        def fake_stream(ecfg, text, cwd, cancel, **kw):
            seen["text"], seen["images"] = text, kw.get("images")
            yield "這一頁在講梯度下降。"

        (self.ws.root / "source.pdf").write_bytes(b"%PDF-1.4")
        img = self.ws.root / "page.jpg"
        with patch.object(notehelp.chat, "stream", fake_stream), patch.object(notehelp.pdfwork, "engine_image", lambda root, n: img), \
                patch.object(notehelp.chat_models, "engine_cfg", lambda cfg, model: ({"engine": "openai"}, {"model": "m"})), \
                patch.object(notehelp.chat_models, "label", lambda m: "M"):
            notehelp.handle(H(), self.ws, {"mode": "page", "page": 2, "note": ""})
            with self.assertRaises(ValueError):
                notehelp.handle(H(), self.ws, {"mode": "page", "page": 9})
            with self.assertRaises(ValueError):
                notehelp.handle(H(), self.ws, {"mode": "summary"})
        self.assertEqual(seen["code"], 200)
        self.assertEqual(seen["images"], [img])
        self.assertIn("第 2 页", seen["text"])
        out = "".join(sent)
        self.assertIn("梯度下降", out)
        self.assertIn('"done": true', out)


if __name__ == "__main__":
    unittest.main()
