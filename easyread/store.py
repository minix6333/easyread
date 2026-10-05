"""文件读写：原子写、跨进程锁、用户修改的合并规则。

一篇论文一个目录，文件按“谁写”分开，这是互不覆盖的根本保证：
  paper.json       翻译方（对话里的 agent 或后台翻译任务）写：原文、译文、术语、参考文献
  discussion.json  翻译方写：解释、问答、回复、原文核对提示
  reader.json      只由页面经 /api/.../ops 写：用户改的译文、笔记、划线、论文笔记、进度
  item.json        只由页面经 /api/items 写：标签、阅读状态、星标、打开时间
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import paths

SCHEMA = 2


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json_atomic(path: Path, data) -> None:
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows：别的进程正在读，稍等重试
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


@contextmanager
def dir_lock(folder: Path, name: str = ".write.lock", timeout: float = 15.0):
    """O_EXCL 建锁文件做跨进程互斥；超过 30 秒的旧锁视为残留。"""
    lock = Path(folder) / name
    start = time.time()
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 30:
                    lock.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.time() - start > timeout:
                from .i18n import tr
                raise TimeoutError(tr("等锁超时：{lock}", lock=lock))
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def text_hash(s: str | None) -> str:
    """和页面 util.js 的 hashText 一致：FNV-1a 32 位，按 UTF-16 码元。"""
    h = 0x811C9DC5
    b = (s or "").encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def file_version(path: Path) -> str:
    try:
        st = Path(path).stat()
        return f"{st.st_mtime_ns:x}-{st.st_size:x}"
    except FileNotFoundError:
        return "0"


def empty_reader() -> dict:
    return {"schema": SCHEMA, "rev": 0, "edits": {}, "notes": {}, "paper_note": {}, "page_notes": {}, "progress": {}}


def empty_discussion() -> dict:
    return {"schema": SCHEMA, "entries": []}


def snapshot_ops(reader: dict) -> list[dict]:
    """整份 reader.json → 等價的一串操作（給 snapshot 合併用）。"""
    ops: list[dict] = []
    for nid, n in (reader.get("notes") or {}).items():
        if isinstance(n, dict):
            ops.append({"op": "note", "note": {**n, "id": nid}, "at": n.get("updated")})
    for block, e in (reader.get("edits") or {}).items():
        if isinstance(e, dict) and e.get("at"):
            ops.append({"op": "edit", "block": block, "zh": None if e.get("reverted") else e.get("zh"), "base": e.get("base", ""), "at": e["at"]})
    pn = reader.get("paper_note") or {}
    if pn.get("at"):
        ops.append({"op": "paper_note", "body": pn.get("body", ""), "at": pn["at"]})
    for page, p in (reader.get("page_notes") or {}).items():
        if isinstance(p, dict) and p.get("at"):
            ops.append({"op": "page_note", "page": page, "body": p.get("body", ""), "star": bool(p.get("star")), "at": p["at"]})
    pr = reader.get("progress") or {}
    if pr.get("at"):
        ops.append({"op": "progress", "block": pr.get("block"), "ratio": pr.get("ratio"), "page": pr.get("page"), "at": pr["at"]})
    return ops


# ---------- reader.json 的操作合并 ----------
# 每个操作幂等、带时间戳；同一对象以较新的为准。页面断网时操作留在浏览器，恢复后重发不会重复或倒退。

def _newer(a: str | None, b: str | None) -> bool:
    return (a or "") >= (b or "")


def apply_ops(reader: dict, ops: list[dict]) -> list[str]:
    applied = []
    edits = reader.setdefault("edits", {})
    notes = reader.setdefault("notes", {})
    progress = reader.setdefault("progress", {})
    for op in ops:
        kind = op.get("op")
        at = op.get("at") or now_iso()
        if kind == "edit":
            block = str(op["block"])
            cur = edits.get(block)
            if cur and not _newer(at, cur.get("at")):
                continue
            if op.get("zh") is None:  # 恢复译者稿：留一条撤销记录
                if cur:
                    edits[block] = {"reverted": True, "prev": cur.get("zh"), "at": at}
            else:
                entry = {"zh": op["zh"], "base": op.get("base", ""), "at": at}
                if cur and cur.get("zh") and cur.get("zh") != op["zh"]:
                    entry["prev"] = cur.get("zh")
                edits[block] = entry
            applied.append(f"edit:{block}")
        elif kind == "note":
            note = dict(op["note"])
            nid = str(note["id"])
            cur = notes.get(nid)
            if cur and not _newer(note.get("updated"), cur.get("updated")):
                continue
            notes[nid] = note
            applied.append(f"note:{nid}")
        elif kind == "note_del":
            nid = str(op["id"])
            cur = notes.get(nid)
            if not cur or _newer(at, cur.get("updated")):
                notes[nid] = {**(cur or {"id": nid}), "deleted": True, "updated": at}
                applied.append(f"note_del:{nid}")
        elif kind == "paper_note":
            cur = reader.get("paper_note") or {}
            if _newer(at, cur.get("at")):
                reader["paper_note"] = {"body": op.get("body", ""), "at": at}
                applied.append("paper_note")
        elif kind == "page_note":  # 每一頁自己的筆記（上課筆記）：鍵是頁碼
            page = str(op.get("page") or "")
            if not page.isdigit():
                continue
            by_page = reader.setdefault("page_notes", {})
            cur = by_page.get(page) or {}
            if _newer(at, cur.get("at")):
                by_page[page] = {"body": op.get("body", ""), "at": at}
                if op.get("star"):  # 標成重點的頁（老師說會考、要回頭複習）
                    by_page[page]["star"] = True
                applied.append(f"page_note:{page}")
        elif kind == "progress":
            if _newer(at, progress.get("at")):
                progress.update({"block": op.get("block"), "at": at})
                if op.get("ratio") is not None:
                    progress["ratio"] = op["ratio"]
                if op.get("page") is not None:  # PDF 優先版面記的頁碼
                    progress["page"] = op["page"]
            applied.append("progress")
        elif kind == "snapshot":  # 另一台電腦開始同步時把整份 reader.json 寫進日誌：拆成一條條操作合併，一樣是新的贏
            applied.extend(apply_ops(reader, snapshot_ops(op.get("reader") or {})))
            reader["rev"] = int(reader.get("rev", 0)) - 1  # 下面會再加回來
    if applied:
        reader["rev"] = int(reader.get("rev", 0)) + 1
    return applied


class Workspace:
    """一篇论文的目录。"""

    PARTS = ("paper", "discussion", "reader", "layout")

    def __init__(self, root: Path):
        self.root = Path(root).resolve()

    @property
    def id(self) -> str:
        return self.root.name

    paper_path = property(lambda s: s.root / "paper.json")
    discussion_path = property(lambda s: s.root / "discussion.json")
    reader_path = property(lambda s: paths.reader_path(s.root))  # 同步模式下在本機快取（見 paths.py）
    item_path = property(lambda s: s.root / "item.json")
    journal_path = property(lambda s: paths.derived(s.root, "history") / "reader.log.jsonl")

    def part_path(self, name: str) -> Path:
        return self.reader_path if name == "reader" else self.root / f"{name}.json"

    def load(self, name: str):
        defaults = {"reader": empty_reader(), "discussion": empty_discussion(), "layout": {}, "item": {}, "job": {}, "chat": {"messages": []}}
        return read_json(self.part_path(name), defaults.get(name))

    def versions(self) -> dict:
        v = {n: file_version(self.part_path(n)) for n in self.PARTS}
        v["job"] = file_version(self.root / "job.json")
        return v

    def apply_reader_ops(self, ops: list[dict], client: str = "", journal: bool = True) -> dict:
        """journal=False：這批是從別台電腦的日誌讀進來的（sync.py），不要再寫回自己的日誌。"""
        with dir_lock(self.root):
            reader = self.load("reader")
            applied = apply_ops(reader, ops)
            if applied:
                self._journal(ops, client)
                self._snapshot()
                write_json_atomic(self.reader_path, reader)
                if journal and paths.is_synced(self.root.parent):
                    paths.sync_append(self.root, ops)
            return {"rev": reader.get("rev", 0), "applied": applied}

    def _journal(self, ops, client):
        self.journal_path.parent.mkdir(parents=True, exist_ok=True)  # 同步模式下在本機快取，上層目錄可能還沒建
        with open(self.journal_path, "a", encoding="utf-8") as f:
            for op in ops:
                f.write(json.dumps({"t": now_iso(), "client": client, **op}, ensure_ascii=False) + "\n")

    def _snapshot(self, every_seconds: int = 600):
        """reader.json 每 10 分钟最多留一份快照，出事可以回滚。"""
        hist = paths.derived(self.root, "history")
        hist.mkdir(parents=True, exist_ok=True)
        snaps = sorted(hist.glob("reader-*.json"))
        if snaps and time.time() - snaps[-1].stat().st_mtime < every_seconds:
            return
        if self.reader_path.exists():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            (hist / f"reader-{stamp}.json").write_bytes(self.reader_path.read_bytes())

    def update(self, name: str, fn):
        """在锁内读-改-写一个翻译方的文件（paper / discussion / job / item）。"""
        with dir_lock(self.root):
            data = self.load(name)
            result = fn(data)
            write_json_atomic(self.part_path(name), data)
            return result

    def patch_item(self, fields: dict) -> dict:
        allowed = {"tags", "status", "starred", "rating", "last_opened", "meta_override", "archived"}

        def apply(item):
            for k, v in fields.items():
                if k in allowed:
                    item[k] = v
            item["updated"] = now_iso()
            return item
        return self.update("item", apply)
