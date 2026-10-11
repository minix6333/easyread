"""自選的背景圖（easyread/backdrop.py）：只收 JPEG 的 data URL，存在偏好旁邊。"""
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import backdrop

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64
URL = backdrop.PREFIX + base64.b64encode(JPEG).decode()


class BackdropTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(backdrop, "_dir", lambda: Path(self.tmp.name))
        p.start()
        self.addCleanup(p.stop)

    def test_nothing_saved_means_no_file(self):
        self.assertIsNone(backdrop.path("full"))
        self.assertIsNone(backdrop.path("small"))
        self.assertIsNone(backdrop.path("../prefs.json"))

    def test_saves_both_sizes_and_returns_a_version(self):
        r = backdrop.save({"image": URL, "small": URL})
        self.assertTrue(r["ok"])
        self.assertGreater(r["v"], 0)
        self.assertEqual(backdrop.path("full").read_bytes(), JPEG)
        self.assertEqual(backdrop.path("small").read_bytes(), JPEG)
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).iterdir()), ["backdrop-s.jpg", "backdrop.jpg"])

    def test_rejects_anything_that_is_not_a_jpeg_data_url(self):
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNG").decode()
        fake = backdrop.PREFIX + base64.b64encode(b"<svg onload=alert(1)>").decode()
        for bad in (None, "", "http://example.com/a.jpg", png, fake, backdrop.PREFIX + "@@@"):
            with self.assertRaises(ValueError):
                backdrop.save({"image": bad, "small": URL})
        with self.assertRaises(ValueError):
            backdrop.save("not a dict")
        self.assertIsNone(backdrop.path("full"))

    def test_rejects_an_oversized_image(self):
        with patch.object(backdrop, "MAX_SMALL", 16):
            with self.assertRaises(ValueError):
                backdrop.save({"image": URL, "small": URL})


if __name__ == "__main__":
    unittest.main()
