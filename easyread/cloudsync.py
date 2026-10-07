"""雲端同步裡「誰在用哪個資料夾」這件事：裝置名冊、找出雲端硬碟裡所有的 EasyRead 文獻庫、把走散的合併回來、搬家後留路標。

為什麼需要：筆記怎麼合併（sync.py）做對了也沒用，如果兩台電腦根本指著不同的資料夾——而這件事以前從畫面上完全看不出來。
實際發生過：一台用「我的雲端硬碟/EasyRead」，另一台用「我的雲端硬碟」根目錄，還有一份舊的在「我的雲端硬碟/我的雲端硬碟/EasyRead」。

- 約定：一個雲端硬碟只有一個文獻庫，固定在根目錄下的 EasyRead（cloudlib_detect 負責找到根目錄）。
- 裝置名冊：每台電腦在文獻庫的 .easyread-devices/<裝置 id>.json 寫自己的心跳（名字、系統、版本、它看到的路徑、時間），
  一台只寫自己那個檔，雲端硬碟不會有衝突副本。心跳裡還記著「我看到別台的第幾次心跳」，所以每台都能確認對方真的收到了自己的更新（來回都通）。
- 探測：libraries(root) 列出根目錄底下所有的文獻庫（根目錄本身、EasyRead、下一層資料夾裡的 EasyRead）。
  report() 把現況整理給頁面，並給一個建議動作：這台用本機資料夾而雲端已經有文獻庫 → 改用它；雲端裡還有別的文獻庫 → 合併進來。
- 合併 absorb()：把走散的那份裡沒有的論文複製過來（核對過才算），兩邊都有的把筆記日誌、對話、AI 回答、貼圖併起來；原資料夾不刪，
  只留一個路標 .easyread-moved.json。還指著舊資料夾的電腦下次啟動看到路標會自己跟過來（follow_moved）。
"""
from __future__ import annotations

import os
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from . import VERSION, config, paths
from .i18n import tr
from .log import log
from .store import now_iso, read_json, write_json_atomic

DEVICES = ".easyread-devices"
MOVED = ".easyread-moved.json"
NAME = "EasyRead"
BEAT_EVERY = 120.0   # 多久寫一次自己的心跳
RECENT = 10 * 60     # 幾秒內有動靜算「在線」
_lock = threading.Lock()
_seq = int(time.time())
_last_beat = 0.0
_saw: dict[str, dict] = {}     # 我看到別台最新的心跳 {id: {"seq", "at"}}，寫進自己的心跳讓對方確認
_roots: tuple[float, list] = (0.0, [])
_notice: dict | None = None    # 啟動時自動跟著路標換了文獻庫：給頁面顯示一次


def _read(path: Path) -> dict:
    try:
        data = read_json(path, {})
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _ts(iso) -> float:
    try:
        return datetime.fromisoformat(str(iso)).timestamp()
    except (TypeError, ValueError):
        return 0.0


def paper_ids(root: Path) -> list[str]:
    """這個資料夾裡的論文（子資料夾裡有 item.json 或 paper.json）。"""
    try:
        return sorted(p.name for p in Path(root).iterdir()
                      if p.is_dir() and not p.name.startswith(".") and ((p / "item.json").is_file() or (p / "paper.json").is_file()))
    except OSError:
        return []


# ---------- 雲端硬碟根目錄 ----------
def roots(fresh: bool = False) -> list[dict]:
    """這台電腦上找得到的雲端硬碟根目錄 [{id, label, root}]（一分鐘內不重找：Windows 要試每個磁碟機代號）。"""
    global _roots
    at, cached = _roots
    if not fresh and time.time() - at < 60:
        return cached
    from .cloudlib_detect import detect
    try:
        found = [{"id": f["id"], "label": f["label"], "root": f["root_path"]} for f in detect()]
    except Exception:  # noqa: BLE001
        log.exception("找雲端硬碟根目錄失敗")
        found = []
    _roots = (time.time(), found)
    return found


def drive_of(path: Path) -> dict | None:
    """這個路徑在哪個雲端硬碟裡（沒有回 None）。"""
    try:
        p = Path(path).resolve()
    except OSError:
        return None
    for r in roots():
        root = Path(r["root"])
        if p == root or p.is_relative_to(root):
            return r
    return None


def fingerprint(lib: Path) -> str:
    """文獻庫的身分：同步標記裡的建立時間和建立者（同一個資料夾在每台電腦上路徑不同，這個不變）。"""
    m = _read(Path(lib) / paths.MARKER)
    return f"{m.get('created', '')}|{m.get('by', '')}" if m.get("created") else ""


def ensure_marker(lib: Path) -> None:
    marker = Path(lib) / paths.MARKER
    if marker.is_file():
        return
    try:
        marker.write_text('{"created": "%s", "by": "%s"}' % (now_iso(), paths.device()["name"].replace('"', "")), encoding="utf-8")
    except OSError:
        pass


# ---------- 裝置名冊 ----------
def beat(lib_root: Path) -> None:
    """寫這台電腦的心跳。"""
    global _seq, _last_beat
    me = paths.device()
    d = Path(lib_root) / DEVICES
    with _lock:
        _seq += 1
        data = {"id": me["id"], "name": me["name"], "platform": sys.platform, "version": VERSION, "at": now_iso(), "seq": _seq,
                "papers": len(paper_ids(lib_root)), "path": str(lib_root), "saw": dict(_saw)}
        _last_beat = time.time()
    try:
        d.mkdir(exist_ok=True)
        write_json_atomic(d / f"{me['id']}.json", data)
    except OSError:
        log.warning("寫裝置心跳失敗 %s", d, exc_info=True)


def devices(lib_root: Path, note: bool = False) -> list[dict]:
    """用過這個文獻庫的電腦，最近有動靜的在前。note=True 時記下看到別台的第幾次心跳（下次寫自己的心跳時帶上）。
    每台：{id, name, platform, version, at, me, state, acked_at, path, legacy}
    state：me（這台）／ok（最近在線，而且它確認收到過這台的更新）／waiting（在線，還沒確認）／away（一陣子沒出現）。"""
    lib_root = Path(lib_root)
    me = paths.device()["id"]
    now = time.time()
    out: dict[str, dict] = {}
    try:
        files = sorted((lib_root / DEVICES).glob("*.json"))
    except OSError:
        files = []
    for f in files:
        d = _read(f)
        did = str(d.get("id") or f.stem)
        ack = (d.get("saw") or {}).get(me) or {}
        seen = _ts(d.get("at"))
        if did == me:
            state = "me"
        elif now - seen < RECENT:
            state = "ok" if ack and now - _ts(ack.get("at")) < RECENT * 2 else "waiting"
        else:
            state = "away"
        out[did] = {"id": did, "name": str(d.get("name") or did), "platform": str(d.get("platform") or ""), "version": str(d.get("version") or ""),
                    "at": str(d.get("at") or ""), "me": did == me, "state": state, "acked_at": str(ack.get("at") or ""),
                    "path": str(d.get("path") or ""), "papers": int(d.get("papers") or 0)}
        if note and did != me and d.get("seq") is not None:
            with _lock:
                if (_saw.get(did) or {}).get("seq") != d["seq"]:
                    _saw[did] = {"seq": d["seq"], "at": now_iso()}
    # 還沒有名冊的舊版：從各篇的筆記日誌檔名認出來（只知道 id 和最後寫入時間）
    try:
        for p in lib_root.iterdir():
            if not p.is_dir() or p.name.startswith("."):
                continue
            sd = p / "sync"
            if not sd.is_dir():
                continue
            for j in sd.glob("*.jsonl"):
                did = j.stem
                if did in ("merged",):
                    continue
                if did in out and not out[did].get("legacy"):
                    continue
                mt = _last_written(j)  # 日誌最後一批的時間（檔案的修改時間不準：合併、雲端硬碟下載都會改到）
                if not mt:
                    continue
                cur = out.get(did)
                if cur is None and did == me:  # 這台自己（還沒寫過心跳）：名字是知道的
                    dev = paths.device()
                    out[did] = {"id": did, "name": dev["name"], "platform": sys.platform, "version": VERSION, "at": _iso(mt), "me": True,
                                "state": "me", "acked_at": "", "path": str(lib_root), "papers": 0}
                elif cur is None:
                    out[did] = {"id": did, "name": did, "platform": "", "version": "", "at": _iso(mt), "me": False,
                                "state": "away" if now - mt > RECENT else "waiting", "acked_at": "", "path": "", "papers": 0, "legacy": True}
                elif cur.get("legacy") and mt > _ts(cur["at"]):
                    cur["at"] = _iso(mt)
    except OSError:
        pass
    if me not in out:
        dev = paths.device()
        out[me] = {"id": me, "name": dev["name"], "platform": sys.platform, "version": VERSION, "at": "", "me": True, "state": "me", "acked_at": "", "path": str(lib_root), "papers": 0}
    return sorted(out.values(), key=lambda d: (not d["me"], -_ts(d["at"])))


def _last_written(journal: Path) -> float:
    """筆記日誌最後一行記的時間。"""
    import json
    try:
        with open(journal, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", errors="replace").strip().splitlines()
        if not tail:
            return 0.0
        line = tail[-1]
        if size > 8192 and len(tail) == 1:  # 最後一行比 8 KB 長（整份快照）：讀不到開頭的時間，退回檔案時間
            return journal.stat().st_mtime
        return _ts(json.loads(line).get("t")) or journal.stat().st_mtime
    except (OSError, ValueError):
        try:
            return journal.stat().st_mtime
        except OSError:
            return 0.0


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


_ack_due = False  # 看到別台新的心跳了，還沒把「我看到了」寫回去


def tick(lib_root: Path) -> None:
    """背景執行緒定時叫（sync.Puller）：看看別台的心跳；到時間了、或看到別台新的心跳（要回報「我看到了」），就寫自己的。
    回報不馬上寫，至少隔 20 秒：雲端硬碟每寫一次就要上傳一次。"""
    global _ack_due
    before = {k: v.get("seq") for k, v in _saw.items()}
    devices(lib_root, note=True)
    if any(v.get("seq") != before.get(k) for k, v in _saw.items()):
        _ack_due = True
    since = time.time() - _last_beat
    if since > BEAT_EVERY or (_ack_due and since > 20):
        _ack_due = False
        beat(lib_root)


# ---------- 找出雲端硬碟裡所有的文獻庫 ----------
def libraries(root: Path) -> list[dict]:
    """這個雲端硬碟根目錄底下的 EasyRead 文獻庫：EasyRead、根目錄本身（論文資料夾直接散在根目錄）、下一層資料夾裡的 EasyRead。"""
    root = Path(root)
    cands = [root / NAME, root]
    try:
        for child in sorted(root.iterdir())[:400]:
            if child.name.startswith(".") or child.name.casefold() == NAME.casefold() or not child.is_dir():
                continue
            c = child / NAME
            if c.is_dir():
                cands.append(c)
    except OSError:
        pass
    out = []
    for c in cands:
        ids = paper_ids(c)
        moved = _read(c / MOVED)
        if not ids and not moved:
            continue
        devs = [d for d in devices(c) if d.get("at")]
        marker = _read(c / paths.MARKER)
        names = [d["name"] for d in devs if not d.get("legacy")] or ([marker["by"]] if marker.get("by") else [])
        out.append({"path": str(c), "rel": c.relative_to(root).as_posix() if c != root else "", "ids": ids, "count": len(ids),
                    "moved": bool(moved), "devices": names, "last_at": max((d["at"] for d in devs), default="") or str(marker.get("created") or "")})
    return out


def report(lib_root: Path, pull: dict | None = None) -> dict:
    """給頁面的現況：這個文獻庫在不在雲端、哪些電腦在用、雲端硬碟裡還有沒有別的文獻庫，以及一個建議動作（advice，沒有就 None）。"""
    lib_root = Path(lib_root)
    synced = paths.is_synced(lib_root)
    drive = drive_of(lib_root)
    mine = set(paper_ids(lib_root))
    out = {"enabled": synced, "device": paths.device(), "path": str(lib_root), "papers": len(mine),
           "drive": {"label": drive["label"], "root": drive["root"]} if drive else None,
           "canonical": bool(drive and lib_root == Path(drive["root"]) / NAME),
           "devices": devices(lib_root) if synced else [], "others": [], "advice": None, "notice": _notice}
    for k in ("applied", "last_remote_at", "last_pull_at", "last_from", "conflicts"):  # 合併別台筆記的情況（sync.status()）
        out[k] = (pull or {}).get(k, [] if k == "conflicts" else 0 if k == "applied" else "")
    found = []
    for r in roots():
        if drive and r["root"] != drive["root"]:
            continue  # 文獻庫在某個雲端硬碟裡：只看同一個硬碟（別的雲端硬碟裡的文獻庫可能是刻意分開的）
        for lib in libraries(Path(r["root"])):
            if Path(lib["path"]) == lib_root:
                continue
            lib["drive"] = r["label"]
            lib["new"] = [i for i in lib["ids"] if i not in mine]
            # 已經併過、留了路標的不再提——除非之後又有電腦（還沒更新的舊版）往那裡加了這裡沒有的論文
            if lib["moved"] and not (synced and lib["new"]):
                continue
            found.append(lib)
    out["others"] = [{k: v for k, v in lib.items() if k != "ids"} for lib in found]
    if config.temp_library():
        return out
    canon = [lib for lib in found if lib["rel"] == NAME]
    if not drive:  # 這台用本機資料夾
        best = (canon or sorted(found, key=lambda x: -x["count"]))[:1]
        if best:
            out["advice"] = {"kind": "join", "path": best[0]["path"], "count": best[0]["count"], "devices": best[0]["devices"], "label": best[0]["drive"],
                             "mode": "merge" if mine else "use", "mine": len(mine)}
        elif roots():
            r = roots()[0]
            out["advice"] = {"kind": "start", "path": str(Path(r["root"]) / NAME), "label": r["label"], "mine": len(mine)}
    elif not out["canonical"] and canon:  # 這台在雲端，但不是約定的那個資料夾，而約定的那個已經有人在用
        out["advice"] = {"kind": "join", "path": canon[0]["path"], "count": canon[0]["count"], "devices": canon[0]["devices"], "label": canon[0]["drive"],
                         "mode": "merge" if mine else "use", "mine": len(mine), "split": True}
    elif found:  # 這台用的是對的，雲端硬碟裡還有別的文獻庫
        out["advice"] = {"kind": "absorb", "paths": [lib["path"] for lib in found], "count": sum(lib["count"] for lib in found),
                         "new": len({i for lib in found for i in lib["new"]}), "devices": sorted({n for lib in found for n in lib["devices"]})}
    return out


# ---------- 合併走散的文獻庫 ----------
def _union_lines(src: Path, dst: Path) -> int:
    """把 src 裡 dst 沒有的行接到 dst 後面（筆記日誌：每行一批操作，重複套用無妨，所以聯集就對了）。"""
    have = set(dst.read_text(encoding="utf-8", errors="replace").splitlines()) if dst.exists() else set()
    add = [l for l in src.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip() and l not in have]
    if add:
        with open(dst, "a", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(add) + "\n")
    return len(add)


def _merge_list(src: Path, dst: Path, key: str) -> int:
    """chat.json 的 threads、discussion.json 的 entries：以 id 聯集；兩邊都有的留較新的。"""
    a, b = _read(src), _read(dst)
    if not a.get(key):
        return 0
    stamp = lambda x: str(x.get("updated") or x.get("at") or "")  # noqa: E731
    by_id = {str(x.get("id")): x for x in b.get(key) or [] if isinstance(x, dict)}
    changed = 0
    for x in a.get(key) or []:
        if not isinstance(x, dict) or x.get("id") is None:
            continue
        cur = by_id.get(str(x["id"]))
        if cur is None or stamp(x) > stamp(cur):
            by_id[str(x["id"])] = x
            changed += 1
    if changed:
        order = [str(x.get("id")) for x in b.get(key) or [] if isinstance(x, dict)]
        order += [k for k in by_id if k not in order]
        b[key] = [by_id[k] for k in order]
        write_json_atomic(dst, b)
    return changed


def _legacy_reader(folder: Path, dst_paper: Path) -> None:
    """非同步模式的文獻庫，筆記存在論文資料夾裡的 reader.json：轉成一筆快照寫進日誌（sync/merged.jsonl），每台都會合併進去。"""
    legacy = Path(folder) / "reader.json"
    data = _read(legacy)
    if not data or not any(data.get(k) for k in ("notes", "page_notes", "paper_note", "edits")):
        return
    import json
    sd = Path(dst_paper) / "sync"
    sd.mkdir(exist_ok=True)
    with open(sd / "merged.jsonl", "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"t": now_iso(), "ops": [{"op": "snapshot", "reader": data, "at": now_iso()}]}, ensure_ascii=False) + "\n")


def merge_paper(src: Path, dst: Path) -> None:
    """兩邊都有的同一篇：dst 的內容為主，把 src 多出來的筆記日誌、對話、AI 回答、貼圖和截圖併進來。"""
    src, dst = Path(src), Path(dst)
    if (src / "sync").is_dir():
        (dst / "sync").mkdir(exist_ok=True)
        for j in (src / "sync").glob("*.jsonl"):
            _union_lines(j, dst / "sync" / j.name)
    _legacy_reader(src, dst)
    for name in ("clips", "figures"):
        if (src / name).is_dir():
            (dst / name).mkdir(exist_ok=True)
            for f in (src / name).iterdir():
                if f.is_file() and not (dst / name / f.name).exists():
                    shutil.copy2(f, dst / name / f.name)
    _merge_list(src / "chat.json", dst / "chat.json", "threads")
    _merge_list(src / "discussion.json", dst / "discussion.json", "entries")


def absorb(current: Path, stray: Path) -> dict:
    """把 stray 這個走散的文獻庫併進 current：沒有的論文整篇複製（核對大小），都有的併筆記。stray 不刪，留路標。"""
    from . import cloudlib
    current, stray = Path(current).resolve(), Path(stray).resolve()
    if current == stray:
        raise ValueError(tr("新旧文献库不能相同，也不能互相包含"))
    ids = paper_ids(stray)
    copied, merged = [], []
    for pid in ids:
        src, dst = stray / pid, current / pid
        if dst.exists():
            merge_paper(src, dst)
            merged.append(pid)
            continue
        staging = current / f"{cloudlib.STAGING_PREFIX}{uuid.uuid4().hex}"
        staging.mkdir()
        try:
            cloudlib._copy_verified(src, staging / pid)
            (staging / pid / ".write.lock").unlink(missing_ok=True)
            for name in paths.DERIVED:  # 頁面圖、抽取文字、本機的修改記錄：可以重算，不放進雲端的文獻庫
                shutil.rmtree(staging / pid / name, ignore_errors=True)
            _legacy_reader(staging / pid, staging / pid)
            (staging / pid / "reader.json").unlink(missing_ok=True)  # 已經轉成日誌裡的快照
            (staging / pid).rename(dst)
            copied.append(pid)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    ensure_marker(current)
    mark_moved(stray, current, ids)
    log.info("合併文獻庫 %s → %s：複製 %d 篇，合併 %d 篇", stray, current, len(copied), len(merged))
    return {"from": str(stray), "copied": copied, "merged": merged}


def join(current: Path, target: str) -> dict:
    """這台改用 target 這個雲端文獻庫（只接受探測到的那一個，不是任意路徑）。回傳和 cloudlib.move 一樣的形狀；設定已經改好，重啟後生效。"""
    from . import cloudlib
    current = Path(current).resolve()
    advice = report(current).get("advice") or {}
    if advice.get("kind") != "join" or not target or Path(target).resolve() != Path(advice["path"]).resolve():
        raise ValueError(tr("沒有可以改用的雲端文獻庫"))
    dst = Path(advice["path"]).resolve()
    if advice.get("split"):  # 這台在同一個雲端硬碟的別的資料夾裡（可能就是根目錄，包著 EasyRead）：把這台的併過去，舊的留路標
        done = absorb(dst, current)
        config.save({"library_dir": str(dst)})
        paths.forget()
        return {"ok": True, "path": str(dst), "old_path": str(current), "copied": len(done["copied"]), "merged": len(done["merged"]), "skipped": [],
                "restart_required": True, "message": tr("文献库位置已更改，需要重启 EasyRead 才能生效")}
    result = cloudlib.move(current, dst, advice["mode"])
    after_move(result, advice["mode"])
    return result


def after_move(result: dict, mode: str) -> None:
    """設定裡換了文獻庫位置（cloudlib.move）之後的整理。mode：copy（整份搬到空資料夾）／merge（把這台的併進已有的）／use（直接改用那邊的）。"""
    old, new = Path(result.get("old_path") or ""), Path(result.get("path") or "")
    if not result.get("ok") or not old.is_dir() or not new.is_dir():
        return
    paths.forget()
    in_cloud = bool(drive_of(new)) or paths.is_synced(new)
    if in_cloud:
        ensure_marker(new)
    if mode == "merge":  # 同一篇兩邊都有的，cloudlib 只是跳過：把這台那份的筆記、對話併過去
        for pid in paper_ids(old):
            if (new / pid).is_dir() and (old / pid).resolve() != (new / pid).resolve():
                try:
                    merge_paper(old / pid, new / pid)
                except OSError:
                    log.warning("合併 %s 的筆記失敗", pid, exc_info=True)
    if mode in ("copy", "merge") and (drive_of(old) or paths.is_synced(old)):
        mark_moved(old, new, paper_ids(old))


def mark_moved(old: Path, new: Path, ids: list[str] | None = None) -> None:
    """在舊資料夾留路標：這個文獻庫已經併到／搬到 new。用相對路徑（同一個雲端硬碟在每台電腦上的絕對路徑不同）。"""
    old, new = Path(old).resolve(), Path(new).resolve()
    try:
        rel = Path(os.path.relpath(new, old)).as_posix()
        write_json_atomic(old / MOVED, {"to_rel": rel, "target": fingerprint(new), "at": now_iso(), "by": paths.device()["name"], "papers": ids or []})
    except (OSError, ValueError):
        log.warning("留路標失敗 %s", old, exc_info=True)


def follow_moved(lib_root: Path) -> Path | None:
    """文獻庫資料夾裡有路標（別台電腦把它併到別處了）：回傳新的位置；沒有、或對不上就回 None。"""
    cur = Path(lib_root)
    seen = {str(cur)}
    found = None
    for _ in range(4):
        m = _read(cur / MOVED)
        if not m.get("to_rel"):
            break
        try:
            target = (cur / str(m["to_rel"])).resolve()
        except OSError:
            break
        # 只跟到「身分對得上」的文獻庫（或這台認得的雲端硬碟根目錄下的 EasyRead）：路標是同步過來的檔案，不能讓它把這台指到任意地方
        if str(target) in seen or not target.is_dir():
            break
        known = bool(m.get("target")) and fingerprint(target) == m["target"]
        canonical = any(target == Path(r["root"]) / NAME for r in roots()) and bool(paper_ids(target))
        if not (known or canonical):
            break
        seen.add(str(target))
        found = cur = target
    return found


def _wait_for(lib: Path, seconds: float = 25.0) -> None:
    """開機時雲端硬碟的磁碟機（Windows 的 G:）可能比 EasyRead 晚幾秒出現：文獻庫的上層資料夾還不在就等一下，
    不然會被當成「資料夾不見了」。上層在、只是文獻庫資料夾還沒建，不用等。"""
    try:
        if lib.exists() or lib.parent.exists():
            return
    except OSError:
        pass
    deadline = time.time() + seconds
    log.info("文獻庫所在的磁碟還沒出現，等一下：%s", lib)
    while time.time() < deadline:
        time.sleep(1)
        try:
            if lib.parent.exists():
                return
        except OSError:
            continue


def startup(cfg: dict) -> dict:
    """啟動時（建 App 之前）叫：文獻庫被併到別處了就自動換過去，記下來給頁面說一聲。回傳（可能更新過的）設定。"""
    global _notice
    if config.temp_library():
        return cfg
    try:
        old = Path(cfg["library_dir"])
        _wait_for(old)
        new = follow_moved(old)
    except Exception:  # noqa: BLE001
        log.exception("檢查文獻庫路標失敗")
        return cfg
    if not new:
        return cfg
    config.save({"library_dir": str(new)})
    paths.forget()
    _notice = {"kind": "followed", "from": str(old), "to": str(new)}
    log.info("文獻庫已經併到 %s，自動換過去（原本 %s）", new, old)
    return config.load()
