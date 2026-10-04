"""界面语言：系统语言判断、tr 填占位符、页面注入词典，以及所有界面文字都有英文。  python -m unittest tests.test_i18n"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from easyread import i18n

ROOT = Path(__file__).resolve().parents[1]


class I18nTest(unittest.TestCase):
    def setUp(self):
        i18n.system_lang.cache_clear()

    def tearDown(self):
        i18n.system_lang.cache_clear()

    def test_system_lang_from_electron(self):
        # 中文系統不分簡繁一律繁體；簡體只在設定裡手動選
        for tag, want in (("zh-CN", "zh-TW"), ("zh-TW", "zh-TW"), ("zh-Hant-HK", "zh-TW"), ("en-US", "en"), ("de", "en"), ("ja", "en")):
            i18n.system_lang.cache_clear()
            with mock.patch.dict(os.environ, {"EASYREAD_SYSTEM_LANG": tag}):
                self.assertEqual(i18n.system_lang(), want, tag)

    def test_system_lang_from_env(self):
        env = {k: v for k, v in os.environ.items() if k not in ("EASYREAD_SYSTEM_LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE")}
        env["LANG"] = "de_DE.UTF-8"
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(i18n.system_lang(), "en")

    def test_choice_overrides_system(self):
        with mock.patch.object(i18n, "system_lang", lambda: "zh"), mock.patch.object(i18n, "choice", lambda: "en"):
            self.assertEqual(i18n.lang(), "en")
        with mock.patch.object(i18n, "system_lang", lambda: "en"), mock.patch.object(i18n, "choice", lambda: "auto"):
            self.assertEqual(i18n.lang(), "en")

    def test_tr(self):
        fake = {"已导入 {n} 篇": "Imported {n} papers"}
        with mock.patch.object(i18n, "en_dict", lambda: fake):
            with mock.patch.object(i18n, "lang", lambda: "en"):
                self.assertEqual(i18n.tr("已导入 {n} 篇", n=3), "Imported 3 papers")
                self.assertEqual(i18n.tr("词典里没有"), "词典里没有")
            with mock.patch.object(i18n, "lang", lambda: "zh"):
                self.assertEqual(i18n.tr("已导入 {n} 篇", n=3), "已导入 3 篇")
        with mock.patch.object(i18n, "tw_dict", lambda: {"已导入 {n} 篇": "已匯入 {n} 篇"}), mock.patch.object(i18n, "lang", lambda: "zh-TW"):
            self.assertEqual(i18n.tr("已导入 {n} 篇", n=3), "已匯入 3 篇")
            self.assertEqual(i18n.tr("詞典裡沒有的繁體字串"), "詞典裡沒有的繁體字串")  # 本分支新加的字串直接寫繁體

    def test_inject(self):
        page = '<html lang="zh-CN">\n<head><title>EasyRead</title></head>'
        self.assertNotIn("pr-i18n", i18n.inject(page, "zh"))
        with mock.patch.object(i18n, "en_dict", lambda: {"设置": "Settings</script>"}):
            out = i18n.inject(page, "en")
        self.assertIn('<html lang="en"', out)
        self.assertIn('id="pr-i18n"', out)
        self.assertNotIn("Settings</script>", out)  # 词典里的 < 要转义，不能提前结束 script
        with mock.patch.object(i18n, "tw_dict", lambda: {"设置": "設定"}):
            out = i18n.inject(page, "zh-TW")
        self.assertIn('<html lang="zh-TW"', out)
        self.assertIn('"设置": "設定"', out)

    def test_every_ui_string_has_english(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "i18n_check.py")], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout[-3000:])

    def test_every_ui_string_has_traditional_chinese(self):
        """zh-TW.json 由 scripts/i18n_tw.py 從 en.json 的鍵產生；上游加了字串要重跑。"""
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "i18n_tw.py"), "--check"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, "zh-TW.json 缺了這些鍵（跑 python scripts/i18n_tw.py）：\n" + result.stdout[-2000:])
        tw = json.loads((ROOT / "easyread" / "web" / "i18n" / "zh-TW.json").read_text(encoding="utf-8"))
        simplified = [v for v in tw.values() if any(c in v for c in "设导译论术页数据软网络")]
        self.assertEqual(simplified, [], simplified[:10])


if __name__ == "__main__":
    unittest.main()
