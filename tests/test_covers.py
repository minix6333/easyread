"""文獻庫卡片的封面（covers.py）：自動裁的、自己框的、做一次存起來。  python -m unittest tests.test_covers"""
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from easyread import config  # noqa: F401 —— 先載 config
from easyread import covers


def _portrait():
    """一張直的頁面：左邊頁邊有一直條（arXiv 印的那種），中間偏上是標題（黑的一塊）和幾行字。"""
    im = Image.new("RGB", (850, 1100), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((22, 300, 34, 800), fill=(120, 120, 120))            # 頁邊的直條
    d.rectangle((150, 120, 700, 170), fill="black")                    # 標題
    for k in range(8):
        d.rectangle((130, 260 + k * 30, 720, 270 + k * 30), fill=(60, 60, 60))  # 內文
    return im


class CoverRenderTest(unittest.TestCase):
    def test_clean_accepts_a_region_and_rejects_nonsense(self):
        self.assertEqual(covers.clean({"page": "3", "box": [0.1, 0.2, 0.61234567, 0.5]}), {"page": 3, "box": [0.1, 0.2, 0.6123, 0.5]})
        self.assertEqual(covers.clean({"page": 1, "box": [-1, 0, 2, 0.5]})["box"], [0.0, 0.0, 1.0, 0.5])  # 夾在頁面裡
        for bad in (None, "x", {}, {"page": 0, "box": [0, 0, 1, 1]}, {"page": 1, "box": [0, 0, 1]}, {"page": 1, "box": [0.5, 0.5, 0.51, 0.9]}, {"page": 1, "box": ["a", 0, 1, 1]}):
            self.assertIsNone(covers.clean(bad), bad)

    def test_portrait_page_shows_the_title_block_without_the_margin_strip(self):
        c = covers.render(_portrait(), None)
        self.assertEqual(c.size, covers.SIZE)
        g = c.convert("L")
        w, h = c.size
        # 最左邊一整條都是白的：頁邊那一直條被裁掉了（原圖裡它在 x≈3%）
        self.assertGreater(min(g.getpixel((2, y)) for y in range(0, h, 10)), 240)
        # 標題在最上面那一段（不是被擠到中間、也沒被裁掉）
        dark_rows = [y for y in range(h) if min(g.getpixel((x, y)) for x in range(w // 4, 3 * w // 4, 8)) < 40]
        self.assertTrue(dark_rows and dark_rows[0] < h * 0.2, dark_rows[:3])
        # 內文那幾行也看得到
        self.assertTrue(any(g.getpixel((w // 2, y)) < 100 for y in range(h // 2, h)))

    def test_landscape_page_is_used_whole(self):
        im = Image.new("RGB", (1600, 900), (20, 40, 120))
        ImageDraw.Draw(im).rectangle((700, 400, 900, 500), fill="white")
        c = covers.render(im, None)
        self.assertEqual(c.size, covers.SIZE)
        self.assertEqual(c.getpixel((6, 6))[2] > 90, True)            # 四個角還是投影片的底色（不是補的白）
        self.assertGreater(c.getpixel((covers.SIZE[0] // 2, covers.SIZE[1] // 2))[0], 200)  # 中間那塊在中間

    def test_chosen_region_is_shown_whole_on_white(self):
        im = Image.new("RGB", (1000, 1400), "white")
        ImageDraw.Draw(im).rectangle((100, 700, 400, 1300), fill=(200, 30, 30))  # 一塊高的圖
        c = covers.render(im, {"page": 1, "box": [0.1, 0.5, 0.4, 0.9286]})
        w, h = c.size
        self.assertEqual((w, h), covers.SIZE)
        self.assertGreater(c.getpixel((w // 2, h // 2))[0], 150)       # 中間是那塊紅的
        self.assertEqual(c.getpixel((4, h // 2)), (255, 255, 255))     # 兩邊補白（高的圖放進橫的框）
        self.assertLess(c.getpixel((w // 2, 6))[1], 80)                # 上下貼滿


class CoverFileTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()) / "abcd1234"
        (self.root / "pages").mkdir(parents=True)
        os.environ["EASYREAD_LIBRARY"] = str(self.root.parent)
        _portrait().save(self.root / "pages" / "page-001.webp", "WEBP")
        Image.new("RGB", (850, 1100), (10, 120, 10)).save(self.root / "pages" / "page-002.webp", "WEBP")

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)

    def test_made_once_and_remade_only_when_the_choice_changes(self):
        out = covers.cover(self.root)
        self.assertEqual(out, self.root / "pages" / "cover.webp")
        first = out.stat().st_mtime_ns
        with Image.open(out) as im:
            self.assertEqual(im.size, covers.SIZE)
        self.assertEqual(covers.cover(self.root).stat().st_mtime_ns, first)  # 第二次直接用，不重做
        spec = {"page": 2, "box": [0.2, 0.2, 0.8, 0.6]}
        self.assertNotEqual(covers.stamp(self.root, spec), covers.stamp(self.root, None))
        out2 = covers.cover(self.root, spec)
        with Image.open(out2) as im:
            r, g, b = im.convert("RGB").getpixel((covers.SIZE[0] // 2, covers.SIZE[1] // 2))
        self.assertTrue(g > 90 and r < 60 and b < 60, (r, g, b))  # 換成第二頁那塊綠的
        back = covers.cover(self.root, None)  # 恢復自動：又是第一頁
        with Image.open(back) as im:
            self.assertGreater(im.convert("L").getpixel((4, 4)), 240)
        self.assertEqual(sorted(f.name for f in (self.root / "pages").iterdir()), ["cover.json", "cover.webp", "page-001.webp", "page-002.webp"])

    def test_missing_page_falls_back_and_missing_pdf_gives_none(self):
        self.assertIsNotNone(covers.cover(self.root, {"page": 9, "box": [0.1, 0.1, 0.9, 0.9]}))  # 挑的那一頁沒了：退回自動的
        empty = self.root.parent / "ffff0000"
        (empty / "pages").mkdir(parents=True)
        self.assertIsNone(covers.cover(empty))


if __name__ == "__main__":
    unittest.main()
