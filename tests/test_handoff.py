"""交給外部 AI、從外部 AI 拿回來（handoff.py）：附給它的檔案（檔名用標題、放在本機快取、內容沒變不重做）、
回答存回來變成提問紀錄或筆記。python -m unittest tests.test_handoff"""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

from easyread import config  # noqa: F401 —— 先載 config（模組之間有循環 import）
from easyread import handoff
from easyread.store import Workspace


def _paper(root: Path, title: str, pages: int = 3) -> Workspace:
    root.mkdir(parents=True)
    imgs = [Image.new("RGB", (400, 520), "white") for _ in range(pages)]
    imgs[0].save(root / "source.pdf", "PDF", save_all=True, append_images=imgs[1:], resolution=72)
    meta = {"title_en": title, "pages": [{"w": 400, "h": 520} for _ in range(pages)]}
    (root / "paper.json").write_text(json.dumps({"meta": meta, "blocks": []}), encoding="utf-8")
    return Workspace(root)


class Handoff(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._cache = config.CACHE_DIR
        config.CACHE_DIR = self.tmp / "cache"
        self.ws = _paper(self.tmp / "abcd1234", "Microsoft PowerPoint - Deep Learning_C2 - Copy")

    def tearDown(self):
        config.CACHE_DIR = self._cache

    def test_the_pdf_is_shared_under_its_title_and_reused(self):
        r = handoff.share_file(self.ws, "pdf")
        p = Path(r["path"])
        self.assertEqual(p.name, "Deep Learning C2.pdf")  # 投影片檔名的「Microsoft PowerPoint -」「- Copy」拿掉
        self.assertEqual(p.parent, self.tmp / "cache" / "abcd1234" / "share")  # 在本機快取，不在文件資料夾（不進雲端硬碟）
        self.assertEqual(p.read_bytes(), (self.ws.root / "source.pdf").read_bytes())
        before = p.stat().st_mtime_ns
        time.sleep(0.01)
        self.assertEqual(handoff.share_file(self.ws, "pdf")["path"], str(p))
        self.assertEqual(p.stat().st_mtime_ns, before)  # 沒變就不重做

    def test_a_page_is_shared_as_a_jpeg_and_bad_pages_are_refused(self):
        r = handoff.share_file(self.ws, "page", 2)
        self.assertEqual(Path(r["path"]).name, "Deep Learning C2 p2.jpg")
        with Image.open(r["path"]) as im:
            self.assertEqual(im.format, "JPEG")
        handoff.share_file(self.ws, "page", 3)
        self.assertEqual(sorted(f.name for f in Path(r["path"]).parent.iterdir()), ["Deep Learning C2 p3.jpg"])  # 換一頁：舊的那張拿掉
        with self.assertRaises(ValueError):
            handoff.share_file(self.ws, "page", 9)
        with self.assertRaises(ValueError):
            handoff.share_file(self.ws, "zip")

    def test_a_text_file_for_the_floating_window(self):
        # 漂浮小視窗附上的「原本的對話」：Markdown 放在快取的 dock/share；同名蓋掉、別的名字清掉；空的不收
        a = handoff.share_text("原本的對話", "# 對話\n\n## 我\n\n問題")
        self.assertTrue(a["path"].endswith(os.path.join("dock", "share", "原本的對話.md")))
        self.assertEqual(Path(a["path"]).read_text(encoding="utf-8"), "# 對話\n\n## 我\n\n問題")
        b = handoff.share_text("別的/名字", "x")
        self.assertEqual(b["name"], "別的 名字.md")
        self.assertFalse(Path(a["path"]).exists())
        with self.assertRaises(ValueError):
            handoff.share_text("x", "  ")

    def test_an_answer_is_saved_as_a_question_card_with_the_ai_as_the_byline(self):
        note = handoff.add_qa(self.ws, 2, "  連續的隨機變數\n期望值為什麼要用積分？ ", "因為……見第 2 頁。\n\n$E[X]=\\int x p(x)\\,dx$", "ChatGPT")
        reader, disc = self.ws.load("reader"), self.ws.load("discussion")
        saved = reader["notes"][note["id"]]
        self.assertEqual((saved["kind"], saved["page"], saved["side"], saved["body"]), ("question", 2, "pdf", "連續的隨機變數 期望值為什麼要用積分？"))
        self.assertRegex(note["id"], r"^n[0-9a-z]+$")
        reply = [e for e in disc["entries"] if e.get("reply_to") == note["id"]]
        self.assertEqual(len(reply), 1)
        self.assertEqual((reply[0]["kind"], reply[0]["by"]), ("reply", "ChatGPT"))
        self.assertIn("$E[X]=\\int x p(x)\\,dx$", reply[0]["body"])
        untitled = handoff.add_qa(self.ws, 1, "", "只有回答", "Gemini")
        self.assertEqual(self.ws.load("reader")["notes"][untitled["id"]]["body"], "（外部 AI 的回答）")
        with self.assertRaises(ValueError):
            handoff.add_qa(self.ws, 1, "問題", "  ", "ChatGPT")

    def test_a_plain_note_and_page_clamping(self):
        note = handoff.add_note(self.ws, 99, "記一下", quote="原文", src="Claude")
        saved = self.ws.load("reader")["notes"][note["id"]]
        self.assertEqual((saved["kind"], saved["page"], saved["quote"], saved["src"]), ("note", 3, "原文", "Claude"))  # 頁碼超過就放最後一頁
        self.assertEqual(handoff.handle(self.ws, {"do": "note", "page": 1, "body": "x"})["note"]["page"], 1)
        with self.assertRaises(ValueError):
            handoff.handle(self.ws, {"do": "delete"})


if __name__ == "__main__":
    unittest.main()
