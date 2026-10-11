"""偏好檔（prefs.json）要經得起：幾個頁面同時存、檔案被寫壞。

2.1.0-tw.5 換主題時前端有個迴圈，關視窗那一下幾個頁面同時存偏好；Windows 上兩條執行緒拿到同一個暫存檔名，
寫出來的 prefs.json 是「一份完整的 JSON 後面多一截」，之後每一頁都讀不了（畫面上只剩 {"error": "Extra data: …"}）。"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import config, prefs, store


class PrefsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "prefs.json"
        p = patch.object(prefs, "path", lambda: self.path)
        p.start()
        self.addCleanup(p.stop)

    def test_save_merges_sections_and_ignores_unknown_ones(self):
        prefs.save({"reader": {"theme": "dark", "fs": 21}})
        prefs.save({"reader": {"theme": "light"}, "ui": {"lang": "zh-TW"}, "nonsense": {"x": 1}, "keys": "not a dict"})
        self.assertEqual(prefs.load(), {"reader": {"theme": "light", "fs": 21}, "ui": {"lang": "zh-TW"}})

    def test_a_file_with_extra_data_after_the_json_is_salvaged_and_repaired(self):
        good = {"reader": {"theme": "dark", "fs": 21}, "ui": {"lang": "zh-TW"}}
        self.path.write_text(json.dumps(good, indent=1) + '": 1\n }\n}\n', encoding="utf-8")  # 兩次寫入疊在一起的樣子
        with self.assertRaises(ValueError):
            store.read_json(self.path, {})  # 一般的讀法會丟例外（資料檔就是要這樣）
        self.assertEqual(prefs.load(), good)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), good)  # 檔案修好了
        self.assertEqual(len(list(self.path.parent.glob("prefs.json.broken-*"))), 1)  # 壞的那份留著
        prefs.save({"reader": {"theme": "light"}})
        self.assertEqual(prefs.load()["reader"], {"theme": "light", "fs": 21})

    def test_garbage_or_an_empty_file_counts_as_no_preferences(self):
        for junk in ("", "\x00\x00\x00", "not json at all", '["a list, not an object"]', '{"reader": {"theme": "da'):
            self.path.write_text(junk, encoding="utf-8")
            self.assertEqual(prefs.load(), {}, junk)
            prefs.save({"reader": {"theme": "dark"}})
            self.assertEqual(prefs.load(), {"reader": {"theme": "dark"}})
            self.path.unlink()

    def test_many_pages_saving_at_once_leave_a_valid_file_with_every_key(self):
        # Windows 上 time.monotonic_ns() 一格 15.6 毫秒：把它定住，暫存檔名還是要每次不同
        errors = []

        def page(n):
            try:
                for i in range(25):
                    prefs.save({"reader": {f"k{n}_{i}": "x" * (n * 7 + i), "theme": "dark" if (n + i) % 2 else "light"}})
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        with patch.object(store.time, "monotonic_ns", return_value=1):
            threads = [threading.Thread(target=page, args=(n,)) for n in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(errors, [])
        data = json.loads(self.path.read_text(encoding="utf-8"))  # 是完整的 JSON
        self.assertEqual(len([k for k in data["reader"] if k.startswith("k")]), 8 * 25)  # 誰的都沒被蓋掉
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["prefs.json"])  # 沒留下暫存檔

    def test_concurrent_atomic_writes_to_one_file_never_interleave(self):
        target = Path(self.tmp.name) / "data.json"
        docs = [{"n": n, "pad": "y" * (n * 400)} for n in range(1, 9)]

        def write(doc):
            for _ in range(30):
                store.write_json_atomic(target, doc)
        with patch.object(store.time, "monotonic_ns", return_value=1):
            threads = [threading.Thread(target=write, args=(d,)) for d in docs]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertIn(json.loads(target.read_text(encoding="utf-8")), docs)


class ConfigFileTest(unittest.TestCase):
    def test_a_broken_config_file_falls_back_instead_of_failing_every_request(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "config.json"
            path.write_text('{"engine": "openai", "target": "zh-TW"}}}', encoding="utf-8")
            with patch.object(config, "CONFIG_PATH", path):
                cfg = config.load()
            self.assertEqual((cfg["engine"], cfg["target"]), ("openai", "zh-TW"))  # 前面完整的那份救回來了
            path.write_text("garbage", encoding="utf-8")
            with patch.object(config, "CONFIG_PATH", path):
                self.assertEqual(config.load()["engine"], config.DEFAULTS["engine"])


if __name__ == "__main__":
    unittest.main()
