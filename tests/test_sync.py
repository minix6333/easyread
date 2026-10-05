"""文獻庫放在雲端硬碟同步資料夾：兩台電腦各寫自己的筆記日誌、互相合併；可重算的檔案放本機快取；翻譯任務認得是誰在跑。
python -m unittest tests.test_sync"""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import config, jobs, paths, sync
from easyread.store import Workspace, write_json_atomic


class TwoDevices:
    """同一個文獻庫資料夾（模擬雲端硬碟已經同步好），兩台電腦各有自己的快取和裝置 id。"""

    def __init__(self, base: Path):
        self.lib = base / "GoogleDrive" / "EasyRead"
        self.lib.mkdir(parents=True)
        self.caches = {"mac": base / "cache-mac", "win": base / "cache-win"}
        self.devices = {"mac": {"id": "devmac", "name": "MacBook"}, "win": {"id": "devwin", "name": "PC"}}

    def use(self, who: str):
        paths._device = dict(self.devices[who])
        config.CACHE_DIR = self.caches[who]
        paths.forget()


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = mock.patch.dict(os.environ, {"EASYREAD_SYNC": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self._cache, self._device = config.CACHE_DIR, paths._device
        self.addCleanup(lambda: (setattr(config, "CACHE_DIR", self._cache), setattr(paths, "_device", self._device), paths.forget()))
        self.two = TwoDevices(self.tmp)
        self.paper = self.two.lib / "p1"
        self.paper.mkdir()
        write_json_atomic(self.paper / "paper.json", {"meta": {"title_en": "T", "pages": []}, "blocks": []})

    def note(self, nid, body, updated):
        return {"op": "note", "note": {"id": nid, "kind": "note", "body": body, "updated": updated, "page": 1, "side": "pdf"}, "at": updated}

    def test_each_device_writes_its_own_journal_and_the_other_merges_it(self):
        self.two.use("mac")
        ws = Workspace(self.paper)
        ws.apply_reader_ops([self.note("n1", "mac 寫的", "2026-10-05T10:00:00")], client="c1")
        self.assertTrue((self.paper / "sync" / "devmac.jsonl").is_file())      # 自己的日誌在同步資料夾裡
        self.assertFalse((self.paper / "reader.json").exists())                # 合併結果不放同步資料夾
        self.assertTrue((self.two.caches["mac"] / "p1" / "reader.json").is_file())
        self.two.use("win")
        self.assertEqual(Workspace(self.paper).load("reader")["notes"], {})      # 還沒拉
        self.assertEqual(sync.pull_once(self.two.lib), 1)
        got = Workspace(self.paper).load("reader")["notes"]["n1"]
        self.assertEqual(got["body"], "mac 寫的")
        self.assertFalse((self.paper / "sync" / "devwin.jsonl").exists())      # 別台的東西不會再寫回自己的日誌
        self.assertEqual(sync.pull_once(self.two.lib), 0)                      # 讀過的不重讀
        # Windows 這邊改同一條（時間較新）→ Mac 拉回來以新的為準；Mac 自己舊的改動不會蓋掉它
        Workspace(self.paper).apply_reader_ops([self.note("n1", "win 改的", "2026-10-05T11:00:00")], client="c2")
        self.two.use("mac")
        sync.pull_once(self.two.lib)
        Workspace(self.paper).apply_reader_ops([self.note("n1", "mac 更早的改動", "2026-10-05T10:30:00")], client="c1")
        self.assertEqual(Workspace(self.paper).load("reader")["notes"]["n1"]["body"], "win 改的")
        st = sync.status()
        self.assertTrue(st["enabled"] and st["applied"] >= 1 and "devmac" in st["devices"] or "devwin" in st["devices"])

    def test_existing_reader_is_moved_to_cache_and_shared_as_a_snapshot(self):
        write_json_atomic(self.paper / "reader.json", {"schema": 2, "rev": 3, "notes": {"old": {"id": "old", "kind": "note", "body": "舊筆記", "updated": "2026-10-01T00:00:00"}},
                                                       "page_notes": {"2": {"body": "第二頁", "at": "2026-10-01T00:00:00", "star": True}}, "paper_note": {"body": "總結", "at": "2026-10-01T00:00:00"}, "edits": {}, "progress": {}})
        self.two.use("mac")
        self.assertEqual(Workspace(self.paper).load("reader")["notes"]["old"]["body"], "舊筆記")  # 第一次讀就搬走並寫快照
        self.assertFalse((self.paper / "reader.json").exists())
        lines = (self.paper / "sync" / "devmac.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(lines[0])["ops"][0]["op"], "snapshot")
        self.two.use("win")
        sync.pull_once(self.two.lib)
        r = Workspace(self.paper).load("reader")
        self.assertEqual(r["notes"]["old"]["body"], "舊筆記")
        self.assertEqual(r["page_notes"]["2"], {"body": "第二頁", "at": "2026-10-01T00:00:00", "star": True})
        self.assertEqual(r["paper_note"]["body"], "總結")

    def test_derived_files_live_in_the_local_cache_and_legacy_folders_are_moved(self):
        (self.paper / "pages").mkdir()
        (self.paper / "pages" / "page-001.webp").write_bytes(b"RIFF")
        self.two.use("mac")
        pages = paths.derived(self.paper, "pages")
        self.assertEqual(pages, self.two.caches["mac"] / "p1" / "pages")
        self.assertTrue((pages / "page-001.webp").is_file() and not (self.paper / "pages").exists())
        self.assertEqual(paths.derived(self.paper, "clips"), self.paper / "clips")  # 使用者的截圖照樣同步
        with mock.patch.dict(os.environ, {"EASYREAD_SYNC": "0"}):
            paths.forget()
            self.assertEqual(paths.derived(self.paper, "extract"), self.paper / "extract")  # 不同步的庫一切照舊

    def test_half_written_journal_line_is_retried_next_time(self):
        self.two.use("mac")
        d = self.paper / "sync"
        d.mkdir()
        good = json.dumps({"t": "2026-10-05T10:00:00", "ops": [self.note("a", "好的", "2026-10-05T10:00:00")]})
        (d / "devwin.jsonl").write_text(good + "\n" + '{"t": "2026-10-05T10:01:00", "ops": [{"op": "no', encoding="utf-8")
        self.assertEqual(sync.pull_once(self.two.lib), 1)
        (d / "devwin.jsonl").write_text(good + "\n" + json.dumps({"t": "x", "ops": [self.note("b", "補完", "2026-10-05T10:01:00")]}) + "\n", encoding="utf-8")
        self.assertEqual(sync.pull_once(self.two.lib), 1)
        self.assertEqual(set(Workspace(self.paper).load("reader")["notes"]), {"a", "b"})

    def test_jobs_know_which_device_runs_them(self):
        self.two.use("mac")
        mine = {"state": "running", "device": "devmac", "device_name": "MacBook", "updated": "2026-10-05T10:00:00", "message": "第 1 頁"}
        self.assertFalse(jobs.foreign(mine))
        other = dict(mine, device="devwin", device_name="PC")
        self.assertTrue(jobs.foreign(other))
        with mock.patch("easyread.jobs.time.time", return_value=1e12):
            self.assertTrue(jobs.stale(other))
            self.assertEqual(jobs.view(other)["state"], "error")  # 太久沒動：當成停了，這邊可以重開
        from datetime import datetime
        fresh = dict(other, updated=datetime.now().isoformat(timespec="seconds"))
        v = jobs.view(fresh)
        self.assertTrue(v["remote"] and "PC" in v["message"] and v["state"] == "running")
        self.assertIsNone(jobs.view(None))
        self.assertEqual(jobs.view({"state": "done", "device": "devwin"})["state"], "done")


if __name__ == "__main__":
    unittest.main()
