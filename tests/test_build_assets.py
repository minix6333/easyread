"""匯出離線 HTML（build.py）要把頁面引用的程式和樣式內嵌進去：每一個都要找得到檔案。
網址後面的 ?v=3（換版本時讓瀏覽器重新拿）不是檔名的一部分——2.1.0-tw.13 加上去時匯出壞過一次。"""
import unittest

from easyread import build
from easyread.config import WEB


class BuildAssets(unittest.TestCase):
    def test_every_script_and_stylesheet_of_the_reader_resolves(self):
        html = (WEB / "reader.html").read_text(encoding="utf-8")
        scripts, links = build._SCRIPT.findall(html), build._LINK.findall(html)
        self.assertTrue(scripts and links)
        for rel in scripts + links:
            self.assertNotIn("?", rel, rel)
            self.assertTrue((WEB / rel).is_file(), rel)
        self.assertIn("vendor/liquid-glass.js", scripts)


if __name__ == "__main__":
    unittest.main()
