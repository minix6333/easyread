"""選字翻譯的提示詞和模型選擇（quick.py）、Claude Code 沒登入的提示、重點頁、不自動翻譯的預設。"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import config, netcheck, quick, settings_api, tw
from easyread.store import Workspace, apply_ops, empty_reader, write_json_atomic


class QuickTranslateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))

    def paper(self, **meta):
        write_json_atomic(self.ws.paper_path, {"meta": meta, "blocks": []})

    def test_prompt_is_traditional_and_keeps_the_selected_text_as_is(self):
        self.paper(title_en="A Paper", target="zh-TW", kind="slides")
        text = "catastrophic forgetting 的问题"
        p = quick.prompt(self.ws, text)
        head, _, tail = p.partition("<<<\n")
        self.assertEqual(tail, text + "\n>>>")           # 選中的字原樣送，不被轉換
        self.assertEqual(tw.to_tw(head), head)           # 提示詞本身是繁體
        self.assertIn("繁體中文", head)
        self.assertIn("A Paper", head)
        self.assertIn("投影片", head)

    def test_other_targets_keep_the_upstream_wording(self):
        self.paper(title_en="A Paper", target="ja")
        self.assertIn("日语", quick.prompt(self.ws, "x"))

    def test_model_falls_back_from_request_to_setting_to_default(self):
        cfg = {"chat": {"models": [{"id": "a", "engine": "claude"}, {"id": "b", "engine": "claude"}], "default": "a"}, "quick": {"translate_model": "b"}}
        self.assertEqual(quick.model_id(cfg, "a"), "a")
        self.assertEqual(quick.model_id(cfg, None), "b")
        self.assertEqual(quick.model_id(cfg, "gone"), "b")
        cfg["quick"]["translate_model"] = "gone"
        self.assertIsNone(quick.model_id(cfg, None))     # 名單裡沒有了：用問 AI 的預設

    def test_empty_selection_is_rejected_before_any_model_call(self):
        self.paper(target="zh-TW")
        with self.assertRaises(ValueError):
            quick.handle(None, self.ws, {"mode": "translate", "text": "   "})
        with self.assertRaises(ValueError):
            quick.handle(None, self.ws, {"mode": "summarize", "text": "x"})


class SmallBehaviourTest(unittest.TestCase):
    def test_not_logged_in_gets_a_fix_it_hint_once(self):
        raw = "Claude Code 出錯：Not logged in · Please run /login"
        msg = netcheck.login_hint({"engine": "claude"}, raw)
        self.assertIn("/login", msg.split("\n", 1)[1])
        self.assertEqual(netcheck.login_hint({"engine": "claude"}, msg), msg)
        self.assertEqual(netcheck.login_hint({"engine": "openai"}, raw), raw)
        self.assertEqual(netcheck.login_hint({"engine": "claude"}, "timeout"), "timeout")

    def test_page_star_is_stored_with_the_page_note_and_can_be_cleared(self):
        r = empty_reader()
        apply_ops(r, [{"op": "page_note", "page": 3, "body": "重點", "star": True, "at": "2026-01-01T00:00:01"}])
        self.assertEqual(r["page_notes"]["3"], {"body": "重點", "at": "2026-01-01T00:00:01", "star": True})
        apply_ops(r, [{"op": "page_note", "page": 3, "body": "重點", "at": "2026-01-01T00:00:02"}])
        self.assertNotIn("star", r["page_notes"]["3"])
        apply_ops(r, [{"op": "page_note", "page": 3, "body": "舊的", "star": True, "at": "2026-01-01T00:00:00"}])  # 比較舊的不蓋掉新的
        self.assertEqual(r["page_notes"]["3"]["body"], "重點")

    def test_import_does_not_translate_unless_turned_on(self):
        self.assertIs(config.DEFAULTS["auto_translate"], False)
        self.assertEqual(config.DEFAULTS["quick"], {"translate_model": ""})

    def test_settings_keep_the_new_options_well_formed(self):
        saved = {}
        with mock.patch.object(config, "save", side_effect=lambda patch: saved.update(patch) or config.load()), \
                mock.patch.object(config, "public", side_effect=lambda c: c):
            settings_api.save_config({"auto_translate": "yes", "quick": {"translate_model": 5, "junk": 1}})
        self.assertIs(saved["auto_translate"], False)    # 只有真的 True 才算開
        self.assertEqual(saved["quick"], {"translate_model": "5"})


if __name__ == "__main__":
    unittest.main()
