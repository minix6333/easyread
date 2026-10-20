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
        self.assertNotIn("以下要求优先", plain)  # 一般的問題只有通用寫法（裡面會提到示意圖怎麼畫），沒有專門的要求
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

    def test_notes_ai_knows_how_to_draw_real_figures_but_only_when_asked(self):
        paper = self.ws.load("paper")
        paper["meta"]["target"] = "zh-TW"
        write_json_atomic(self.ws.paper_path, paper)
        with patch.object(notehelp.webimg, "enabled", lambda: True):
            write = notehelp.edit_prompt(self.ws, {"mode": "write", "note": "# 我的筆記", "ask": "畫一張這個方法的架構圖"}, "openai")
            edit = notehelp.edit_prompt(self.ws, {"mode": "edit", "note": "# 我的筆記\n\n一段", "selection": "一段", "ask": "改清楚"}, "openai")
            alone = notehelp.note_prompt({"title": "隨手記", "body": ""}, {"mode": "write", "ask": "畫流程圖"})
        for text in (write, edit):
            self.assertIn("只有他要你畫圖、或他選的那一段本來就有圖時才畫", text)  # 筆記是讀者自己的：沒要求不要自己加圖
            self.assertIn("不要 ASCII 圖", text)
            self.assertIn("參數、函數", text)  # 用詞那一段也在
        for text in (write, edit, alone):
            self.assertIn("```flow", text)
            self.assertIn("```pic", text)
            self.assertIn("ASCII", text)
            self.assertLess(text.index("```flow"), text.index("<<<"))  # 規則在前，筆記和要求在後
        with patch.object(notehelp.webimg, "enabled", lambda: False):  # 設定裡關掉網路上的圖：不提 pic
            self.assertNotIn("```pic", notehelp.edit_prompt(self.ws, {"mode": "write", "note": "", "ask": "x"}, "openai"))

    def test_notes_ai_gets_numbered_blocks_the_scope_and_the_operation_names(self):
        tw_ = patch.object(notehelp.langs, "reply_code", lambda meta=None: "zh-TW")  # 繁體介面（台灣）
        tw_.start()
        self.addCleanup(tw_.stop)
        body = {"blocks": ["# 我的筆記", "梯度下降：每次往負梯度走一小步", "- 學習率要小\n- 太大會發散"], "scope": {"from": 1, "to": 2},
                "picked": "負梯度", "ask": "把這段排版排好", "page": 2}
        text = notehelp.auto_prompt(self.ws, body, "openai")
        self.assertIn("[1]\n# 我的筆記\n[2]\n梯度下降", text)
        self.assertIn("讀者選了第 2–3 塊。", text)
        self.assertIn("他反白了這些字：「負梯度」", text)
        self.assertIn("待辦「- [ ] 」", text)  # 操作名稱對到編輯器的寫法
        self.assertIn("@@ replace A-B", text)
        self.assertIn("We minimise the loss", text)  # 讀者在第 2 頁：這一頁的字
        self.assertTrue(text.rstrip().endswith("讀者的要求：把這段排版排好"))
        # 沒選、游標在某一塊；空的筆記
        cur = notehelp.note_auto_prompt({"title": "隨手記"}, {"blocks": ["甲", "乙"], "cursor": 1, "ask": "寫一段總結"})
        self.assertIn("讀者的游標在第 2 塊。", cur)
        self.assertNotIn("文件", cur.split("讀者的整份筆記")[1])  # 獨立筆記：沒有文件可以對照
        empty = notehelp.note_auto_prompt({"title": ""}, {"blocks": [], "ask": "寫個大綱"})
        self.assertIn("（還是空的，一塊都沒有）", empty)
        self.assertIn("他沒有選任何地方", empty)

    def test_the_readers_own_words_are_not_converted(self):
        # 簡體介面：說明轉成簡體，但讀者的筆記、反白的字、要求、回答原樣給（轉換器會動到用字）
        with patch.object(notehelp.langs, "reply_code", lambda meta=None: "zh"):
            text = notehelp.note_auto_prompt({"title": "隨手記"}, {"blocks": ["學習率要小", "資料集"], "scope": {"from": 0, "to": 0}, "picked": "學習率", "ask": "改成待辦清單"})
            self.assertIn("[1]\n學習率要小\n[2]\n資料集", text)
            self.assertIn("「學習率」", text)
            self.assertIn("读者的要求：改成待辦清單", text)
            self.assertIn("读者选了第 1 块。", text)
            note = notehelp.asnote_prompt({}, {"question": "學習率是什麼？", "answer": "學習率決定每一步走多遠。"})
            self.assertIn("學習率決定每一步走多遠。", note)
            self.assertIn("改写成笔记，不是回答", note)

    def test_a_long_note_keeps_the_chosen_blocks_whole(self):
        tw_ = patch.object(notehelp.langs, "reply_code", lambda meta=None: "zh-TW")
        tw_.start()
        self.addCleanup(tw_.stop)
        blocks = ["第 %d 段：" % i + "內容" * 400 for i in range(40)]  # 約 32000 字，超過 AUTO_BUDGET
        text = notehelp.note_auto_prompt({"title": "長"}, {"blocks": blocks, "scope": {"from": 30, "to": 30}, "ask": "改短"})
        self.assertIn("[31]\n第 30 段：" + "內容" * 400, text)  # 選到的那一塊：全文
        self.assertIn("[1]\n第 0 段：" + "內容" * 50, text)
        self.assertIn("這一塊沒有給全文，不要改它", text)
        self.assertIn("[40]", text)  # 編號都在

    def test_an_answer_is_rewritten_as_a_note(self):
        tw_ = patch.object(notehelp.langs, "reply_code", lambda meta=None: "zh-TW")
        tw_.start()
        self.addCleanup(tw_.stop)
        text = notehelp.asnote_prompt({"title_en": "Test paper"}, {"question": "反向傳播是什麼？", "answer": "好問題！簡單來說……"})
        self.assertIn("改寫成筆記，不是回答", text)
        self.assertIn("「### 」", text)
        self.assertIn("讀者原本問的是", text)
        self.assertIn("反向傳播是什麼？", text)
        self.assertIn("好問題！簡單來說……", text)

    def test_notes_ai_requests_are_checked(self):
        with patch.object(notehelp.chat_models, "engine_cfg", lambda cfg, model: ({"engine": "openai"}, {"model": "m"})):
            with self.assertRaises(ValueError):
                notehelp.handle(None, self.ws, {"mode": "auto", "blocks": "not a list", "ask": "x"})
            with self.assertRaises(ValueError):
                notehelp.handle(None, self.ws, {"mode": "auto", "blocks": [], "ask": "  "})
            with self.assertRaises(ValueError):
                notehelp.handle(None, self.ws, {"mode": "asnote", "answer": ""})

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
