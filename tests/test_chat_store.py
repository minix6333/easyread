import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import chat_store
from easyread.store import Workspace, write_json_atomic


class ChatStoreTest(unittest.TestCase):
    def test_empty_chat_can_be_created_renamed_and_deleted(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            write_json_atomic(ws.root / "chat.json", {})
            chat_store.append(ws, "t1", {"content": "q"}, "a", "m", "M")
            chat_store.rename(ws, "t1", "renamed")
            self.assertEqual(chat_store.get(ws, "t1")["title"], "renamed")
            chat_store.delete(ws, "t1")
            self.assertEqual(chat_store.threads(ws), [])

    def test_bookmarks_go_on_an_answer_or_on_its_question(self):
        # 書籤：記在那一則上（跟著對話存、同步）；問題沒有 id，用它後面那則回答的 id ＋「?」指它
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            write_json_atomic(ws.root / "chat.json", {})
            a1 = chat_store.append(ws, "t1", {"content": "q1"}, "a1", "m", "M")
            chat_store.append(ws, "t1", {"content": "q2"}, "a2", "m", "M")
            chat_store.mark(ws, "t1", a1["id"], True)
            chat_store.mark(ws, "t1", a1["id"] + "?", True)
            msgs = chat_store.get(ws, "t1")["messages"]
            self.assertTrue(msgs[1].get("mark") and msgs[0].get("mark"))
            self.assertFalse(msgs[3].get("mark"))
            chat_store.mark(ws, "t1", a1["id"], False)
            self.assertNotIn("mark", chat_store.get(ws, "t1")["messages"][1])
            with self.assertRaises(KeyError):
                chat_store.mark(ws, "t1", "nope", True)
            with self.assertRaises(KeyError):
                chat_store.mark(ws, "t9", a1["id"], True)

    def test_library_scope_keeps_the_citation_order_on_the_thread(self):
        # 問整個文獻庫：範圍和出處代號的順序記在對話上（追問照這個順序），不放進每一則訊息；換回「這份」就拿掉
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            write_json_atomic(ws.root / "chat.json", {})
            chat_store.append(ws, "t1", {"content": "q", "scope": {"kind": "all"}, "docs": ["a1b2c3", "d4e5f6"]}, "a", "m", "M")
            t = chat_store.get(ws, "t1")
            self.assertEqual(t["scope"], {"kind": "all"})
            self.assertEqual(t["docs"], ["a1b2c3", "d4e5f6"])
            self.assertNotIn("docs", t["messages"][0])
            chat_store.append(ws, "t1", {"content": "q2"}, "a2", "m", "M")
            t = chat_store.get(ws, "t1")
            self.assertNotIn("scope", t)
            self.assertNotIn("docs", t)

    def test_same_clock_tick_does_not_alias_threads_or_pinned_answers(self):
        with tempfile.TemporaryDirectory() as d, patch("time.time", return_value=1):
            ws = Workspace(Path(d))
            write_json_atomic(ws.paper_path, {"blocks": [{"id": "p1"}]})
            tids = [chat_store.new_id() for _ in range(10)]
            self.assertEqual(len(set(tids)), 10)
            user = {"content": "q", "anchor": "p1"}
            first = chat_store.append(ws, tids[0], user, "first answer", "m", "M")
            second = chat_store.append(ws, tids[0], user, "second answer", "m", "M")
            self.assertNotEqual(first["id"], second["id"])
            chat_store.pin(ws, tids[0], second["id"])
            self.assertEqual(ws.load("discussion")["entries"][0]["body"], "second answer")
