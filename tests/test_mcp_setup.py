"""設定 →「外部 AI」（mcp_setup.py）：把 FOLI 加進 Codex、Claude、Cursor 的 MCP 設定、拿掉；只動 foli 那一項，
別的設定原樣留著；看不懂的設定檔不去改。全部在一個假的家目錄裡做。python -m unittest tests.test_mcp_setup"""
import json
import os
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from easyread import config  # noqa: F401 —— 先載 config
from easyread import mcp_setup

CODEX = '''model = "gpt-6.1-sol"   # 我的模型

[mcp_servers.node_repl]
command = "node"
args = ["repl.js"]

[mcp_servers.foli]
command = "/old/path/easyread-backend"
args = ["mcp"]

[mcp_servers.foli.env]
X = "1"

[profiles.fast]
model = "gpt-6.1-sol"
'''


class McpSetup(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_MCP_HOME"] = str(self.home)
        os.environ.pop("CODEX_HOME", None)
        self.addCleanup(os.environ.pop, "EASYREAD_MCP_HOME", None)
        patcher = mock.patch.object(mcp_setup, "_claude_cli", return_value=None)  # 不去碰電腦上真的 claude 指令
        patcher.start()
        self.addCleanup(patcher.stop)

    def target(self, tid):
        return next(t for t in mcp_setup.targets() if t["id"] == tid)

    def test_codex_toml_keeps_everything_else_and_replaces_an_old_entry(self):
        p = self.home / ".codex" / "config.toml"
        p.parent.mkdir()
        p.write_text(CODEX, encoding="utf-8")
        self.assertTrue(self.target("codex")["connected"])  # 舊的那一項（別的路徑）
        mcp_setup.handle({"do": "connect", "id": "codex"})
        text = p.read_text(encoding="utf-8")
        data = tomllib.loads(text)
        cmd, args = mcp_setup.command()
        self.assertEqual(data["mcp_servers"]["foli"], {"command": cmd, "args": args})  # 換成這一份的路徑，舊的 env 子表也拿掉
        self.assertEqual(data["mcp_servers"]["node_repl"], {"command": "node", "args": ["repl.js"]})
        self.assertEqual(data["profiles"]["fast"]["model"], "gpt-6.1-sol")
        self.assertIn('model = "gpt-6.1-sol"   # 我的模型', text)  # 註解、排版原樣
        self.assertEqual(text.count("[mcp_servers.foli]"), 1)
        self.assertEqual((p.parent / "config.toml.foli-backup").read_text(encoding="utf-8"), CODEX)
        mcp_setup.handle({"do": "disconnect", "id": "codex"})
        data = tomllib.loads(p.read_text(encoding="utf-8"))
        self.assertNotIn("foli", data["mcp_servers"])
        self.assertIn("node_repl", data["mcp_servers"])
        self.assertFalse(self.target("codex")["connected"])

    def test_a_missing_codex_config_is_created(self):
        mcp_setup.handle({"do": "connect", "id": "codex"})
        data = tomllib.loads((self.home / ".codex" / "config.toml").read_text(encoding="utf-8"))
        self.assertEqual(list(data["mcp_servers"]), ["foli"])

    def test_json_configs_for_claude_and_cursor(self):
        cur = self.home / ".cursor" / "mcp.json"
        cur.parent.mkdir()
        cur.write_text(json.dumps({"mcpServers": {"github": {"command": "gh-mcp"}}, "other": True}), encoding="utf-8")
        mcp_setup.handle({"do": "connect", "id": "cursor"})
        data = json.loads(cur.read_text(encoding="utf-8"))
        self.assertEqual(sorted(data["mcpServers"]), ["foli", "github"])
        self.assertTrue(data["other"])
        mcp_setup.handle({"do": "connect", "id": "claude"})
        claude = json.loads(mcp_setup._claude_config().read_text(encoding="utf-8"))
        self.assertEqual(claude["mcpServers"]["foli"]["args"], mcp_setup.command()[1])
        mcp_setup.handle({"do": "disconnect", "id": "cursor"})
        self.assertEqual(json.loads(cur.read_text(encoding="utf-8"))["mcpServers"], {"github": {"command": "gh-mcp"}})

    def test_a_config_it_cannot_read_is_left_alone(self):
        cur = self.home / ".cursor" / "mcp.json"
        cur.parent.mkdir()
        cur.write_text("{ broken json", encoding="utf-8")
        with self.assertRaises(ValueError):
            mcp_setup.handle({"do": "connect", "id": "cursor"})
        self.assertEqual(cur.read_text(encoding="utf-8"), "{ broken json")
        with self.assertRaises(ValueError):
            mcp_setup.handle({"do": "connect", "id": "nope"})

    def test_the_command_is_the_backend_itself_when_packaged(self):
        with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", "/Applications/FOLI.app/Contents/Resources/backend/easyread-backend/easyread-backend"):
            self.assertEqual(mcp_setup.command(), ("/Applications/FOLI.app/Contents/Resources/backend/easyread-backend/easyread-backend", ["mcp"]))
        self.assertEqual(mcp_setup.command()[1], ["-m", "easyread", "mcp"])


if __name__ == "__main__":
    unittest.main()
