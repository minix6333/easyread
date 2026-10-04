"""給模型看的圖片（clips.py）：框選區域從 PDF 渲染、貼進來的圖片存檔、請求裡的圖片名只認 clips/ 底下的。"""
import tempfile
import unittest
from pathlib import Path

from easyread import chat, clips, openai_api

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


def blank_pdf(path: Path, w=612, h=792):
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument.new()
    pdf.new_page(w, h)
    pdf.save(str(path))
    pdf.close()


class ClipsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_region_renders_the_selected_part_and_reuses_the_file(self):
        from PIL import Image
        blank_pdf(self.root / "source.pdf")
        rel = clips.region(self.root, 1, [0.25, 0.1, 0.75, 0.3])
        self.assertTrue(rel.startswith("clips/c-p1-") and rel.endswith(".png"))
        with Image.open(self.root / rel) as im:
            w, h = im.size
        self.assertLessEqual(max(w, h), clips.MAX_SIDE + 2)
        self.assertAlmostEqual(w / h, (0.5 * 612) / (0.2 * 792), delta=0.05)  # 長寬比跟框選的一樣
        self.assertEqual(clips.region(self.root, 1, [0.25, 0.1, 0.75, 0.3]), rel)  # 同一塊不重存
        self.assertEqual(clips.region(self.root, 1, [0.75, 0.3, 0.25, 0.1]), rel)  # 反著拖也一樣

    def test_region_rejects_bad_input(self):
        blank_pdf(self.root / "source.pdf")
        for page, rect in ((1, [0.1, 0.1, 0.1005, 0.5]), (1, "x"), (1, [0, 0, float("nan"), 1]), (9, [0, 0, 1, 1]), ("a", [0, 0, 1, 1])):
            with self.assertRaises(ValueError):
                clips.region(self.root, page, rect)

    def test_uploads_are_checked_by_content_and_stored_once(self):
        a = clips.save_upload(self.root, PNG)
        self.assertTrue(a.startswith("clips/u-") and a.endswith(".png"))
        self.assertEqual(clips.save_upload(self.root, PNG), a)
        self.assertTrue(clips.save_upload(self.root, JPG).endswith(".jpg"))
        self.assertTrue(clips.save_upload(self.root, b"RIFF\x00\x00\x00\x00WEBPVP8 ").endswith(".webp"))
        for bad in (b"", b"<svg></svg>", b"%PDF-1.7"):
            with self.assertRaises(ValueError):
                clips.save_upload(self.root, bad)

    def test_only_existing_files_under_clips_are_accepted(self):
        rel = clips.save_upload(self.root, PNG)
        (self.root / "paper.json").write_text("{}")
        got = clips.resolve(self.root, [rel, "../paper.json", "clips/../paper.json", "clips/missing.png", 5, rel])
        self.assertEqual([p.name for p in got], [Path(rel).name])
        self.assertEqual(clips.resolve(self.root, None), [])
        self.assertEqual(clips.rel(got[0]), rel)

    def test_prompt_tells_the_model_where_the_images_are(self):
        self.assertIn("clips/a.png", chat._images_hint(["clips/a.png"], "claude"))
        self.assertIn("Read", chat._images_hint(["clips/a.png"], "claude"))
        other = chat._images_hint(["clips/a.png", "clips/b.png"], "openai")
        self.assertIn("2", other)
        self.assertNotIn("Read", other)
        self.assertEqual(chat._images_hint([], "claude"), "")
        self.assertIn("clips/a.png", chat.images_note(["clips/a.png"]))
        self.assertEqual(chat.images_note(None), "")

    def test_api_images_keep_their_type_and_are_only_sent_when_allowed(self):
        img = self.root / "a.png"
        img.write_bytes(PNG)
        o = {"model": "m", "api": "chat"}
        self.assertEqual(openai_api._body(o, "hi", [img], True, None)["messages"][0]["content"], "hi")  # 沒說能看圖：不送
        parts = openai_api._body({**o, "vision": True}, "hi", [img], True, None)["messages"][0]["content"]
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
