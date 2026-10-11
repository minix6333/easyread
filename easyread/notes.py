"""獨立的筆記（不掛在哪一篇論文底下的，像 Craft 的文件）：文獻庫裡的 _notes/<id>/note.md 加 note.json。

- 資料夾在文獻庫裡，雲端同步的文獻庫會跟著同步（兩台同時改同一份會留衝突副本，和 chat.json 一樣）。
- paper_ids／Library.all 只認有 paper.json／item.json 的資料夾，_notes 不會被當成論文。
- 內容是 Markdown（區塊編輯器 web/js/common/blocks.js 寫的），貼進去的圖放 clips/。
"""
from __future__ import annotations

import hashlib
import re
import shutil
import time
from pathlib import Path
from uuid import uuid4

from .i18n import tr
from .store import now_iso, read_json, write_json_atomic

DIR = "_notes"
_ID = re.compile(r"[a-z0-9]{6,24}")
_CLIP = re.compile(r"[A-Za-z0-9._-]{1,80}")


def folder(lib_root: Path) -> Path:
    return Path(lib_root) / DIR


def note_dir(lib_root: Path, nid: str) -> Path | None:
    if not _ID.fullmatch(nid or ""):
        return None
    d = folder(lib_root) / nid
    return d if (d / "note.json").is_file() else None


def _meta(d: Path) -> dict:
    m = read_json(d / "note.json", {}) or {}
    m["id"] = d.name
    return m


def _body(d: Path) -> str:
    try:
        return (d / "note.md").read_text(encoding="utf-8")
    except OSError:
        return ""


def _preview(md: str) -> str:
    text = re.sub(r"^\s*#+\s*|^\s*[-*>]\s*(\[[ x]\]\s*)?|\*\*|`|\$", "", md, flags=re.M)
    return " ".join(text.split())[:140]


def listing(lib_root: Path) -> list[dict]:
    out = []
    base = folder(lib_root)
    if not base.is_dir():
        return out
    for d in base.iterdir():
        if not d.is_dir() or not (d / "note.json").is_file():
            continue
        m = _meta(d)
        body = _body(d)
        out.append({"id": d.name, "title": m.get("title") or "", "created": m.get("created") or "", "updated": m.get("updated") or "",
                    "preview": _preview(body), "chars": len(body), "papers": m.get("papers") or []})
    out.sort(key=lambda x: x["updated"], reverse=True)
    return out


def create(lib_root: Path, title: str = "", body: str = "", papers: list[str] | None = None) -> dict:
    nid = uuid4().hex[:12]
    d = folder(lib_root) / nid
    d.mkdir(parents=True, exist_ok=True)
    now = now_iso()
    meta = {"title": str(title or "")[:200], "created": now, "updated": now, "papers": [p for p in (papers or []) if isinstance(p, str)][:20]}
    (d / "note.md").write_text(str(body or ""), encoding="utf-8")
    write_json_atomic(d / "note.json", meta)
    return get(lib_root, nid)


def get(lib_root: Path, nid: str) -> dict | None:
    d = note_dir(lib_root, nid)
    if not d:
        return None
    m = _meta(d)
    return {"id": nid, "title": m.get("title") or "", "created": m.get("created") or "", "updated": m.get("updated") or "", "papers": m.get("papers") or [], "body": _body(d)}


def save(lib_root: Path, nid: str, title=None, body=None, papers=None) -> dict:
    d = note_dir(lib_root, nid)
    if not d:
        raise ValueError(tr("沒有這份筆記"))
    m = read_json(d / "note.json", {}) or {}
    if title is not None:
        m["title"] = str(title)[:200]
    if papers is not None and isinstance(papers, list):
        m["papers"] = [p for p in papers if isinstance(p, str)][:20]
    if body is not None:
        body = str(body)
        if body != _body(d):
            tmp = d / "note.md.tmp"
            tmp.write_text(body, encoding="utf-8")
            tmp.replace(d / "note.md")
    m["updated"] = now_iso()
    write_json_atomic(d / "note.json", m)
    return get(lib_root, nid)


def delete(lib_root: Path, nid: str) -> bool:
    d = note_dir(lib_root, nid)
    if not d:
        return False
    shutil.rmtree(d, ignore_errors=True)
    return True


def clip(lib_root: Path, nid: str, data: bytes, ctype: str) -> str:
    """貼進筆記的圖：存到 clips/，回「clips/檔名」（頁面用 /n/<id>/clips/檔名 取）。"""
    d = note_dir(lib_root, nid)
    if not d:
        raise ValueError(tr("沒有這份筆記"))
    if not data or len(data) > 20 * 1024 * 1024:
        raise ValueError(tr("圖片太大或是空的"))
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}.get((ctype or "").split(";")[0].strip().lower())
    if not ext:
        raise ValueError(tr("只收 PNG、JPEG、GIF、WebP"))
    (d / "clips").mkdir(exist_ok=True)
    name = f"i-{int(time.time())}-{hashlib.sha256(data).hexdigest()[:8]}.{ext}"
    (d / "clips" / name).write_bytes(data)
    return "clips/" + name


def clip_path(lib_root: Path, nid: str, name: str) -> Path | None:
    d = note_dir(lib_root, nid)
    if not d or not _CLIP.fullmatch(name or "") or ".." in name:
        return None
    p = d / "clips" / name
    return p if p.is_file() else None
