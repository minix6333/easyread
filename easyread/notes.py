"""獨立的筆記（不掛在哪一篇論文底下的，像 Craft 的文件）：文獻庫裡的 _notes/<id>/note.md 加 note.json。

- 資料夾在文獻庫裡，雲端同步的文獻庫會跟著同步（兩台同時改同一份會留衝突副本，和 chat.json 一樣）。
- paper_ids／Library.all 只認有 paper.json／item.json 的資料夾，_notes 不會被當成論文。
- 內容是 Markdown（區塊編輯器 web/js/common/blocks.js 寫的），貼進去的圖放 clips/。
- note.json 除了標題、時間、關聯的論文，還有外觀和整理用的幾個欄位（STYLE_KEYS）：
  圖示和顏色（側欄、筆記清單上那顆）、放在哪個分類、收藏、寬頁、字型。
- 刪除是挪到文獻庫的 .trash/note-<id>-<時間>（和論文同一個回收站，見 trash.py），可以復原。
"""
from __future__ import annotations

import hashlib
import re
import shutil
import time
from pathlib import Path
from uuid import uuid4

from datetime import datetime

from .i18n import tr
from .store import now_iso, read_json, write_bytes_atomic, write_json_atomic

DIR = "_notes"
_ID = re.compile(r"[a-z0-9]{6,24}")
_CLIP = re.compile(r"[A-Za-z0-9._-]{1,80}")
_SLUG = re.compile(r"[a-z0-9-]{1,32}")
FONTS = ("", "serif", "mono", "round")
# 外觀和整理用的欄位：前端傳什麼都先過這裡（別的鍵不收，值不對就當沒設）
STYLE_KEYS = ("icon", "color", "folder", "star", "wide", "font")


def _style(key: str, value):
    if key in ("icon", "color"):
        v = str(value or "").strip().lower()
        return v if _SLUG.fullmatch(v) else ""
    if key == "folder":
        return " ".join(str(value or "").split())[:30]
    if key in ("star", "wide"):
        return bool(value)
    if key == "font":
        v = str(value or "").strip().lower()
        return v if v in FONTS else ""
    return None


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
    """清單上那幾行預覽：只留看得到的字——圍欄、公式、圖片拿掉，連結留字，各種記號（#、-、>、[!note]、**、==…）去掉。"""
    text = re.sub(r"```[\s\S]*?(?:```|\Z)|\$\$[\s\S]*?(?:\$\$|\Z)", " ", md)       # 程式碼、獨立的公式整塊不要
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)                               # 圖片
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)                            # 連結留字
    text = re.sub(r"\$[^$\n]*\$", " ", text)                                        # 行內公式
    text = re.sub(r"^\s*(?:>\s?)*\s*(?:#+\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?", "", text, flags=re.M)  # 行首的記號
    text = re.sub(r"^\s*\[!\w+[^\]]*\]\s*", "", text, flags=re.M)                   # 說明框的 [!note]
    text = re.sub(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$|^\s*([-*_])(\s*\2){2,}\s*$", " ", text, flags=re.M)  # 表格的分隔列、分隔線
    text = re.sub(r"\*\*|==|~~|\+\+|`|\*|\|", " ", text)
    return " ".join(text.split())[:200]


def _summary(d: Path) -> dict:
    """清單上要的那幾樣（不含正文）。"""
    m = _meta(d)
    body = _body(d)
    out = {"id": d.name, "title": m.get("title") or "", "created": m.get("created") or "", "updated": m.get("updated") or "",
           "preview": _preview(body), "chars": len(body), "papers": m.get("papers") or []}
    for k in STYLE_KEYS:
        out[k] = _style(k, m.get(k))
    cover = re.search(r"!\[[^\]]*\]\((clips/[A-Za-z0-9._-]{1,80})\)", body)  # 第一張貼進去的圖：格子檢視當封面
    out["cover"] = cover.group(1) if cover else ""
    return out


def listing(lib_root: Path) -> list[dict]:
    out = []
    base = folder(lib_root)
    if not base.is_dir():
        return out
    for d in base.iterdir():
        if not d.is_dir() or not (d / "note.json").is_file():
            continue
        out.append(_summary(d))
    out.sort(key=lambda x: x["updated"], reverse=True)
    return out


def create(lib_root: Path, title: str = "", body: str = "", papers: list[str] | None = None, style: dict | None = None) -> dict:
    nid = uuid4().hex[:12]
    d = folder(lib_root) / nid
    d.mkdir(parents=True, exist_ok=True)
    now = now_iso()
    meta = {"title": str(title or "")[:200], "created": now, "updated": now, "papers": [p for p in (papers or []) if isinstance(p, str)][:20]}
    for k in STYLE_KEYS:
        if isinstance(style, dict) and k in style and _style(k, style[k]):
            meta[k] = _style(k, style[k])
    (d / "note.md").write_text(str(body or ""), encoding="utf-8")
    write_json_atomic(d / "note.json", meta)
    return get(lib_root, nid)


def get(lib_root: Path, nid: str) -> dict | None:
    d = note_dir(lib_root, nid)
    if not d:
        return None
    m = _meta(d)
    out = {"id": nid, "title": m.get("title") or "", "created": m.get("created") or "", "updated": m.get("updated") or "", "papers": m.get("papers") or [], "body": _body(d)}
    for k in STYLE_KEYS:
        out[k] = _style(k, m.get(k))
    return out


def save(lib_root: Path, nid: str, title=None, body=None, papers=None, style: dict | None = None) -> dict:
    """style：只改外觀／整理的欄位（圖示、顏色、分類、收藏、寬頁、字型）時不動「已更新」的時間——
    換個圖示、收藏一下不算改了內容，清單的排序（最近改的在前）才不會跟著跳。"""
    d = note_dir(lib_root, nid)
    if not d:
        raise ValueError(tr("沒有這份筆記"))
    m = read_json(d / "note.json", {}) or {}
    touched = False
    if title is not None and str(title)[:200] != (m.get("title") or ""):
        m["title"] = str(title)[:200]
        touched = True
    if papers is not None and isinstance(papers, list):
        m["papers"] = [p for p in papers if isinstance(p, str)][:20]
    if body is not None:
        body = str(body)
        if body != _body(d):
            write_bytes_atomic(d / "note.md", body.encode("utf-8"))  # 暫存檔名每次不同（同一份筆記同時存兩次才不會寫進同一個暫存檔）
            touched = True
    if isinstance(style, dict):
        for k in STYLE_KEYS:
            if k not in style:
                continue
            v = _style(k, style[k])
            if v:
                m[k] = v
            else:
                m.pop(k, None)
    if touched or not m.get("updated"):
        m["updated"] = now_iso()
    write_json_atomic(d / "note.json", m)
    return get(lib_root, nid)


def duplicate(lib_root: Path, nid: str) -> dict:
    """複製一份：內容、貼的圖、外觀都帶過去（不帶收藏），標題後面加「副本」。"""
    d = note_dir(lib_root, nid)
    if not d:
        raise ValueError(tr("沒有這份筆記"))
    m = _meta(d)
    new = uuid4().hex[:12]
    dest = folder(lib_root) / new
    dest.mkdir(parents=True, exist_ok=True)
    if (d / "clips").is_dir():
        shutil.copytree(d / "clips", dest / "clips", dirs_exist_ok=True)
    (dest / "note.md").write_text(_body(d), encoding="utf-8")
    now = now_iso()
    title = (m.get("title") or tr("未命名筆記")) + " " + tr("副本")
    meta = {"title": title[:200], "created": now, "updated": now, "papers": m.get("papers") or []}
    for k in STYLE_KEYS:
        if k != "star" and _style(k, m.get(k)):
            meta[k] = _style(k, m.get(k))
    write_json_atomic(dest / "note.json", meta)
    return get(lib_root, new)


def delete(lib_root: Path, nid: str) -> str:
    """挪到回收站，回回收站裡的名字（復原用，見 trash.py）；沒有這份就回空字串。"""
    d = note_dir(lib_root, nid)
    if not d:
        return ""
    dest = Path(lib_root) / ".trash" / f"note-{nid}-{datetime.now():%Y%m%d%H%M%S}"
    dest.parent.mkdir(exist_ok=True)
    if dest.exists():  # 同一秒裡刪了又復原又刪
        shutil.rmtree(dest, ignore_errors=True)
    # 整個資料夾改名（和論文一樣，見 Library.trash）：筆記 AI 的程序工作目錄可能還在這裡（Windows 上會被占著），多等幾次
    for attempt in range(12):
        try:
            d.rename(dest)
            break
        except PermissionError:
            if attempt == 11:
                raise ValueError(tr("這份筆記的檔案還被占用著（可能 AI 正在寫），等幾秒再刪")) from None
            time.sleep(0.25)
    return dest.name


def folder_styles(lib_root: Path) -> dict:
    """分類（資料夾）的圖示和顏色：{名字: {"icon", "color"}}。存在文獻庫的 _notes/_folders.json——
    跟著文獻庫走（雲端同步的文獻庫，換一台電腦分類還是同樣的圖示），不放在各台電腦自己的偏好裡。"""
    data = read_json(folder(lib_root) / "_folders.json", {}) or {}
    out = {}
    for name, v in data.items() if isinstance(data, dict) else []:
        if isinstance(name, str) and isinstance(v, dict):
            st = {"icon": _style("icon", v.get("icon")), "color": _style("color", v.get("color"))}
            if st["icon"] or st["color"]:
                out[name] = st
    return out


def set_folder_style(lib_root: Path, name: str, icon=None, color=None) -> dict:
    name = _style("folder", name)
    if not name:
        raise ValueError(tr("分類要有名字"))
    styles = folder_styles(lib_root)
    cur = styles.get(name, {"icon": "", "color": ""})
    if icon is not None:
        cur["icon"] = _style("icon", icon)
    if color is not None:
        cur["color"] = _style("color", color)
    if cur["icon"] or cur["color"]:
        styles[name] = cur
    else:
        styles.pop(name, None)
    folder(lib_root).mkdir(parents=True, exist_ok=True)
    write_json_atomic(folder(lib_root) / "_folders.json", styles)
    return styles


def rename_folder(lib_root: Path, old: str, new: str) -> int:
    """分類改名／刪掉（new 是空的）：放在這個分類裡的筆記跟著改，分類的圖示顏色也搬過去。回改了幾份筆記。"""
    base = folder(lib_root)
    n = 0
    old = _style("folder", old)
    if not old:  # 沒說是哪個分類：不然「沒放分類的筆記」全部會被當成符合
        return 0
    styles = folder_styles(lib_root)
    if old in styles:
        st = styles.pop(old)
        if _style("folder", new) and _style("folder", new) not in styles:
            styles[_style("folder", new)] = st
        base.mkdir(parents=True, exist_ok=True)
        write_json_atomic(base / "_folders.json", styles)
    for d in base.iterdir() if base.is_dir() else []:
        if not d.is_dir() or not (d / "note.json").is_file():
            continue
        m = read_json(d / "note.json", {}) or {}
        if (m.get("folder") or "") != old:
            continue
        if _style("folder", new):
            m["folder"] = _style("folder", new)
        else:
            m.pop("folder", None)
        write_json_atomic(d / "note.json", m)
        n += 1
    return n


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
