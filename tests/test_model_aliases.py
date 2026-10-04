"""Claude Code 的模型別名：Fable 列在名單裡、顯示實際版本；別名對應每隔一陣子重查（登入、換訂閱後會變）。"""
import json
import time
import unittest
from pathlib import Path
from unittest import mock

from easyread import config  # noqa: F401  先載 config，避開循環引用
from easyread import chat_models, cli_models


class AliasTest(unittest.TestCase):
    def setUp(self):
        self.seen = {}
        mock.patch.object(chat_models, "actual_of", side_effect=lambda a: self.seen.get(a, "")).start()
        mock.patch.object(chat_models, "remember", side_effect=lambda a, v: self.seen.__setitem__(a, v) if v else None).start()
        self.addCleanup(mock.patch.stopall)

    def test_fable_is_an_alias_and_shows_its_real_version(self):
        self.seen.update(fable="claude-fable-5-1", opus="claude-opus-5-5")
        ids = [m["id"] for m in cli_models.claude()["models"]]
        self.assertEqual(ids[0], "fable")
        self.assertEqual(chat_models.label({"engine": "claude", "model": "fable"}), "Claude Fable 5.1")
        self.assertEqual(chat_models.label({"engine": "claude", "model": "opus"}), "Claude Opus 5.5")
        self.assertIn("fable", [m["id"] for m in chat_models.DEFAULT_MODELS])

    def test_probe_runs_again_when_the_record_is_old(self):
        calls = []
        with mock.patch.object(cli_models.engines, "claude_path", return_value="/bin/claude"), mock.patch.object(cli_models, "_probe", side_effect=lambda exe, v: calls.append(v)):
            self.seen.update(fable="f", opus="o", sonnet="s", haiku="h", _default="d", _claude_version="2.1", _probed_at=str(int(time.time())))
            cli_models.probe_claude({}, "2.1")
            self.assertEqual(calls, [])                      # 剛查過、版本沒變：不查
            self.seen["_probed_at"] = str(int(time.time()) - cli_models.PROBE_TTL - 1)
            cli_models.probe_claude({}, "2.1")
            self.assertEqual(calls, ["2.1"])                 # 記錄太舊：重查
            del self.seen["fable"]
            self.seen["_probed_at"] = str(int(time.time()))
            cli_models.probe_claude({}, "2.1")
            self.assertEqual(calls, ["2.1", "2.1"])          # 少了一個別名：重查


if __name__ == "__main__":
    unittest.main()
