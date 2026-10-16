"""問 AI 上網查資料（2.1.0-tw.12）：哪些模型能上網、三種引擎回報的動作和來源、Codex 每個對話的設定（外掛不載入、沒有 shell）、
Claude Code 的 Read 只准讀文件的資料夾、提示詞、/chat 把狀態和來源送給頁面並存在回答上。不連網、不叫真的模型。
python -m unittest tests.test_web_search"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import patch

from easyread import chat, chat_store, claude_live, codex_lean, codex_live, engines, paths, webtools
from tests.test_answer_styles import AnswerStyleTest
from tests.test_live import LIVE_ON, FakeAppServer
from tests.test_translate import make_ws


class WebtoolsTest(unittest.TestCase):
    def test_which_models_can_go_online(self):
        self.assertTrue(webtools.supported({"engine": "codex", "codex": {}}))
        self.assertTrue(webtools.supported({"engine": "claude", "claude": {}}))
        self.assertTrue(webtools.supported({"engine": "openai", "openai": {"api": "responses", "base_url": "https://api.openai.com/v1"}}))
        self.assertFalse(webtools.supported({"engine": "openai", "openai": {"api": "chat", "base_url": "https://api.openai.com/v1"}}))
        self.assertFalse(webtools.supported({"engine": "openai", "openai": {"api": "responses", "base_url": "https://api.deepseek.com"}}))
        self.assertFalse(webtools.supported({"engine": "openai", "openai": {"api": "responses", "base_url": "https://api.openai.com.evil.example/v1"}}))

    def test_only_cited_and_opened_pages_are_listed(self):
        s = webtools.Sources()
        self.assertTrue(s.add("https://www.python.org/downloads/", "", "", "result"))
        self.assertFalse(s.add("https://www.python.org/downloads#x", "Downloads", "", "result"))  # 同一頁：不重複，但補上標題
        self.assertTrue(s.add("https://peps.python.org/pep-0745/", "PEP 745", "", "result"))
        self.assertTrue(s.add("https://copycat.example/pep745", "轉貼", "", "result"))   # 搜尋時看到、沒用上
        self.assertTrue(s.add("https://arxiv.org/abs/2510.14901", "", "", "open"))      # 真的打開讀過
        self.assertTrue(s.add("https://peps.python.org/pep-0745", "", "", "open"))       # 候選變成打開過：算新的
        for bad in ("javascript:alert(1)", "ftp://x/y", "", None, "https://exa mple.com/a", "https://x.com/" + "a" * 3000):
            self.assertFalse(s.add(bad, "x"), bad)
        text = "3.14 在 2025 年發佈（[下載頁](https://www.python.org/downloads/)），時程見 https://peps.python.org/pep-0745/ 。"
        got = s.final(text)
        self.assertEqual([x["url"] for x in got], ["https://www.python.org/downloads/", "https://peps.python.org/pep-0745/", "https://arxiv.org/abs/2510.14901"])
        self.assertEqual(got[0]["title"], "Downloads")   # 搜尋結果裡的標題
        self.assertEqual(got[2]["domain"], "arxiv.org")
        self.assertNotIn("copycat.example", json.dumps(got))
        self.assertEqual(webtools.Sources().final("看 [這裡](https://a.org/x)"), [{"url": "https://a.org/x", "title": "這裡", "domain": "a.org"}])  # 沒記過的連結：用連結的字當標題
        many = webtools.Sources()
        self.assertEqual(len(many.final(" ".join(f"https://example.com/{i}" for i in range(30)))), webtools.MAX_SOURCES)

    def test_codex_web_search_items(self):
        st, found = webtools.codex_item({"type": "webSearch", "query": "q", "action": {"type": "search", "query": "Python 3.14 release"},
                                         "results": [{"type": "text_result", "domain": "python.org", "title": "Python 3.14.0", "url": "https://python.org/downloads/release/python-3140"}]})
        self.assertEqual(st, {"kind": "search", "query": "Python 3.14 release"})
        self.assertEqual(found[0]["url"], "https://python.org/downloads/release/python-3140")
        st, _ = webtools.codex_item({"type": "webSearch", "action": {"type": "openPage", "url": "https://news.ycombinator.com/"}})
        self.assertEqual(st, {"kind": "open", "url": "https://news.ycombinator.com/", "domain": "news.ycombinator.com"})
        st, _ = webtools.codex_item({"type": "webSearch", "action": {"type": "findInPage", "url": "https://a.org/x", "pattern": "release"}})
        self.assertEqual((st["kind"], st["pattern"]), ("find", "release"))
        self.assertEqual(webtools.codex_item({"type": "reasoning"}), (None, []))

    def test_claude_tool_use_and_results(self):
        self.assertEqual(webtools.claude_tool_use({"type": "tool_use", "name": "WebSearch", "input": {"query": "PEP 745"}}), {"kind": "search", "query": "PEP 745"})
        self.assertEqual(webtools.claude_tool_use({"type": "tool_use", "name": "WebFetch", "input": {"url": "https://www.python.org/x"}})["domain"], "python.org")
        self.assertIsNone(webtools.claude_tool_use({"type": "tool_use", "name": "Read", "input": {"file_path": "/etc/passwd"}}))
        res = {"query": "q", "results": [{"tool_use_id": "s", "content": [{"title": "PEP 745", "url": "https://peps.python.org/pep-0745/"}]}, "summary text"]}
        self.assertEqual([x["url"] for x in webtools.claude_result(res)], ["https://peps.python.org/pep-0745/"])
        self.assertEqual(webtools.claude_result({"url": "https://news.ycombinator.com/", "code": 200, "result": "…"})[0]["url"], "https://news.ycombinator.com/")
        self.assertEqual(webtools.claude_result({"url": "https://gone.example/", "code": 404}), [])
        self.assertEqual(webtools.claude_result("plain text"), [])

    def test_openai_responses_events(self):
        st, found = webtools.openai_event({"type": "response.output_item.done", "item": {"type": "web_search_call", "action": {"type": "search", "query": "q1", "sources": [{"url": "https://a.org/1"}]}}})
        self.assertEqual((st, found[0]["url"]), ({"kind": "search", "query": "q1"}, "https://a.org/1"))
        _, cites = webtools.openai_event({"type": "response.output_item.done", "item": {"type": "message", "content": [{"type": "output_text", "annotations": [{"type": "url_citation", "url": "https://b.org", "title": "B"}]}]}})
        self.assertEqual(cites, [{"url": "https://b.org", "title": "B", "domain": "", "kind": "cite"}])

    def test_a_trailing_sources_list_is_dropped_but_inline_links_stay(self):
        body = "3.14 在 2025 年發佈（[PEP 745](https://peps.python.org/pep-0745/)）。"
        self.assertEqual(webtools.strip_source_list(body + "\n\nSources:\n- [PEP 745](https://peps.python.org/pep-0745/)\n- [rc3](https://www.python.org/x)\n"), body)
        self.assertEqual(webtools.strip_source_list("答案。\n\n**來源：**\n1. https://a.org/x\n2. [B](https://b.org)"), "答案。")
        self.assertEqual(webtools.strip_source_list("清單：\n- 第一點\n- 第二點"), "清單：\n- 第一點\n- 第二點")  # 不是連結的清單不動

    def test_leftover_citation_markers_are_removed(self):
        text = "版本是 3.14" + chr(0xE200) + "cite" + chr(0xE202) + "turn0search0" + chr(0xE201) + "。另見【3†source】和 [2†x]。"
        self.assertEqual(webtools.clean(text), "版本是 3.14。另見和 。")
        self.assertEqual(webtools.clean("沒有記號 [見](https://a.org)"), "沒有記號 [見](https://a.org)")


class CodexThreadTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.cfg = self.dir / "config.toml"
        self.cfg.write_text('model = "gpt-6.1-sol"\nnotify = ["x"]\n[plugins."gmail@openai-curated"]\nenabled = true\n'
                            '[plugins."unified-computer-use@openai-bundled"]\nenabled = true\n[mcp_servers.node_repl]\ncommand = "x"\n', encoding="utf-8")

    def test_every_conversation_switches_off_plugins_and_commands(self):
        self.assertEqual(codex_lean.plugin_ids(self.cfg), ["gmail@openai-curated", "unified-computer-use@openai-bundled"])
        for web in (False, True):
            conf = codex_lean.thread_config(web, self.cfg)
            f = conf["features"]
            self.assertFalse(f["shell_tool"] or f["unified_exec"] or f["view_image"] or f["computer_use"] or f["apps"] or f["plugins"])
            self.assertEqual(f["code_mode_host"], web)  # 上網要它（Codex 0.160 起工具都經過它）
            self.assertEqual(conf["web_search"], "live" if web else "disabled")
            self.assertEqual(conf["plugins"], {"gmail@openai-curated": {"enabled": False}, "unified-computer-use@openai-bundled": {"enabled": False}})
            self.assertEqual(conf["mcp_servers"], {"node_repl": {"enabled": False}})
        self.assertIn("features.code_mode_host=false", codex_lean.args(self.cfg))      # 翻譯（codex exec）照舊整個關掉
        self.assertNotIn("features.code_mode_host=false", codex_lean.args(self.cfg, tools=True))  # app-server 留著，由每個對話決定
        self.assertEqual(codex_lean.plugin_ids(self.dir / "missing.toml"), [])

    def test_web_conversation_reports_searches_and_sources(self):
        srv = FakeAppServer()
        base = srv.reply

        def reply(ev):
            if ev.get("method") != "turn/start":
                return base(ev)
            tid = ev["params"]["threadId"]
            ws = {"type": "webSearch", "id": "w1", "query": "", "action": None, "results": None}
            done = {**ws, "query": "Python 3.14", "action": {"type": "search", "query": "Python 3.14"},
                    "results": [{"type": "text_result", "domain": "python.org", "title": "Python 3.14.0", "url": "https://python.org/downloads/release/python-3140"}]}
            return [{"id": ev["id"], "result": {}}, {"method": "turn/started", "params": {"threadId": tid, "turn": {"id": "turn1"}}},
                    {"method": "item/started", "params": {"threadId": tid, "item": ws}},
                    {"method": "item/completed", "params": {"threadId": tid, "item": done}},
                    {"method": "item/agentMessage/delta", "params": {"threadId": tid, "delta": "2025 年 10 月 7 日"}},
                    {"method": "turn/completed", "params": {"threadId": tid, "turn": {"status": "completed"}}}]
        srv.reply = reply
        statuses, sources = [], []
        cwd = Path(tempfile.gettempdir()) / "paper-web"
        self.addCleanup(setattr, codex_live, "_client", None)
        with mock.patch.dict("os.environ", LIVE_ON), mock.patch.object(engines, "codex_path", lambda c: "codex"), mock.patch.object(engines, "_popen", lambda a, cwd: srv), \
                mock.patch.object(codex_live.codex_lean, "config_path", lambda: self.cfg), mock.patch.object(codex_live, "_disabled", False):
            codex_live._threads.clear()
            codex_live._client = None
            out = list(codex_live.stream({"model": "gpt-6.1-sol"}, "問題", cwd, threading.Event(), None, None, "t1", 0, None, None,
                                         statuses.append, True, lambda *a: sources.append(a)))
            self.assertEqual(out, ["2025 年 10 月 7 日"])
            self.assertEqual(codex_live.bound_turns("paper-web", "t1", "gpt-6.1-sol", cwd, True), 1)
            self.assertIsNone(codex_live.bound_turns("paper-web", "t1", "gpt-6.1-sol", cwd, False))  # 關掉上網：不能接著用這個對話
        start = next(x["params"] for x in srv.sent if x.get("method") == "thread/start")
        turn = next(x["params"] for x in srv.sent if x.get("method") == "turn/start")
        self.assertEqual(start["config"]["web_search"], "live")
        self.assertFalse(start["config"]["features"]["shell_tool"])
        self.assertEqual(turn["disabledPluginIds"], ["gmail@openai-curated", "unified-computer-use@openai-bundled"])
        self.assertEqual([s["kind"] for s in statuses], ["search", "search"])
        self.assertEqual(statuses[-1]["query"], "Python 3.14")
        self.assertEqual(sources, [("https://python.org/downloads/release/python-3140", "Python 3.14.0", "python.org", "result")])
        codex_live._client = None


class CommentaryTest(unittest.TestCase):
    def test_progress_remark_becomes_status_not_answer(self):
        srv = FakeAppServer()
        base = srv.reply

        def reply(ev):
            if ev.get("method") != "turn/start":
                return base(ev)
            tid = ev["params"]["threadId"]
            c = {"type": "agentMessage", "id": "c1", "text": "", "phase": "commentary"}
            f = {"type": "agentMessage", "id": "f1", "text": "", "phase": "final_answer"}
            return [{"id": ev["id"], "result": {}}, {"method": "turn/started", "params": {"threadId": tid, "turn": {"id": "turn1"}}},
                    {"method": "item/started", "params": {"threadId": tid, "item": c}},
                    {"method": "item/agentMessage/delta", "params": {"threadId": tid, "itemId": "c1", "delta": "我會去查官方發佈資訊。"}},
                    {"method": "item/completed", "params": {"threadId": tid, "item": {**c, "text": "我會去查官方發佈資訊。"}}},
                    {"method": "item/started", "params": {"threadId": tid, "item": f}},
                    {"method": "item/agentMessage/delta", "params": {"threadId": tid, "itemId": "f1", "delta": "2025 年 10 月 7 日。"}},
                    {"method": "turn/completed", "params": {"threadId": tid, "turn": {"status": "completed"}}}]
        srv.reply = reply
        statuses = []
        self.addCleanup(setattr, codex_live, "_client", None)
        with mock.patch.dict("os.environ", LIVE_ON), mock.patch.object(engines, "codex_path", lambda c: "codex"), mock.patch.object(engines, "_popen", lambda a, cwd: srv), \
                mock.patch.object(codex_live.codex_lean, "config_path", lambda: Path(tempfile.gettempdir()) / "none" / "config.toml"), mock.patch.object(codex_live, "_disabled", False):
            codex_live._client = None
            codex_live._threads.clear()
            out = list(codex_live.stream({"model": "m"}, "q", Path(tempfile.gettempdir()) / "p-c", threading.Event(), None, None, None, None, None, None, statuses.append, True))
        self.assertEqual("".join(out), "2025 年 10 月 7 日。")
        self.assertIn({"kind": "note", "text": "我會去查官方發佈資訊。"}, statuses)


class ClaudeRulesTest(unittest.TestCase):
    def test_read_is_limited_to_the_document_folders(self):
        d = Path(tempfile.mkdtemp()) / "有 空白 的資料夾"
        d.mkdir()
        rules = claude_live.allow_rules("Read,WebSearch,WebFetch", [str(d)])
        self.assertEqual(rules, ["Read(/" + str(d.resolve()) + "/**)", "WebSearch", "WebFetch"])
        self.assertTrue(rules[0].startswith("Read(//"))  # 兩個斜線＝檔案系統的絕對路徑
        self.assertEqual(claude_live.allow_rules("Read", None), ["Read"])  # 沒給資料夾（翻譯）：照舊
        self.assertEqual(claude_live.allow_rules("", ["/x"]), [])

    def test_chat_reads_the_document_and_its_extracted_text(self):
        ws = make_ws(1)
        self.addCleanup(__import__("shutil").rmtree, ws.root, True)
        dirs = chat.read_dirs(ws.root)
        self.assertEqual(dirs[0], str(ws.root))
        self.assertIn(str(paths.derived(ws.root, "extract")), dirs)

    def test_events_become_status_and_sources(self):
        st, src = [], []
        claude_live.web_events({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}, {"type": "tool_use", "name": "WebSearch", "input": {"query": "q"}}]}}, st.append, None)
        claude_live.web_events({"type": "user", "tool_use_result": {"results": [{"content": [{"title": "T", "url": "https://t.org/"}]}]}}, None, lambda *a: src.append(a))
        claude_live.web_events({"type": "user", "tool_use_result": None}, st.append, lambda *a: src.append(a))
        self.assertEqual((st, src), ([{"kind": "search", "query": "q"}], [("https://t.org/", "T", "", "result")]))


class PromptTest(unittest.TestCase):
    def test_web_section_only_when_on_and_codex_no_longer_told_to_read_files(self):
        ws = make_ws(1)
        self.addCleanup(__import__("shutil").rmtree, ws.root, True)
        msgs = [{"role": "user", "content": "這個方法現在有新版本嗎"}]
        on = chat.prompt(ws, msgs, None, "", "codex", web=True)
        off = chat.prompt(ws, msgs, None, "", "codex")
        web = ("上網搜尋", "上网搜寻", "上网搜索")  # 照回答的語言轉過（這份測試論文沒設譯文語言）
        self.assertTrue(any(w in on for w in web))
        self.assertFalse(any(w in off for w in web))
        self.assertNotIn(str(paths.derived(ws.root, "extract")), off)  # Codex 在對話裡沒有讀檔的工具
        self.assertIn(str(paths.derived(ws.root, "extract")), chat.prompt(ws, msgs, None, "", "claude"))


class EndpointTest(unittest.TestCase):
    setUp = AnswerStyleTest.setUp            # 同一份小論文、同一個測試用伺服器（只借用這幾個，不把那邊的測試再跑一次）
    start_server = AnswerStyleTest.start_server
    post = AnswerStyleTest.post

    def test_status_and_sources_reach_the_page_and_are_kept_with_the_answer(self):
        self.start_server()
        engine = {"engine": "codex", "codex": {"model": "gpt-6.1-sol"}}
        model = {"id": "m", "name": "GPT", "engine": "codex", "model": "gpt-6.1-sol"}
        seen = {}

        def fake(*a, **k):
            seen["web"], seen["prompt"] = k.get("web"), a[1]
            if k.get("web"):
                k["on_status"]({"kind": "search", "query": "Python 3.14"})
                k["on_source"]("https://python.org/downloads/release/python-3140", "Python 3.14.0", "python.org", "result")
                k["on_source"]("https://copycat.example/x", "轉貼", "", "result")                  # 沒用上：不列
                k["on_source"]("https://peps.python.org/pep-0745/", "PEP 745", "", "open")        # 打開讀過：馬上送、也列
                yield "3.14 是 2025 年發佈的（[官方](https://python.org/downloads/release/python-3140)）" + chr(0xE200) + "cite" + chr(0xE202) + "turn0search0" + chr(0xE201) + "。"
                return
            yield "不用查。"
        with patch("easyread.server.config.load", return_value={}), patch("easyread.server.chat_models.engine_cfg", return_value=(engine, model)), \
                patch("easyread.server.chat.stream", side_effect=fake):
            events = self.post({"text": "Python 3.14 哪天發佈", "web": True})
            self.assertTrue(seen["web"])
            self.assertTrue(any(w in seen["prompt"] for w in ("上網搜尋", "上网搜寻", "上网搜索")))
            self.assertIn({"status": {"kind": "search", "query": "Python 3.14"}}, events)
            self.assertEqual([e["source"]["url"] for e in events if "source" in e], ["https://peps.python.org/pep-0745/"])  # 寫的時候只送打開讀過的
            final = next(e["sources"] for e in events if "sources" in e)
            self.assertEqual([x["url"] for x in final], ["https://python.org/downloads/release/python-3140", "https://peps.python.org/pep-0745/"])  # 引用的在前、打開的在後；沒用上的不列
            saved = chat_store.get(self.ws, events[0]["thread"])["messages"][-1]
            self.assertEqual(saved["content"], "3.14 是 2025 年發佈的（[官方](https://python.org/downloads/release/python-3140)）。")  # 模型留下的引用記號拿掉了
            self.assertEqual(saved["sources"], final)
            self.assertEqual(saved["sources"][0]["title"], "Python 3.14.0")
            off = self.post({"text": "不用查", "web": False})
            self.assertFalse(seen["web"])
            self.assertNotIn("sources", chat_store.get(self.ws, off[0]["thread"])["messages"][-1])


if __name__ == "__main__":
    unittest.main()
