"""獨立筆記（notes.py）：外觀／整理的欄位、複製一份、刪除進回收站再復原、分類改名。"""
import tempfile
import unittest
from pathlib import Path

from easyread import config  # noqa: F401  先載 config（store 和它互相匯入）
from easyread import notes, trash


class StandaloneNotesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_style_fields_are_validated_and_listed(self):
        n = notes.create(self.root, "課堂筆記", "# 第一週\n\n- [ ] 複習")
        saved = notes.save(self.root, n["id"], style={"icon": "Flask", "color": "teal", "folder": "  機器  學習 ", "star": 1, "wide": True, "font": "serif", "evil": "x"})
        self.assertEqual((saved["icon"], saved["color"], saved["folder"], saved["star"], saved["wide"], saved["font"]), ("flask", "teal", "機器 學習", True, True, "serif"))
        self.assertNotIn("evil", saved)
        row = notes.listing(self.root)[0]
        self.assertEqual((row["icon"], row["color"], row["folder"], row["star"]), ("flask", "teal", "機器 學習", True))
        self.assertEqual(row["preview"], "第一週 複習")
        # 不合格的值當成沒設；設成空的就拿掉
        cleared = notes.save(self.root, n["id"], style={"icon": "../x", "font": "comic", "folder": "", "star": False})
        self.assertEqual((cleared["icon"], cleared["font"], cleared["folder"], cleared["star"]), ("", "", "", False))
        self.assertEqual(cleared["color"], "teal")  # 沒提到的欄位不動

    def test_preview_keeps_only_readable_text(self):
        md = "# 梯度下降\n\n有**粗體**、*斜體*、`碼`和 $\\nabla f$，[連結](https://e.com)在這。\n\n> [!note] 重點\n> 會發散。\n\n```python\nprint(1)\n```\n\n$$\nE=mc^2\n$$\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n1. 一\n- [x] 做完\n![](clips/a.png)"
        n = notes.create(self.root, "t", md)
        self.assertEqual(notes.listing(self.root)[0]["preview"], "梯度下降 有粗體、斜體、碼和 ，連結在這。 重點 會發散。 a b 1 2 一 做完")
        self.assertEqual(n["body"], md)

    def test_style_only_save_keeps_updated_time(self):
        n = notes.create(self.root, "a", "b")
        (self.root / "_notes" / n["id"] / "note.json").write_text('{"title": "a", "created": "2026-01-01T00:00:00+08:00", "updated": "2026-01-01T00:00:00+08:00"}', encoding="utf-8")
        self.assertEqual(notes.save(self.root, n["id"], style={"star": True})["updated"], "2026-01-01T00:00:00+08:00")
        self.assertEqual(notes.save(self.root, n["id"], title="a", body="b")["updated"], "2026-01-01T00:00:00+08:00")  # 內容沒變也不算
        self.assertNotEqual(notes.save(self.root, n["id"], body="改了")["updated"], "2026-01-01T00:00:00+08:00")

    def test_duplicate_copies_body_clips_and_style_but_not_star(self):
        n = notes.create(self.root, "原本", "內容 ![](clips/a.png)", style={"icon": "atom", "color": "blue", "star": True})
        clips = self.root / "_notes" / n["id"] / "clips"
        clips.mkdir()
        (clips / "a.png").write_bytes(b"png")
        copy = notes.duplicate(self.root, n["id"])
        self.assertNotEqual(copy["id"], n["id"])
        self.assertTrue(copy["title"].startswith("原本 "))
        self.assertEqual((copy["body"], copy["icon"], copy["color"], copy["star"]), ("內容 ![](clips/a.png)", "atom", "blue", False))
        self.assertEqual((self.root / "_notes" / copy["id"] / "clips" / "a.png").read_bytes(), b"png")
        self.assertEqual(notes.listing(self.root)[0]["cover"], "clips/a.png")

    def test_delete_goes_to_trash_and_restores(self):
        n = notes.create(self.root, "要刪的", "x", style={"icon": "leaf"})
        name = notes.delete(self.root, n["id"])
        self.assertRegex(name, r"^note-[0-9a-f]{12}-\d{14}$")
        self.assertIsNone(notes.get(self.root, n["id"]))
        self.assertEqual(notes.listing(self.root), [])
        item = trash.items(self.root)[0]
        self.assertEqual((item["kind"], item["title"], item["icon"], item["id"]), ("note", "要刪的", "leaf", n["id"]))
        self.assertEqual(trash.restore(self.root, name), n["id"])
        self.assertEqual(notes.get(self.root, n["id"])["body"], "x")
        self.assertEqual(notes.delete(self.root, "nope00"), "")
        # 回收站裡論文和筆記混著也能清空
        notes.delete(self.root, n["id"])
        (self.root / ".trash" / "aaaaaaaaaaaa-20261001120000").mkdir()
        self.assertEqual({t["kind"] for t in trash.items(self.root)}, {"note", "paper"})
        self.assertEqual(trash.empty(self.root), 2)

    def test_restore_refuses_to_overwrite(self):
        n = notes.create(self.root, "a", "x")
        name = notes.delete(self.root, n["id"])
        (self.root / "_notes" / n["id"]).mkdir(parents=True)
        with self.assertRaises(ValueError):
            trash.restore(self.root, name)

    def test_rename_folder_moves_notes(self):
        a = notes.create(self.root, "a", "", style={"folder": "舊"})
        b = notes.create(self.root, "b", "", style={"folder": "別的"})
        self.assertEqual(notes.rename_folder(self.root, "舊", "新"), 1)
        self.assertEqual(notes.get(self.root, a["id"])["folder"], "新")
        self.assertEqual(notes.rename_folder(self.root, "新", ""), 1)  # 刪掉分類：筆記留著，只是不在分類裡
        self.assertEqual(notes.get(self.root, a["id"])["folder"], "")
        self.assertEqual(notes.get(self.root, b["id"])["folder"], "別的")
        self.assertEqual(notes.rename_folder(self.root, "", "誤傷"), 0)  # 沒給舊名字：不動沒放分類的那些
        self.assertEqual(notes.get(self.root, a["id"])["folder"], "")

    def test_folder_styles_follow_renames(self):
        self.assertEqual(notes.folder_styles(self.root), {})
        notes.set_folder_style(self.root, "研究", icon="Atom", color="teal")
        notes.set_folder_style(self.root, "課", color="blue")
        self.assertEqual(notes.folder_styles(self.root), {"研究": {"icon": "atom", "color": "teal"}, "課": {"icon": "", "color": "blue"}})
        notes.set_folder_style(self.root, "課", color="")  # 都清掉就不留這一筆
        self.assertNotIn("課", notes.folder_styles(self.root))
        notes.rename_folder(self.root, "研究", "Research")
        self.assertEqual(notes.folder_styles(self.root), {"Research": {"icon": "atom", "color": "teal"}})
        notes.rename_folder(self.root, "Research", "")
        self.assertEqual(notes.folder_styles(self.root), {})
        self.assertEqual(notes.listing(self.root), [])  # _folders.json 不會被當成一份筆記
        with self.assertRaises(ValueError):
            notes.set_folder_style(self.root, "  ", icon="atom")

    def test_append_adds_an_excerpt_at_the_end(self):
        n = notes.create(self.root, title="摘錄", body="第一段\n")
        out = notes.append(self.root, n["id"], "> 引文\n>\n> —— [標題，第 3 頁](/read/abc123#page=3)", paper="abc123")
        self.assertEqual(out["body"], "第一段\n\n> 引文\n>\n> —— [標題，第 3 頁](/read/abc123#page=3)\n")
        self.assertEqual(out["papers"], ["abc123"])
        out = notes.append(self.root, n["id"], "\n再一段\n", paper="abc123")  # 同一份文件不重複記
        self.assertTrue(out["body"].endswith("#page=3)\n\n再一段\n"))
        self.assertEqual(out["papers"], ["abc123"])
        empty = notes.create(self.root)
        self.assertEqual(notes.append(self.root, empty["id"], "只有這一段")["body"], "只有這一段\n")  # 空白的筆記：前面不多空行
        self.assertEqual(notes.append(self.root, empty["id"], "   ")["body"], "只有這一段\n")  # 沒東西就不動
        with self.assertRaises(ValueError):
            notes.append(self.root, "ffffffffffff", "x")


if __name__ == "__main__":
    unittest.main()
