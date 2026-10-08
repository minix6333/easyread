"""預讀（preread.py）和補充資料（supp.py）：整份文件加補充資料一起給模型；匯入、第一問時在背景讀成全文筆記，之後每一問帶著。
模型是假的（把 chat.stream 換掉），不連網、不花額度。"""
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from easyread import chat, config, docmap, paths, preread, supp
from easyread.store import Workspace, write_json_atomic


def tiny_pdf(text: str) -> bytes:
    """一頁、一行字的最小 PDF（補充資料抽文字用）。"""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n" + b"".join(f"{off:010d} 00000 n \n".encode() for off in offsets)
    return out + b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"


PAGES = {1: "Finetuning with Sampling\nAbstract\nWe study supervised finetuning with a sampling step.",
         2: "2 Method\nThe acceptance ratio decides which samples are kept during training.",
         3: "3 Experiments\nMath and coding benchmarks improve over the baseline."}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name) / "paper1")
        self.ws.root.mkdir()
        write_json_atomic(self.ws.paper_path, {"meta": {"title_en": "Test", "page_count": 3, "target": "zh-TW"}, "blocks": []})
        d = paths.derived(self.ws.root, "extract")
        d.mkdir(parents=True, exist_ok=True)
        for n, t in PAGES.items():
            (d / f"page-{n:03d}.txt").write_text(t, encoding="utf-8")
        cfg = {**config.DEFAULTS, "engine": "openai", "preread": True}
        patcher = mock.patch.object(config, "load", lambda: cfg)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cfg = cfg
        preread._running.clear()

    def wait(self):
        for _ in range(200):
            if self.ws.id not in preread._running:
                return
            time.sleep(0.01)
        self.fail("預讀沒有結束")  # i18n-ok 測試


class SuppTest(Base):
    def test_add_list_remove_and_text_goes_to_the_model(self):
        with self.assertRaises(ValueError):
            supp.add(self.ws.root, b"not a pdf", "x.pdf")
        pdf = tiny_pdf("Supplementary proof of Lemma 3 about the acceptance ratio")
        self.assertEqual(supp.add(self.ws.root, pdf, "../../evil/Appendix: proofs?.pdf"), {"file": "Appendix proofs.pdf", "new": True})  # 檔名裡的路徑和怪字元拿掉
        self.assertEqual(supp.add(self.ws.root, pdf, "Appendix proofs.pdf")["new"], False)  # 同一個檔不重複放
        other = tiny_pdf("Extra experiments on robustness")
        self.assertEqual(supp.add(self.ws.root, other, "Appendix proofs.pdf")["file"], "Appendix proofs (2).pdf")
        items = supp.listing(self.ws.root)
        self.assertEqual([(i["key"], i["pages"]) for i in items], [("S1", 1), ("S2", 1)])
        self.assertGreater(items[0]["chars"], 20)
        # 給模型的整份文字：本文在前，補充資料接在後面，各有標籤
        full = docmap.full_text(self.ws)
        self.assertIn("[第 2 页]", full)
        self.assertIn("补充资料 S1（Appendix proofs (2)）第 1 页", full)
        self.assertIn("Supplementary proof of Lemma 3", full)
        self.assertLess(full.index("[第 3 页]"), full.index("补充资料 S1"))
        self.assertIn("补充资料 S2", docmap.outline(self.ws))
        self.assertEqual(docmap.size(self.ws), sum(len(t) for t in PAGES.values()) + sum(i["chars"] for i in items))
        # 放不下整份時：相關頁也會找到補充資料裡的
        near = docmap.nearby(self.ws, "Lemma 3 的證明在哪？proof", skip=())
        self.assertIn("Supplementary proof", near)
        self.assertTrue(supp.remove(self.ws.root, "Appendix proofs.pdf"))
        self.assertFalse(supp.remove(self.ws.root, "Appendix proofs.pdf"))
        self.assertEqual(len(supp.listing(self.ws.root)), 1)
        self.assertFalse(supp.remove(self.ws.root, "../paper.json"))  # 只能拿掉 supp/ 裡的 PDF
        self.assertTrue(self.ws.paper_path.exists())


class PrereadTest(Base):
    def fake(self, calls, text="# 全文筆記\n- 主線：用取樣做微調。\n- 第 2 頁：接受率。"):
        def stream(ecfg, prompt, cwd, cancel, *a, **k):
            calls.append(prompt)
            yield text[:10]
            yield text[10:]
        return mock.patch.object(chat, "stream", stream)

    def test_reads_once_in_background_and_every_question_carries_the_notes(self):
        calls = []
        with self.fake(calls):
            self.assertEqual(preread.status(self.ws)["state"], "none")
            self.assertTrue(preread.auto(self.ws))
            self.wait()
            self.assertFalse(preread.auto(self.ws))  # 讀過了：不重複讀
        self.assertEqual(len(calls), 1)
        self.assertIn("全文筆記", calls[0])
        self.assertIn("The acceptance ratio decides", calls[0])  # 整份文字都給了
        self.assertIn("繁體中文", calls[0])
        st = preread.status(self.ws)
        self.assertEqual((st["state"], st["pages"], st["whole"], st["calls"]), ("done", 3, True, 1))
        self.assertIn("主線：用取樣做微調", preread.text(self.ws))
        prompt = chat.prompt(self.ws, [{"role": "user", "content": "這篇的主要貢獻是什麼？"}], None, "", "openai", page=1)
        self.assertIn("主線：用取樣做微調", prompt)          # 全文筆記
        self.assertIn("Math and coding benchmarks", prompt)  # 整份文字（不只正在看的第 1 頁）
        self.assertLess(prompt.index("主線：用取樣做微調"), prompt.index("讀者現在問"))

    def test_supplementary_change_makes_notes_stale_and_is_read_again(self):
        calls = []
        with self.fake(calls):
            preread.start(self.ws)
            self.wait()
            supp.add(self.ws.root, tiny_pdf("Supplementary hyperparameters table"), "supp.pdf")
            self.assertEqual(preread.status(self.ws)["state"], "stale")
            self.assertTrue(preread.auto(self.ws))
            self.wait()
        self.assertEqual(len(calls), 2)
        self.assertIn("Supplementary hyperparameters table", calls[1])
        self.assertEqual(preread.status(self.ws)["state"], "done")

    def test_long_documents_are_read_in_parts_and_very_long_ones_wait_for_the_reader(self):
        d = paths.derived(self.ws.root, "extract")
        for n in (1, 2, 3):
            (d / f"page-{n:03d}.txt").write_text(f"PAGE{n} " + "x" * 500, encoding="utf-8")
        calls = []
        with self.fake(calls), mock.patch.object(preread, "CHUNK", 700):
            chunks = preread._chunks(self.ws)
            self.assertEqual(len(chunks), 3)           # 一頁不拆開，放不下就下一段
            self.assertEqual(chunks[0][0], "第 1 页")
            with mock.patch.object(preread, "AUTO_MAX", 1000):
                self.assertFalse(preread.auto(self.ws))  # 太長：不自動讀
                self.assertTrue(preread.status(self.ws)["too_long"])
            preread.start(self.ws)                     # 讀者自己按
            self.wait()
        self.assertEqual(len(calls), 3)
        self.assertIn("分成 3 段", calls[1])
        notes = preread.text(self.ws)
        self.assertEqual(notes.count("【"), 3)          # 每段的筆記標上頁碼範圍
        self.assertLessEqual(len(preread.text(self.ws, budget=300)), 3 * 700)

    def test_setting_off_no_model_and_failures_do_not_loop(self):
        calls = []
        with self.fake(calls):
            self.cfg["preread"] = False
            self.assertFalse(preread.auto(self.ws))
            self.cfg["preread"] = True
            self.cfg["engine"] = "none"
            self.assertFalse(preread.auto(self.ws))
            self.cfg["engine"] = "openai"
        self.assertEqual(calls, [])

        def boom(*a, **k):
            raise RuntimeError("no quota")
            yield ""  # noqa: unreachable — 讓它是生成器
        with mock.patch.object(chat, "stream", boom):
            self.assertTrue(preread.auto(self.ws))
            self.wait()
            st = preread.status(self.ws)
            self.assertEqual(st["state"], "error")
            self.assertIn("no quota", st["error"])
            self.assertFalse(preread.auto(self.ws))    # 同一份內容失敗過：不自己再試（讀者可以按「現在讀」）
        self.assertEqual(preread.text(self.ws), "")

    def test_cancel_stops_between_parts(self):
        started = threading.Event()

        def slow(ecfg, prompt, cwd, cancel, *a, **k):
            started.set()
            while not cancel.is_set():
                time.sleep(0.005)
            from easyread import engines
            raise engines.Cancelled()
            yield ""  # noqa
        with mock.patch.object(chat, "stream", slow):
            preread.start(self.ws)
            started.wait(1)
            self.assertEqual(preread.status(self.ws)["state"], "running")
            preread.cancel(self.ws)
            self.wait()
        self.assertEqual(preread.status(self.ws)["state"], "none")


if __name__ == "__main__":
    unittest.main()
