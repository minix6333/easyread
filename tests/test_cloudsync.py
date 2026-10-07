"""雲端同步的「誰在用哪個資料夾」：找出雲端硬碟裡所有的文獻庫、合併走散的、留路標讓另一台自己跟過來、裝置名冊；
另一台匯入的論文在這台打開時頁面圖和文字要做得出來。  python -m unittest tests.test_cloudsync"""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pypdfium2 as pdfium

from easyread import cloudlib_detect, cloudsync, config, derive, paths, sync
from easyread.store import Workspace, read_json, write_json_atomic


def make_pdf(path: Path, pages: int = 3):
    pdf = pdfium.PdfDocument.new()
    for _ in range(pages):
        pdf.new_page(300, 400)
    pdf.save(str(path))
    pdf.close()


def paper(lib: Path, pid: str, pages: int = 0, **files):
    d = lib / pid
    d.mkdir(parents=True)
    write_json_atomic(d / "item.json", {"added": "2026-10-05T10:00:00+08:00"})
    write_json_atomic(d / "paper.json", {"meta": {"title_en": pid, "page_count": pages, "pages": [{"n": i + 1, "img": f"pages/page-{i + 1:03d}.webp"} for i in range(pages)]}, "blocks": []})
    if pages:
        make_pdf(d / "source.pdf", pages)
    for name, data in files.items():
        write_json_atomic(d / name.replace("_", "."), data)
    return d


def journal(paper_dir: Path, dev: str, *ops, t="2026-10-05T12:00:00+08:00"):
    (paper_dir / "sync").mkdir(exist_ok=True)
    with open(paper_dir / "sync" / f"{dev}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": t, "ops": list(ops)}, ensure_ascii=False) + "\n")


def note(nid, body, updated="2026-10-05T12:00:00+08:00"):
    return {"op": "note", "note": {"id": nid, "kind": "note", "body": body, "updated": updated, "page": 1, "side": "pdf"}, "at": updated}


class Base(unittest.TestCase):
    """一個假的雲端硬碟根目錄 drive/；兩台電腦各有自己的資料目錄（快取、裝置 id）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.drive = self.tmp / "drive"
        self.canon = self.drive / "EasyRead"
        self.canon.mkdir(parents=True)
        env = mock.patch.dict(os.environ, {"EASYREAD_CLOUD_ROOTS": str(self.drive), "EASYREAD_SYNC": "1"})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("EASYREAD_LIBRARY", None)
        saved = (config.HOME, config.CONFIG_PATH, config.CACHE_DIR, paths._device)
        self.addCleanup(lambda: (setattr(config, "HOME", saved[0]), setattr(config, "CONFIG_PATH", saved[1]), setattr(config, "CACHE_DIR", saved[2]),
                                 setattr(paths, "_device", saved[3]), paths.forget(), setattr(cloudsync, "_roots", (0.0, [])), setattr(cloudsync, "_notice", None),
                                 cloudsync._saw.clear()))
        cloudsync._roots = (0.0, [])
        cloudsync._saw.clear()
        self.use("mac")

    def use(self, who: str):
        home = self.tmp / f"home-{who}"
        home.mkdir(exist_ok=True)
        config.HOME, config.CONFIG_PATH, config.CACHE_DIR = home, home / "config.json", home / "cache"
        paths._device = {"id": f"dev{who}", "name": {"mac": "MacBook", "win": "PC"}[who]}
        paths.forget()
        cloudsync._saw.clear()
        cloudsync._last_beat = 0.0  # 模組裡記的是「這台」上次寫心跳的時間；換一台就重來
        cloudsync._ack_due = False


class DiscoveryTest(Base):
    def test_finds_libraries_in_root_canonical_folder_and_one_level_down(self):
        paper(self.canon, "p1"); paper(self.canon, "p2")
        paper(self.drive, "rootpaper")                              # 論文資料夾直接散在雲端硬碟根目錄（另一台把根目錄當成文獻庫）
        paper(self.drive / "我的雲端硬碟" / "EasyRead", "old1")       # 下一層資料夾裡還有一份舊的
        (self.drive / "Photos").mkdir()
        libs = {lib["rel"]: lib for lib in cloudsync.libraries(self.drive)}
        self.assertEqual(sorted(libs), ["", "EasyRead", "我的雲端硬碟/EasyRead"])
        self.assertEqual(libs[""]["ids"], ["rootpaper"])
        self.assertEqual(libs["EasyRead"]["count"], 2)

    def test_advice_merge_strays_when_this_computer_uses_the_agreed_folder(self):
        paper(self.canon, "p1")
        paper(self.drive, "rootpaper")
        paper(self.drive / "sub" / "EasyRead", "p1"); paper(self.drive / "sub" / "EasyRead", "old1")
        r = cloudsync.report(self.canon)
        self.assertTrue(r["enabled"]); self.assertTrue(r["canonical"])
        self.assertEqual(r["advice"]["kind"], "absorb")
        self.assertEqual(r["advice"]["count"], 3)
        self.assertEqual(r["advice"]["new"], 2)  # rootpaper、old1；p1 兩邊都有

    def test_advice_join_when_this_computer_uses_another_folder_in_the_same_drive(self):
        paper(self.canon, "p1")
        paper(self.drive, "rootpaper")
        self.use("win")
        r = cloudsync.report(self.drive)  # 這台把根目錄當文獻庫
        self.assertFalse(r["canonical"])
        self.assertEqual((r["advice"]["kind"], r["advice"]["mode"], r["advice"]["split"]), ("join", "merge", True))
        self.assertEqual(Path(r["advice"]["path"]), self.canon)

    def test_advice_join_from_a_local_library_and_start_when_the_drive_is_empty(self):
        local = self.tmp / "local-lib"
        paper(local, "mine1")
        with mock.patch.dict(os.environ, {"EASYREAD_SYNC": "0"}):
            paths.forget()
            r = cloudsync.report(local)
            self.assertEqual((r["enabled"], r["advice"]["kind"]), (False, "start"))  # 雲端硬碟裡還沒有文獻庫：可以放進去
            paper(self.canon, "p1")
            r = cloudsync.report(local)
            self.assertEqual((r["advice"]["kind"], r["advice"]["mode"], r["advice"]["count"]), ("join", "merge", 1))
            self.assertNotIn("split", r["advice"])

    def test_picking_the_drive_root_means_the_easyread_folder_inside_it(self):
        paper(self.drive, "rootpaper")  # 根目錄裡散著論文也一樣
        self.assertEqual(cloudlib_detect.target_path(self.drive), self.canon)
        self.assertEqual(cloudlib_detect.target_path(self.canon), self.canon)


class MergeTest(Base):
    def test_absorb_copies_missing_papers_merges_notes_and_leaves_a_signpost(self):
        cloudsync.ensure_marker(self.canon)
        both = paper(self.canon, "both", chat_json={"threads": [{"id": "t1", "title": "here", "updated": "2026-10-06T10:00:00"}]})
        stray = self.drive / "sub" / "EasyRead"
        old = paper(stray, "both", chat_json={"threads": [{"id": "t1", "title": "older", "updated": "2026-10-05T10:00:00"}, {"id": "t2", "title": "only there", "updated": "2026-10-05T11:00:00"}]},
                    discussion_json={"entries": [{"id": "d1", "body": "AI 回答", "at": "2026-10-05T11:00:00"}]})
        journal(old, "devwin", note("n1", "另一台在舊資料夾寫的"))
        (old / "clips").mkdir(); (old / "clips" / "c-1.png").write_bytes(b"png")
        only = paper(stray, "onlythere", pages=2)
        write_json_atomic(only / "reader.json", {"notes": {"n9": {"id": "n9", "kind": "note", "body": "舊格式的筆記", "updated": "2026-10-05T09:00:00"}}})
        done = cloudsync.absorb(self.canon, stray)
        self.assertEqual((done["copied"], done["merged"]), (["onlythere"], ["both"]))
        self.assertTrue((self.canon / "onlythere" / "source.pdf").is_file())
        self.assertTrue((stray / "onlythere" / "source.pdf").is_file())                    # 舊資料夾不刪
        self.assertFalse((self.canon / "onlythere" / "reader.json").exists())              # 舊格式的筆記轉成日誌裡的快照
        self.assertIn("舊格式的筆記", (self.canon / "onlythere" / "sync" / "merged.jsonl").read_text(encoding="utf-8"))
        self.assertTrue((both / "sync" / "devwin.jsonl").is_file())
        self.assertTrue((both / "clips" / "c-1.png").is_file())
        threads = {t["id"]: t["title"] for t in read_json(both / "chat.json")["threads"]}
        self.assertEqual(threads, {"t1": "here", "t2": "only there"})                      # 兩邊都有的留較新的，只有那邊有的加進來
        self.assertEqual(len(read_json(both / "discussion.json")["entries"]), 1)
        moved = read_json(stray / cloudsync.MOVED)
        self.assertEqual(moved["to_rel"], "../../EasyRead")
        sync.pull_once(self.canon)                                                          # 併過來的筆記這台看得到
        self.assertEqual(Workspace(both).load("reader")["notes"]["n1"]["body"], "另一台在舊資料夾寫的")
        self.assertEqual(Workspace(self.canon / "onlythere").load("reader")["notes"]["n9"]["body"], "舊格式的筆記")
        self.assertIsNone(cloudsync.report(self.canon)["advice"])                           # 留了路標的不再提
        cloudsync.absorb(self.canon, stray)                                                 # 再做一次也不會重複
        self.assertEqual(len(read_json(both / "chat.json")["threads"]), 2)

    def test_absorb_the_drive_root_that_contains_the_library(self):
        cloudsync.ensure_marker(self.canon)
        paper(self.canon, "p1")
        paper(self.drive, "rootpaper")
        done = cloudsync.absorb(self.canon, self.drive)
        self.assertEqual(done["copied"], ["rootpaper"])
        self.assertEqual(read_json(self.drive / cloudsync.MOVED)["to_rel"], "EasyRead")
        self.assertEqual(sorted(cloudsync.paper_ids(self.canon)), ["p1", "rootpaper"])

    def test_the_other_computer_follows_the_signpost_on_startup(self):
        cloudsync.ensure_marker(self.canon)
        paper(self.canon, "p1")
        paper(self.drive, "rootpaper")
        cloudsync.absorb(self.canon, self.drive)
        self.use("win")
        write_json_atomic(config.CONFIG_PATH, {"library_dir": str(self.drive)})
        cfg = cloudsync.startup(config.load())
        self.assertEqual(Path(cfg["library_dir"]), self.canon)
        self.assertEqual(cloudsync._notice["kind"], "followed")
        self.assertEqual(Path(config.load()["library_dir"]), self.canon)

    def test_a_signpost_cannot_point_this_computer_at_an_arbitrary_folder(self):
        elsewhere = self.tmp / "elsewhere"
        paper(elsewhere, "x")
        cloudsync.ensure_marker(elsewhere)
        stray = self.drive / "sub" / "EasyRead"
        paper(stray, "old1")
        write_json_atomic(stray / cloudsync.MOVED, {"to_rel": os.path.relpath(elsewhere, stray), "target": "made-up|someone"})
        self.assertIsNone(cloudsync.follow_moved(stray))                                    # 身分對不上，也不是雲端硬碟根目錄下的 EasyRead
        write_json_atomic(stray / cloudsync.MOVED, {"to_rel": "../../EasyRead", "target": "made-up|someone"})
        self.assertIsNone(cloudsync.follow_moved(stray))                                    # 約定的資料夾裡還沒有論文：不跟
        paper(self.canon, "p1")
        self.assertEqual(cloudsync.follow_moved(stray), self.canon)                         # 約定的那個資料夾可以跟

    def test_join_moves_this_computers_papers_into_the_agreed_folder(self):
        cloudsync.ensure_marker(self.canon)
        paper(self.canon, "p1")
        self.use("win")
        mine = paper(self.drive, "rootpaper")
        journal(mine, "devwin", note("n1", "這台在根目錄寫的"))
        write_json_atomic(config.CONFIG_PATH, {"library_dir": str(self.drive)})
        with self.assertRaises(ValueError):
            cloudsync.join(self.drive, str(self.tmp / "not-the-library"))                    # 只接受探測到的那一個
        result = cloudsync.join(self.drive, str(self.canon))
        self.assertTrue(result["ok"]); self.assertEqual(result["copied"], 1)
        self.assertEqual(Path(config.load()["library_dir"]), self.canon)
        self.assertTrue((self.canon / "rootpaper" / "sync" / "devwin.jsonl").is_file())
        self.assertEqual(read_json(self.drive / cloudsync.MOVED)["to_rel"], "EasyRead")


class DevicesTest(Base):
    def test_each_computer_writes_its_own_heartbeat_and_confirms_the_others(self):
        paper(self.canon, "p1")
        cloudsync.beat(self.canon)
        self.use("win")
        cloudsync.tick(self.canon)                         # win 看到 mac 的心跳、寫自己的（裡面記著「我看到 mac 的第幾次」）
        devs = {d["id"]: d for d in cloudsync.devices(self.canon)}
        self.assertEqual((devs["devwin"]["state"], devs["devmac"]["state"]), ("me", "waiting"))  # mac 在線，但還沒確認它收到這台的
        self.assertEqual(sorted(p.name for p in (self.canon / cloudsync.DEVICES).iterdir()), ["devmac.json", "devwin.json"])
        self.use("mac")
        devs = {d["id"]: d for d in cloudsync.devices(self.canon)}
        self.assertEqual(devs["devwin"]["state"], "ok")    # win 的心跳裡有「看到 mac」：對 mac 來說來回都通
        self.assertEqual(devs["devwin"]["name"], "PC")
        self.assertFalse((self.canon / ".easyread-lock.json").exists())

    def test_old_versions_show_up_by_their_journals_with_the_real_last_write_time(self):
        p = paper(self.canon, "p1")
        journal(p, "devold", note("n1", "x"), t="2026-10-05T22:26:00+08:00")
        devs = {d["id"]: d for d in cloudsync.devices(self.canon)}
        self.assertTrue(devs["devold"]["legacy"])
        self.assertEqual(devs["devold"]["state"], "away")
        self.assertTrue(devs["devold"]["at"].startswith("2026-10-05T22:26") or "2026-10-05" in devs["devold"]["at"])
        self.assertEqual(devs["devmac"]["name"], "MacBook")  # 這台自己不算舊版


class SwitchAndCacheTest(Base):
    def test_changing_library_resets_read_positions_and_publishes_local_notes(self):
        old = self.drive / "sub" / "EasyRead"
        p_old = paper(old, "p1")
        Workspace(p_old).apply_reader_ops([note("mine", "這台在舊資料夾寫的")], client="c")
        journal(p_old, "devwin", note("w1", "win 舊的"), note("w2", "win 舊的 2"))
        sync.pull_once(old)
        p_new = paper(self.canon, "p1")
        journal(p_new, "devwin", note("w9", "新資料夾裡 win 寫的"))   # 比舊資料夾那份短：照舊的位置讀會漏掉
        sync.pull_once(self.canon)
        notes = Workspace(p_new).load("reader")["notes"]
        self.assertIn("w9", notes)
        self.assertIn("這台在舊資料夾寫的", (p_new / "sync" / "devmac.jsonl").read_text(encoding="utf-8"))  # 這台的筆記寫了一份快照給別台

    def test_lost_cache_is_rebuilt_from_all_journals_including_this_computers_own(self):
        p = paper(self.canon, "p1")
        Workspace(p).apply_reader_ops([note("mine", "這台寫的")], client="c")
        journal(p, "devwin", note("w1", "另一台寫的"))
        sync.pull_once(self.canon)
        shutil.rmtree(config.CACHE_DIR / "p1")                     # 快取被清掉（讀到哪的記錄還在）
        sync.pull_once(self.canon)
        notes = Workspace(p).load("reader")["notes"]
        self.assertEqual(sorted(notes), ["mine", "w1"])

    def test_write_lock_stays_out_of_the_cloud_folder(self):
        p = paper(self.canon, "p1")
        self.assertEqual(paths.lock_dir(p), config.CACHE_DIR / "p1")
        with mock.patch.dict(os.environ, {"EASYREAD_SYNC": "0"}):
            paths.forget()
            self.assertEqual(paths.lock_dir(p), p)


class DeriveTest(Base):
    def test_a_paper_imported_elsewhere_gets_its_pages_and_text_on_this_computer(self):
        p = paper(self.canon, "p1", pages=3)
        self.assertTrue(derive.missing(p))
        self.assertEqual(derive.page_of("pages/page-002.webp"), 2)
        img = derive.page_image(p, 2)
        self.assertTrue(img.is_file()); self.assertEqual(img.parent, config.CACHE_DIR / "p1" / "pages")
        self.assertIsNone(derive.page_image(p, 9))
        out = derive.extract(p)
        self.assertEqual(sorted(f.name for f in out.glob("*.txt")), ["page-001.txt", "page-002.txt", "page-003.txt"])
        self.assertFalse((p / "pages").exists()); self.assertFalse((p / "extract").exists())  # 不寫進雲端資料夾
        derive.ensure(p)
        for _ in range(100):
            if not derive.missing(p):
                break
            import time
            time.sleep(0.05)
        self.assertFalse(derive.missing(p))


if __name__ == "__main__":
    unittest.main()
