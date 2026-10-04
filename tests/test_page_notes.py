"""每頁筆記（page_note）和閱讀進度的頁碼：和別的操作一樣冪等、以較新的為準。  python -m unittest tests.test_page_notes"""
import unittest

from easyread.store import apply_ops, empty_reader


class PageNoteTest(unittest.TestCase):
    def test_page_note_is_keyed_by_page_and_newer_wins(self):
        reader = empty_reader()
        done = apply_ops(reader, [{"op": "page_note", "page": 3, "body": "舊", "at": "2026-10-04T10:00:00+08:00"},
                                  {"op": "page_note", "page": 3, "body": "新", "at": "2026-10-04T11:00:00+08:00"},
                                  {"op": "page_note", "page": 3, "body": "更舊", "at": "2026-10-04T09:00:00+08:00"},
                                  {"op": "page_note", "page": "x", "body": "壞頁碼", "at": "2026-10-04T12:00:00+08:00"}])
        self.assertEqual(reader["page_notes"], {"3": {"body": "新", "at": "2026-10-04T11:00:00+08:00"}})
        self.assertEqual(done, ["page_note:3", "page_note:3"])
        self.assertEqual(reader["rev"], 1)

    def test_progress_keeps_page(self):
        reader = empty_reader()
        apply_ops(reader, [{"op": "progress", "block": "p2-1", "ratio": 0.1, "page": 2, "at": "2026-10-04T10:00:00+08:00"}])
        self.assertEqual(reader["progress"]["page"], 2)
        apply_ops(reader, [{"op": "progress", "block": "p3-1", "ratio": 0.2, "at": "2026-10-04T10:01:00+08:00"}])
        self.assertEqual((reader["progress"]["block"], reader["progress"]["page"]), ("p3-1", 2))  # 文章優先時沒帶頁碼，留著上次的


if __name__ == "__main__":
    unittest.main()
