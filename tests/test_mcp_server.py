"""電腦上的 AI App 用的 MCP 伺服器（mcp_server.py）：照 MCP 的 stdio 協定一行一則對它講，看它回什麼；
工具讀、寫的是一個暫時的文獻庫。python -m unittest tests.test_mcp_server"""
import io
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from easyread import config  # noqa: F401 —— 先載 config（模組之間有循環 import）
from easyread import mcp_server


def _paper(root: Path, pid: str, title: str, pages: list[str]):
    d = root / pid
    (d / "extract").mkdir(parents=True)
    meta = {"title_en": title, "authors": "Aayush Karan", "year": "2026", "page_count": len(pages), "pages": [{"w": 600, "h": 800} for _ in pages]}
    (d / "paper.json").write_text(json.dumps({"meta": meta, "blocks": []}), encoding="utf-8")
    (d / "item.json").write_text(json.dumps({"tags": ["Paper"], "last_opened": "2026-10-18T10:00:00"}), encoding="utf-8")
    for i, t in enumerate(pages, 1):
        (d / "extract" / f"page-{i:03d}.txt").write_text(t, encoding="utf-8")


class Talk:
    """對伺服器講一串 JSON-RPC，收回它的回應（照 id 對）。"""
    def __init__(self):
        self.out = io.StringIO()
        self.srv = mcp_server.Server(self.out)

    def __call__(self, *msgs):
        self.out.seek(0)
        self.out.truncate()
        self.srv.run(io.StringIO("\n".join(json.dumps(m) for m in msgs) + "\n"))
        return [json.loads(line) for line in self.out.getvalue().splitlines() if line.strip()]

    def tool(self, name, **args):
        r = self({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": name, "arguments": args}})[0]["result"]
        return r["content"][0]["text"], r["isError"]


class McpServer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ["EASYREAD_LIBRARY"] = str(self.tmp)
        self._cache, self._info = config.CACHE_DIR, config.SERVER_INFO
        config.CACHE_DIR = self.tmp / ".cache"
        config.SERVER_INFO = self.tmp / ".server.json"  # 沒有開著的 FOLI
        _paper(self.tmp, "aaaa1111", "Finetuning with Sampling", ["Introduction. Supervised finetuning suffers from catastrophic forgetting.",
                                                                  "Projection sampling keeps the base distribution.", "Results on MMLU."])
        _paper(self.tmp, "bbbb2222", "Data Agent", ["We study data selection with reinforcement learning agents."])
        self.talk = Talk()

    def tearDown(self):
        os.environ.pop("EASYREAD_LIBRARY", None)
        config.CACHE_DIR, config.SERVER_INFO = self._cache, self._info

    def test_handshake_and_tool_list(self):
        init, = self.talk({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-ai", "version": "1"}, "capabilities": {}}},
                          {"jsonrpc": "2.0", "method": "notifications/initialized"})  # 通知不回
        self.assertEqual(init["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(init["result"]["serverInfo"]["name"], "foli")
        self.assertIn("tools", init["result"]["capabilities"])
        self.assertEqual(self.talk.srv.client, "Claude")
        tools, = self.talk({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [t["name"] for t in tools["result"]["tools"]]
        self.assertEqual(names, ["current", "list_documents", "read_pages", "search", "get_notes", "add_note", "save_answer", "go_to_page"])
        for t in tools["result"]["tools"]:
            self.assertEqual(t["inputSchema"]["type"], "object")
        odd, = self.talk({"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
        self.assertEqual(odd["result"]["protocolVersion"], mcp_server.PROTOCOLS[0])  # 不認得的版本：給自己最新的
        bad, = self.talk({"jsonrpc": "2.0", "id": 4, "method": "resources/list"})
        self.assertEqual(bad["error"]["code"], -32601)
        broken = self.talk.srv  # 壞掉的一行不會讓伺服器停下來
        out = io.StringIO()
        broken.out = out
        broken.run(io.StringIO("{not json\n" + json.dumps({"jsonrpc": "2.0", "id": 5, "method": "ping"}) + "\n"))
        lines = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual((lines[0]["error"]["code"], lines[1]["id"], lines[1]["result"]), (-32700, 5, {}))

    def test_reading_the_library(self):
        text, err = self.talk.tool("list_documents", query="sampling")
        self.assertFalse(err)
        docs = json.loads(text)
        self.assertEqual([d["id"] for d in docs], ["aaaa1111"])
        self.assertEqual(docs[0]["pages"], 3)
        text, err = self.talk.tool("read_pages", doc_id="aaaa1111", start=2, end=9)
        self.assertFalse(err)
        self.assertIn("=== page 2 ===\nProjection sampling", text)
        self.assertIn("=== page 3 ===\nResults on MMLU.", text)
        self.assertNotIn("page 1 ===", text)
        text, err = self.talk.tool("read_pages", doc_id="aaaa", start=1)  # id 的開頭也認得
        self.assertIn("catastrophic forgetting", text)
        text, err = self.talk.tool("search", query="catastrophic forgetting")
        hits = json.loads(text)
        self.assertEqual((hits[0]["doc_id"], hits[0]["hits"][0]["page"]), ("aaaa1111", 1))
        text, err = self.talk.tool("read_pages", start=1)  # 沒給 doc_id、FOLI 也沒開
        self.assertTrue(err)
        self.assertIn("list_documents", text)
        text, err = self.talk.tool("current")
        self.assertIn("FOLI is not open", text)

    def test_writing_back_a_note_and_an_answer(self):
        self.talk({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "codex-mcp-client"}}})
        text, err = self.talk.tool("save_answer", doc_id="aaaa1111", page=2, question="投影取樣在做什麼？", answer="讓資料留在模型原本的分布附近（第 2 頁）。")
        self.assertFalse(err)
        self.assertIn("signed Codex", text)
        text, err = self.talk.tool("add_note", doc_id="aaaa1111", page=1, text="記得對照第 3 頁的結果", quote="catastrophic forgetting")
        self.assertFalse(err)
        notes, err = self.talk.tool("get_notes", doc_id="aaaa1111")
        self.assertIn("page 2 · question", notes)
        self.assertIn("answer (Codex): 讓資料留在模型原本的分布附近", notes)
        self.assertIn("page 1 · note · quote: “catastrophic forgetting”", notes)
        text, err = self.talk.tool("add_note", doc_id="aaaa1111", page=1, text="  ")
        self.assertTrue(err)
        text, err = self.talk.tool("go_to_page", doc_id="aaaa1111", page=99)
        self.assertTrue(err)
        with mock.patch.object(mcp_server, "_open_link", return_value=True) as opened:
            text, err = self.talk.tool("go_to_page", doc_id="aaaa1111", page=2, find="projection sampling\n")
        self.assertFalse(err)
        self.assertEqual(opened.call_args[0][0], "easyread://open?id=aaaa1111&page=2&find=projection%20sampling")

    def test_current_asks_the_running_app(self):
        class Fake(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"id": "bbbb2222", "title": "Data Agent", "page": 1, "pages": 1, "sel": "reinforcement learning agents", "age": 3}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        config.SERVER_INFO.write_text(json.dumps({"url": f"http://127.0.0.1:{httpd.server_address[1]}"}), encoding="utf-8")
        text, err = self.talk.tool("current")
        now = json.loads(text)
        self.assertEqual((now["id"], now["page"], now["selected_text"]), ("bbbb2222", 1, "reinforcement learning agents"))
        text, err = self.talk.tool("read_pages", start=1)  # 沒給 doc_id：用 FOLI 正在看的那一份
        self.assertIn("reinforcement learning agents", text)


if __name__ == "__main__":
    unittest.main()
