"""Antigravity CLI（agy）引擎：print 模式的 JSON 怎麼解、用量怎麼算、提示詞怎麼叫它看圖。"""
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from easyread import config  # noqa: F401
from easyread import chat_models, engines, usage


def fake_agy(folder: Path, payload: dict, extra: str = "") -> Path:
    exe = folder / "agy"
    exe.write_text("#!/bin/sh\n" + extra + "printf '%s\\n' " + json.dumps(json.dumps(payload)) + "\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


class AgyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_response_and_usage_are_read_from_the_json(self):
        exe = fake_agy(self.root, {"status": "OK", "response": "你好", "usage": {"input_tokens": 100, "output_tokens": 20, "thinking_tokens": 5, "cache_read_tokens": 300}})
        meter = usage.Meter("agy")
        self.assertEqual(engines.run_agy({"command": str(exe), "model": "gemini-3.8-flash-low"}, "hi", self.root, meter=meter), "你好")
        self.assertEqual(meter.snapshot()["input"], 400)
        self.assertEqual(meter.snapshot()["cached"], 300)
        self.assertEqual(meter.snapshot()["output"], 25)

    def test_arguments_put_the_cli_in_read_only_print_mode_inside_a_sandbox(self):
        (self.root / "extract").mkdir()
        (self.root / "extract" / "page-001.jpg").write_bytes(b"jpg")
        (self.root / "paper.json").write_text("{}")
        exe = fake_agy(self.root, {"status": "OK", "response": "ok"}, extra='printf \'%s\\n\' "$@" > "' + str(self.root / "args.txt") + '"\npwd > "' + str(self.root / "cwd.txt") + '"\nls -R > "' + str(self.root / "ls.txt") + '"\n')
        engines.run_agy({"command": str(exe), "model": "gemini-3.1-pro-low", "extra_args": ["--project", "p"]}, "先看 extract/page-001.jpg 再翻译", self.root)
        args = (self.root / "args.txt").read_text().splitlines()
        self.assertEqual(args[:2], ["--print", "先看 extract/page-001.jpg 再翻译"])
        for flag in ("--output-format", "json", "--mode", "plan", "--dangerously-skip-permissions", "--print-timeout", "--model", "gemini-3.1-pro-low", "--project", "p"):
            self.assertIn(flag, args)
        self.assertNotEqual(Path((self.root / "cwd.txt").read_text().strip()).resolve(), self.root.resolve())  # 不在文件目錄裡跑
        listing = (self.root / "ls.txt").read_text()
        self.assertIn("page-001.jpg", listing)   # 只帶提示詞提到的圖
        self.assertNotIn("paper.json", listing)

    def test_errors_without_a_response_raise_and_partial_ones_pass_through(self):
        exe = fake_agy(self.root, {"status": "ERROR", "response": "", "error": "quota exceeded"})
        with self.assertRaises(engines.EngineError) as cm:
            engines.run_agy({"command": str(exe)}, "hi", self.root)
        self.assertIn("quota exceeded", str(cm.exception))
        exe = fake_agy(self.root, {"status": "ERROR", "response": "完整的回答", "error": "connection reset after stream"})
        self.assertEqual(engines.run_agy({"command": str(exe)}, "hi", self.root), "完整的回答")
        exe = fake_agy(self.root, {"status": "SUCCESS", "response": "正常"})  # 實際回的是 SUCCESS，不是 OK
        with self.assertNoLogs(level="WARNING"):
            self.assertEqual(engines.run_agy({"command": str(exe)}, "hi", self.root), "正常")
        with self.assertRaises(engines.EngineError):
            engines.run_agy({"command": str(self.root / "missing")}, "hi", self.root)

    def test_engine_wiring(self):
        cfg = config.load()
        cfg["chat"] = {"models": [{"id": "g", "name": "Gemini", "engine": "agy", "model": "gemini-3.8-flash-medium"}], "default": "g"}
        ecfg, m = chat_models.engine_cfg(cfg, "g")
        self.assertEqual((ecfg["engine"], ecfg["agy"]["model"]), ("agy", "gemini-3.8-flash-medium"))
        self.assertEqual(engines.image_mode({"engine": "agy"}), "agy")
        self.assertEqual(chat_models.sanitize([{"id": "g", "engine": "agy", "model": "x"}])[0]["engine"], "agy")
        cfg["engine"], cfg["agy"]["model"] = "agy", "gemini-3.8-flash-medium"
        self.assertEqual(chat_models.translation_id(cfg), "g")

    def test_prompt_tells_it_to_read_the_page_images(self):
        from easyread import prompts
        from easyread.store import Workspace, write_json_atomic
        ws = Workspace(self.root)
        write_json_atomic(ws.paper_path, {"meta": {"target": "zh", "kind": "paper"}, "blocks": []})
        (self.root / "extract").mkdir()
        (self.root / "extract" / "page-001.txt").write_text("hello")
        p = prompts.translate(ws, [1], "agy", "")
        self.assertIn("extract/page-001.jpg", p)
        self.assertNotIn("Read 工具", p)


if __name__ == "__main__":
    unittest.main()
