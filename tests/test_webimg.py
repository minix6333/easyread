"""回答裡的網路圖片（webimg.py）：挑圖、排序、快取、只認維基的圖檔網址。不連網（_api、http.urlopen 都換成假的）。
python -m unittest tests.test_webimg"""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import chat, config, webimg
from easyread.store import write_json_atomic
from tests.test_translate import make_ws

UP = "https://upload.wikimedia.org/wikipedia/commons/"
TH = "https://thumb.wikimedia.org/wikipedia/commons/thumb/"


def page(name, w=1200, h=800, mime="image/png", repo="shared", desc="", index=0, url=None, artist="<a href=\"//x\">Alice</a>"):
    return {"title": "File:" + name, "index": index, "imagerepository": repo,
            "imageinfo": [{"mime": mime, "width": w, "height": h, "thumbwidth": min(w, 960), "thumbheight": round(min(w, 960) * h / w),
                           "thumburl": (url or TH + "a/ab/" + name.replace(" ", "_") + "/960px-" + name.replace(" ", "_")) + "?utm_source=commons.wikimedia.org",
                           "descriptionurl": "https://commons.wikimedia.org/wiki/File:" + name.replace(" ", "_"),
                           "extmetadata": {"Artist": {"value": artist}, "LicenseShortName": {"value": "CC BY-SA 4.0"},
                                           "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"}, "ImageDescription": {"value": "<p>" + desc + "</p>"}}}]}


class PickTest(unittest.TestCase):
    def test_keywords_drop_filler_words(self):
        self.assertEqual(webimg.words_of("The maximum margin hyperplane diagram of an SVM model"), ["maximum", "margin", "hyperplane", "svm"])
        self.assertEqual(webimg.words_of(""), [])

    def test_candidate_keeps_real_pictures_only(self):
        ok = webimg.candidate(page("SVM margin.png", desc="Maximum-margin <b>hyperplane</b>"))
        self.assertEqual((ok["name"], ok["w"], ok["h"], ok["artist"], ok["license"]), ("SVM margin.png", 960, 640, "Alice", "CC BY-SA 4.0"))
        self.assertEqual(ok["src"], TH + "a/ab/SVM_margin.png/960px-SVM_margin.png")  # 統計用的 ?utm_… 去掉了
        self.assertEqual(ok["desc"], "Maximum-margin hyperplane")
        for bad in (page("Wiki letter w cropped.svg", 44, 31, "image/svg+xml"), page("OOjs UI icon edit-ltr.svg", 20, 20, "image/svg+xml"),
                    page("Question book-new.svg", 512, 399, "image/svg+xml"), page("Commons-logo.svg", 1024, 1376, "image/svg+xml"),
                    page("Paper.pdf", 1200, 1600, "application/pdf"), page("Banner.png", 3000, 200), page("Evil.png", url="https://example.com/evil.png"),
                    {"title": "File:Missing.png", "missing": True}):
            self.assertIsNone(webimg.candidate(bad), bad["title"])
        # 出處的連結只認維基自己的網址；不是的話照檔名組一個（它會變成頁面上可以點的連結）
        odd = page("SVM margin.png")
        odd["imageinfo"][0]["descriptionurl"] = "javascript:alert(1)"
        self.assertEqual(webimg.candidate(odd)["page"], "https://commons.wikimedia.org/wiki/File:SVM_margin.png")
        self.assertEqual(ok["page"], "https://commons.wikimedia.org/wiki/File:SVM_margin.png")
        local = page("Fair use poster.png", repo="local")
        self.assertIsNone(webimg.candidate(local, shared_only=True))  # 英文維基自己存的（多半是合理使用）不拿
        self.assertIsNotNone(webimg.candidate(local))                 # 共享資源自己查自己時 repository 就是 local

    def test_rank_by_what_to_look_for_then_article_name_then_lead(self):
        items = [webimg.candidate(p) for p in (page("Rosa Gold Glow.png"), page("K-means convergence.gif", mime="image/gif"), page("Voronoi cells.png", desc="k-means result"),
                                                page("K-means parallel simplified.png"))]
        topic = webimg.words_of("K-means clustering")
        self.assertEqual([i["name"] for i in webimg.rank(items, [], topic=topic)][:2], ["K-means convergence.gif", "K-means parallel simplified.png"])
        self.assertEqual(webimg.rank(items, webimg.words_of("convergence"), topic=topic)[0]["name"], "K-means convergence.gif")
        self.assertEqual(webimg.rank(items, [], lead="Rosa_Gold_Glow.png")[0]["name"], "Rosa Gold Glow.png")
        # 搜尋來的要真的對得上關鍵詞才留：「Adagrad」不會變成一張演講者的照片
        self.assertEqual(webimg.rank([webimg.candidate(page("Leon Bottou 01.jpg", mime="image/jpeg"))], ["adagrad"], need=0.5), [])


class LookupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        p = mock.patch.object(config, "CACHE_DIR", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        self.calls = []

    def api(self, answers):
        def fake(base, params):
            self.calls.append((base, params))
            for test, pages in answers:
                if test(base, params):
                    return {"query": {"pages": pages}}
            return {}
        return mock.patch.object(webimg, "_api", fake)

    def test_article_images_first_then_commons_search(self):
        wiki = lambda b, p: b == webimg.WIKI and p.get("generator") == "images"  # noqa: E731
        search = lambda b, p: b == webimg.COMMONS and p.get("generator") == "search"  # noqa: E731
        with self.api([(wiki, [page("Kernel Machine.svg", mime="image/svg+xml"), page("SVM margin.png"), page("Wiki letter w.svg", 44, 31, "image/svg+xml")])]):
            got = webimg.lookup("Support vector machine", "maximum margin")
        self.assertEqual([i["name"] for i in got], ["SVM margin.png", "Kernel Machine.svg"])
        self.assertFalse(any(p.get("generator") == "search" for _, p in self.calls))  # 條目裡有就不另外搜尋
        self.calls.clear()
        with self.api([(search, [page("Bias-variance-tradeoff.png", index=1), page("Portrait of someone.jpg", mime="image/jpeg", index=2)])]):
            got = webimg.lookup("No Such Article", "bias variance tradeoff")
        self.assertEqual([i["name"] for i in got], ["Bias-variance-tradeoff.png"])
        with self.api([]):
            self.assertEqual(webimg.lookup("", "Adagrad"), [])

    def test_exact_file_name_wins(self):
        by_title = lambda b, p: b == webimg.COMMONS and p.get("titles") == "File:SVM margin.png"  # noqa: E731
        with self.api([(by_title, [page("SVM margin.png")])]):
            self.assertEqual([i["name"] for i in webimg.lookup("", "", "File:SVM margin.png")], ["SVM margin.png"])

    def test_find_caches_and_survives_no_network(self):
        wiki = lambda b, p: p.get("generator") == "images"  # noqa: E731
        with self.api([(wiki, [page("SVM margin.png")])]):
            first = webimg.find("Support vector machine", "margin")
            n = len(self.calls)
            self.assertEqual(webimg.find("support vector machine", "Margin"), first)  # 大小寫不同也算同一個查詢
            self.assertEqual(len(self.calls), n)  # 第二次沒有再連網
        self.assertEqual(webimg.find("", "", ""), {"items": []})
        with mock.patch.object(webimg, "_api", side_effect=OSError("offline")):
            self.assertEqual(webimg.find("Support vector machine", "margin"), first)  # 有記著的就用記著的
            self.assertEqual(webimg.find("Another article", "x"), {"items": [], "error": True})
        self.assertEqual(list(self.tmp.glob("webimg/q-*.json")).__len__(), 1)  # 出錯的那次不記（下次再試）

    def test_fetch_only_takes_wikimedia_image_urls(self):
        seen = []

        def urlopen(req, timeout=0):
            seen.append(req.full_url)
            return io.BytesIO(b"<html>Too many requests</html>" if "error-page" in req.full_url else b"\x89PNG\r\n\x1a\n fake")
        with mock.patch.object(webimg.http, "urlopen", urlopen):
            good = webimg.fetch(TH + "7/72/SVM_margin.png/960px-SVM_margin.png")
            self.assertTrue(good and good.read_bytes().startswith(b"\x89PNG"))
            self.assertEqual(webimg.fetch(TH + "7/72/SVM_margin.png/960px-SVM_margin.png"), good)
            self.assertEqual(len(seen), 1)  # 第二次直接拿快取
            # 回來的不是圖（錯誤頁）：不給、也不存成快取——不然之後每次都拿到那個壞檔
            self.assertIsNone(webimg.fetch(UP + "a/ab/error-page.png"))
            self.assertEqual(len(list(self.tmp.glob("webimg/*.png"))), 1)
            seen.pop()
            for bad in ("https://example.com/a.png", "http://upload.wikimedia.org/wikipedia/commons/a.png", UP + "../../etc/passwd.png", UP + "a.png?x=1",
                        UP + "a.svg", UP + "a.exe", "file:///etc/passwd", "", None):
                self.assertIsNone(webimg.fetch(bad), bad)
        self.assertEqual(len(seen), 1)

    def test_setting_switches_the_prompt_and_the_lookup(self):
        ws = make_ws(1)
        self.addCleanup(__import__("shutil").rmtree, ws.root, True)
        paper = ws.load("paper")
        paper["meta"]["target"] = "zh-TW"
        write_json_atomic(ws.root / "paper.json", paper)
        msgs = [{"role": "user", "content": "這段在說什麼"}]
        on = chat.prompt(ws, msgs, None, "", "openai", pics=True)
        off = chat.prompt(ws, msgs, None, "", "openai", pics=False)
        self.assertIn("```pic", on)
        self.assertIn("條目：", on)
        self.assertNotIn("```pic", off)
        for text in (on, off):
            self.assertIn("不要 ASCII 圖", text)   # 架構圖一律畫成真的圖
            self.assertIn("```flow", text)
            self.assertIn('class="c2 fill"', text)   # 自己畫的 svg：怎麼塗滿、怎麼上淡色（不講的話點都是空心的）
            self.assertIn("講道理，不要只丟結論", text)
            self.assertIn("參數、函數", text)      # 提示詞自己也不能被轉成「引數、函式」
            for old in ("出發點", "一句話記住", "關鍵觀念"):  # 以前的固定格式
                self.assertNotIn(old, text)
        with mock.patch.object(webimg.config, "load", lambda: {"web_images": False}):
            self.assertFalse(webimg.enabled())
            self.assertNotIn("```pic", chat.prompt(ws, msgs, None, "", "openai"))
        with mock.patch.object(webimg.config, "load", lambda: {}):
            self.assertTrue(webimg.enabled())


if __name__ == "__main__":
    unittest.main()
