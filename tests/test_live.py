"""讓回答快起來的那些事：Claude Code 常駐行程（預熱、追問接著問、圖直接附上）、Codex app-server 串流、不等網路探測、
JSON 解析不被 Markdown 連結帶偏、按翻譯時正在看的頁最先譯、選字翻譯的 low 強度和快取。
python -m unittest tests.test_live"""
import io
import json
import os
import queue
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from easyread import chat, claude_live, codex_live, engines, netcheck, quick, segments, usage
from tests.test_chat_lean import FakeProc, result_lines

LIVE_ON = {"EASYREAD_NO_LIVE": ""}
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489")  # 只要檔頭像 PNG 就好


class LiveProc(FakeProc):
    """常駐行程：沒被 kill 之前 poll() 是 None。"""

    def __init__(self, lines, err=""):
        super().__init__(lines, err)
        self.returncode = None

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9


def fake_popen(procs, calls):
    def popen(args, cwd):
        calls.append(list(args))
        return procs[len(calls) - 1]
    return popen


class ClaudeLiveTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, LIVE_ON)
        self.env.start()
        self.addCleanup(self.env.stop)
        claude_live._disabled = False
        claude_live.close_all()
        self.addCleanup(claude_live.close_all)
        self.addCleanup(setattr, claude_live, "_disabled", False)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.png = Path(self.tmp.name) / "c-p1-abc.png"
        self.png.write_bytes(PNG)

    def stream(self, procs, text, live, c=None, images=None):
        calls = []
        with mock.patch.object(engines, "claude_path", lambda c: "claude"), mock.patch.object(engines, "_popen", fake_popen(procs, calls)):
            out = "".join(chat._stream_claude(c or {"model": "sonnet", "reasoning_effort": "low"}, text, Path(self.tmp.name), threading.Event(),
                                              images=images, live=live))
        return out, calls

    def test_followup_reuses_the_process_and_sends_only_the_new_question(self):
        proc = LiveProc(result_lines("答一") + result_lines("答二"))
        out1, calls = self.stream([proc], "完整提示詞", {"thread": "t1", "turns": 0})
        self.assertEqual(out1, "答一")
        self.assertEqual(claude_live.bound_turns("t1"), 1)  # 行程留著、記著一輪
        out2, calls2 = self.stream([proc], "完整提示詞 2", {"thread": "t1", "turns": 1, "followup_text": "讀者接著問：為什麼"})
        self.assertEqual(out2, "答二")
        self.assertEqual(calls2, [])  # 沒有再開行程
        a = calls[0]
        self.assertIn("--input-format", a)
        self.assertEqual(a[a.index("--tools") + 1], "Read")
        self.assertEqual(a[a.index("--effort") + 1], "low")
        sent = [json.loads(line) for line in proc.stdin.getvalue().splitlines()]
        self.assertEqual([m["message"]["content"][-1]["text"] for m in sent], ["完整提示詞", "讀者接著問：為什麼"])

    def test_turn_count_mismatch_or_other_thread_starts_fresh_with_full_prompt(self):
        p1, p2 = LiveProc(result_lines("甲")), LiveProc(result_lines("乙"))
        self.stream([p1], "第一問", {"thread": "t1", "turns": 0})
        out, calls = self.stream([p2], "完整", {"thread": "t1", "turns": 5, "followup_text": "追問"})  # 對話記錄對不上（例如中途停止過）
        self.assertEqual((out, len(calls)), ("乙", 1))
        self.assertEqual(json.loads(p2.stdin.getvalue())["message"]["content"][-1]["text"], "完整")
        self.assertEqual(p1.returncode, -9)  # 舊的關掉了

    def test_images_go_inline_and_prompt_no_longer_asks_for_read(self):
        proc = LiveProc(result_lines("看到了"))
        out, _ = self.stream([proc], "問圖", {"thread": "t9", "turns": 0}, images=[self.png])
        self.assertEqual(out, "看到了")
        content = json.loads(proc.stdin.getvalue())["message"]["content"]
        self.assertEqual([b["type"] for b in content], ["image", "text"])
        self.assertEqual(content[0]["source"]["media_type"], "image/png")
        self.assertIn("附件", chat._images_hint(["clips/x.png"], "claude"))  # 不再叫它 Read
        self.assertEqual(engines.image_mode({"engine": "claude"}), "attached")

    def test_old_cli_falls_back_to_one_shot_call(self):
        procs = [LiveProc([], err="error: unknown option '--input-format'"), FakeProc(result_lines("答"))]
        out, calls = self.stream(procs, "q", {"thread": "t1", "turns": 0})
        self.assertEqual(out, "答")
        self.assertIn("--input-format", calls[0])
        self.assertNotIn("--input-format", calls[1])
        self.assertEqual(calls[1][calls[1].index("--tools") + 1], "Read")
        self.assertFalse(claude_live.enabled())  # 之後都走舊路
        self.assertEqual(engines.image_mode({"engine": "claude"}), "claude")
        self.assertIn("Read", chat._images_hint(["clips/x.png"], "claude"))

    def test_warm_starts_a_process_that_the_next_question_takes(self):
        proc = LiveProc(result_lines("答"))
        calls = []
        c = {"model": "sonnet"}
        with mock.patch.object(engines, "claude_path", lambda c: "claude"), mock.patch.object(engines, "_popen", fake_popen([proc], calls)):
            claude_live.warm(c, Path(self.tmp.name))
            claude_live.warm(c, Path(self.tmp.name))  # 還在啟動中：不開第二個
            for _ in range(100):
                if claude_live._sessions:
                    break
                time.sleep(0.01)
            claude_live.warm(c, Path(self.tmp.name))  # 已經有一個備著：不再開
            time.sleep(0.05)
            s = claude_live.acquire(c, Path(self.tmp.name), "Read", None, "t3", 0)
        self.assertEqual(len(calls), 1)
        self.assertIs(s.proc, proc)
        self.assertEqual(s.bound, "t3")
        claude_live.release(s, keep=True)
        self.assertEqual(claude_live.bound_turns("t3"), 0)

    def test_one_shot_translation_attaches_page_images(self):
        proc = LiveProc([json.dumps({"type": "result", "subtype": "success", "result": '{"blocks": []}', "usage": {}}) + "\n"])
        calls = []
        with mock.patch.object(engines, "claude_path", lambda c: "claude"), mock.patch.object(engines, "_popen", fake_popen([proc], calls)):
            text = engines.run_claude({"model": "sonnet", "lean": True}, "譯這頁", Path(self.tmp.name), images=[self.png])
        self.assertEqual(text, '{"blocks": []}')
        self.assertIn("--input-format", calls[0])
        self.assertEqual(json.loads(proc.stdin.getvalue())["message"]["content"][0]["type"], "image")
        self.assertEqual(proc.returncode, -9)  # 一次性的，用完關掉

    def test_quick_translate_uses_low_effort_no_tools_and_its_own_system_prompt(self):
        cfg = {"chat": {"models": [{"id": "s", "engine": "claude", "model": "sonnet"}], "default": "s"}, "claude": {"model": "sonnet"}, "engine": "claude",
               "quick": {"translate_model": ""}, "openai": {}, "codex": {}}
        ecfg, m = quick.engine_cfg(cfg, None)
        self.assertEqual(ecfg["claude"]["reasoning_effort"], "low")
        proc = LiveProc(result_lines("譯文"))
        calls = []
        with mock.patch.object(engines, "claude_path", lambda c: "claude"), mock.patch.object(engines, "_popen", fake_popen([proc], calls)):
            out = "".join(chat._stream_claude(ecfg["claude"], "翻這段", Path(self.tmp.name), threading.Event(), live={"tools": "", "system": "你是選字翻譯"}))
        self.assertEqual(out, "譯文")
        a = calls[0]
        self.assertEqual(a[a.index("--tools") + 1], "")
        self.assertNotIn("--allowedTools", a)
        self.assertEqual(a[a.index("--system-prompt") + 1], "你是選字翻譯")
        self.assertEqual(proc.returncode, -9)  # 沒綁對話：用完關掉
        quick.remember(("s", "zh-TW", "hello"), "你好")
        self.assertEqual(quick.cached(("s", "zh-TW", "hello")), "你好")
        self.assertIsNone(quick.cached(("s", "zh-TW", "bye")))


class FakeAppServer:
    """假的 codex app-server：讀 stdin 的請求，照腳本往 stdout 吐回覆和通知。"""

    def __init__(self):
        self.q: queue.Queue = queue.Queue()
        self.sent = []
        self.returncode = None
        self.stdin = self
        self.stdout = iter(self.q.get, None)
        self.stderr = io.StringIO()

    def write(self, s):
        for line in s.splitlines():
            ev = json.loads(line)
            self.sent.append(ev)
            for out in self.reply(ev):
                self.q.put(json.dumps(out) + "\n")

    def flush(self):
        pass

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9
        self.q.put(None)

    def reply(self, ev):
        m, rid, p = ev.get("method"), ev.get("id"), ev.get("params") or {}
        if m == "initialize":
            return [{"id": rid, "result": {"userAgent": "fake"}}]
        if m == "thread/start":
            return [{"id": rid, "result": {"thread": {"id": "th%d" % len([x for x in self.sent if x.get("method") == "thread/start"])}}}]
        if m == "turn/start":
            tid = p["threadId"]
            return [{"id": rid, "result": {}},
                    {"method": "turn/started", "params": {"threadId": tid, "turn": {"id": "turn1"}}},
                    {"method": "account/rateLimits/updated", "params": {"rateLimits": {"primary": {"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1791196240},
                                                                                         "secondary": {"usedPercent": 12, "windowDurationMins": 10080, "resetsAt": 1791614566}}}},
                    {"method": "item/agentMessage/delta", "params": {"threadId": tid, "delta": "你"}},
                    {"method": "item/agentMessage/delta", "params": {"threadId": tid, "delta": "好"}},
                    {"method": "thread/tokenUsage/updated", "params": {"threadId": tid, "tokenUsage": {"last": {"inputTokens": 16825, "cachedInputTokens": 15104, "outputTokens": 45}}}},
                    {"method": "turn/completed", "params": {"threadId": tid, "turn": {"id": "turn1", "status": "completed"}}}]
        return []


class CodexLiveTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, LIVE_ON)
        self.env.start()
        self.addCleanup(self.env.stop)
        codex_live._disabled = False
        codex_live._client = None
        codex_live._threads.clear()
        self.addCleanup(codex_live.disable)
        self.addCleanup(setattr, codex_live, "_disabled", False)
        self.cwd = Path(tempfile.gettempdir()) / "paper-x"

    def test_streams_deltas_keeps_thread_and_reports_plan_usage(self):
        srv = FakeAppServer()
        meter = usage.Meter("codex")
        live_calls = []
        c = {"model": "gpt-6.1-sol", "reasoning_effort": "low"}
        with mock.patch.object(engines, "codex_path", lambda c: "codex"), mock.patch.object(engines, "_popen", lambda a, cwd: srv), \
                mock.patch.object(codex_live.codex_lean, "args", lambda: ["-c", "features.apps=false"]):
            out = list(codex_live.stream(c, "問題", self.cwd, threading.Event(), meter, None, "t1", 0, None, lambda: live_calls.append(1)))
            self.assertEqual(out, ["你", "好"])
            self.assertEqual(live_calls, [1])
            self.assertEqual(codex_live.bound_turns("paper-x", "t1", "gpt-6.1-sol", self.cwd), 1)
            out2 = list(codex_live.stream(c, "完整", self.cwd, threading.Event(), meter, None, "t1", 1, "追問", None))
        self.assertEqual(out2, ["你", "好"])
        methods = [x.get("method") for x in srv.sent]
        self.assertEqual(methods, ["initialize", "initialized", "thread/start", "turn/start", "turn/start"])  # 追問沒再開對話
        start = srv.sent[2]["params"]
        self.assertEqual((start["model"], start["sandbox"], start["approvalPolicy"], start["ephemeral"]), ("gpt-6.1-sol", "read-only", "never", True))
        turns = [x["params"] for x in srv.sent if x.get("method") == "turn/start"]
        self.assertEqual([t["input"][-1]["text"] for t in turns], ["問題", "追問"])
        self.assertEqual(turns[0]["effort"], "low")
        snap = meter.snapshot()
        self.assertEqual((snap["calls"], snap["input"], snap["cached"], snap["output"]), (2, 33650, 30208, 90))
        self.assertEqual(snap["limits"]["five_hour"], {"used": 0.03, "resets_at": 1791196240})
        self.assertEqual(snap["limits"]["seven_day"]["used"], 0.12)
        self.assertEqual(snap["limits"]["engine"], "codex")

    def test_model_change_starts_a_new_thread_and_images_become_data_urls(self):
        srv = FakeAppServer()
        png = self.cwd / "clips" / "c.png"
        png.parent.mkdir(parents=True, exist_ok=True)
        png.write_bytes(PNG)
        with mock.patch.object(engines, "codex_path", lambda c: "codex"), mock.patch.object(engines, "_popen", lambda a, cwd: srv), \
                mock.patch.object(codex_live.codex_lean, "args", lambda: []):
            list(codex_live.stream({"model": "a"}, "q1", self.cwd, threading.Event(), None, None, "t1", 0, None, None))
            list(codex_live.stream({"model": "b"}, "q2", self.cwd, threading.Event(), None, [png], "t1", 1, "追問", None))
        turns = [x["params"] for x in srv.sent if x.get("method") == "turn/start"]
        self.assertEqual(len([x for x in srv.sent if x.get("method") == "thread/start"]), 2)
        self.assertEqual(turns[1]["input"][-1]["text"], "q2")  # 換了模型：完整提示詞
        self.assertTrue(turns[1]["input"][0]["url"].startswith("data:image/png;base64,"))

    def test_chat_falls_back_to_exec_when_app_server_is_unavailable(self):
        seen = []

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            seen.append(prompt)
            return "整段"
        cfg = {"engine": "codex", "codex": {"model": "m"}, "claude": {}, "openai": {}}
        with mock.patch.object(engines, "codex_path", lambda c: None), mock.patch.object(engines, "run", run), \
                mock.patch.object(chat.netcheck, "quick_problem", lambda c: None):
            out = list(chat.stream(cfg, "q", self.cwd, threading.Event(), live={"thread": "t1", "turns": 0}))
        self.assertEqual((out, seen), (["整段"], ["q"]))
        self.assertFalse(codex_live.enabled())  # 起不來就不再試


class SmallThingsTest(unittest.TestCase):
    def setUp(self):
        netcheck._ok.clear()
        netcheck._bad.clear()
        netcheck._probing.clear()

    def test_quick_problem_does_not_wait_but_remembers_a_failed_probe(self):
        cfg = {"engine": "openai", "openai": {"base_url": "http://127.0.0.1:1/v1"}}
        with mock.patch.object(netcheck, "problem", lambda c, timeout=6: time.sleep(0.05) or "连不上 接口（127.0.0.1）：先把它打开，再点重试。"):
            t0 = time.time()
            self.assertIsNone(netcheck.quick_problem(cfg))  # 第一次：先放行，背景去探
            self.assertLess(time.time() - t0, 0.04)
            for _ in range(100):
                if netcheck._bad:
                    break
                time.sleep(0.01)
            self.assertIn("先把它打开", netcheck.quick_problem(cfg))  # 探到連不上：下一次立刻說
        netcheck._ok["http://127.0.0.1:1/"] = time.time()
        self.assertIsNone(netcheck.quick_problem(cfg))  # 通過過就直接放行

    def test_parse_json_skips_markdown_links_before_the_object(self):
        text = ('我已核對原頁圖（[extract/page-006.jpg](file:///x/page-006.jpg)、[page-007.jpg](file:///x/page-007.jpg)）。\n\n'
                '{"blocks": [{"id": "p6-1", "type": "para", "page": 6, "en": "x", "zh": "譯"}]}')
        self.assertEqual(engines.parse_json(text)["blocks"][0]["id"], "p6-1")
        self.assertEqual(engines.parse_json('前言 [1]\n[{"id": "a"}, {"id": "b"}]')[1]["id"], "b")  # 數組輸出照樣認
        with self.assertRaises(engines.EngineError):
            engines.parse_json("沒有 JSON [連結](x)")

    def test_focus_page_lands_in_the_first_batch_of_a_lane(self):
        root = Path(tempfile.mkdtemp())
        pages = list(range(1, 20))
        plan = segments.plan(pages, 2, 4, root, focus=12)
        self.assertEqual([p for seg in plan for p in seg], pages)
        self.assertTrue(any(seg[0] == 12 for seg in plan), plan)
        self.assertEqual(segments.plan(pages, 2, 4, root, focus=1), segments.plan(pages, 2, 4, root))  # 第一頁本來就最先
        self.assertEqual(segments.plan(pages, 2, 4, root, focus=99), segments.plan(pages, 2, 4, root))
        self.assertEqual(segments.plan([3, 4, 5], 2, 1, root, focus=5), [[3, 4, 5]])  # 只有一段：不切

    def test_codex_live_usage_and_same_spot(self):
        rec = usage.from_codex_live({"inputTokens": 10, "cachedInputTokens": 4, "outputTokens": 2}, {"five_hour": {"used": 0.1}, "engine": "codex"})
        self.assertEqual((rec["input"], rec["cached"], rec["output"], rec["limits"]["engine"]), (10, 4, 2, "codex"))
        self.assertNotIn("limits", usage.from_codex_live(None, None))
        prev = {"anchor": "p1", "page": None, "quote": "q", "refs": [{"anchor": "p1", "quote": "q"}]}
        self.assertTrue(chat.same_spot(prev, {"anchor": "p1", "quote": "q"}, [{"anchor": "p1", "quote": "q", "page": None}], None))
        self.assertFalse(chat.same_spot(prev, {"anchor": "p2", "quote": "q"}, prev["refs"], None))
        self.assertFalse(chat.same_spot(None, {"anchor": "p1", "quote": "q"}, [], None))

    def test_followup_prompt_only_carries_the_new_question(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        from easyread.store import Workspace, write_json_atomic
        ws = Workspace(Path(tmp.name))
        write_json_atomic(ws.paper_path, {"meta": {"title_en": "T", "target": "zh-TW", "page_count": 3}, "blocks": []})
        (ws.root / "extract").mkdir()
        (ws.root / "extract" / "page-002.txt").write_text("page two text", encoding="utf-8")
        msgs = [{"role": "user", "content": "一"}, {"role": "assistant", "content": "答"}, {"role": "user", "content": "為什麼？"}]
        full = chat.prompt(ws, msgs, None, "", "claude", page=2)
        self.assertIn("page-003.txt", full)       # 告訴它一頁一個檔
        self.assertNotIn("读当前目录的 paper.json", full)
        self.assertIn("之前的對話", full)
        follow = chat.prompt(ws, msgs, None, "", "claude", page=2, followup=True)
        self.assertIn("讀者接著問：為什麼？", follow)
        self.assertIn("page two text", full)        # 整份不長：第一問就把整份文字帶上
        self.assertIn("第 2 頁", follow)             # 位置變了：說現在看哪一頁（那頁的文字行程已經有了，不再貼一次）
        self.assertNotIn("page two text", follow)
        self.assertNotIn("之前的對話", follow)
        same = chat.prompt(ws, msgs, None, "", "claude", page=2, followup=True, with_context=False)
        self.assertNotIn("第 2 頁", same)
        self.assertIn("還指著剛才那一處", same)


if __name__ == "__main__":
    unittest.main()
