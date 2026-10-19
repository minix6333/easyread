"""交給外部 AI、從外部 AI 拿回來：右邊外部工具欄裡的 ChatGPT／Claude／Gemini 網頁（dock-ai.js），
和電腦上的 AI App 透過 MCP（mcp_server.py）都用這裡。

- share_file：要附給外部 AI 的檔案。整份 PDF 用文件的標題當檔名（硬碟上叫 source.pdf，給 AI 看到的是「取樣增強的監督式微調.pdf」）；
  一頁就是那一頁的圖（JPEG，各家都收）。放在這台電腦的快取（config.CACHE_DIR/<id>/share），不進雲端硬碟；內容沒變就不重做。
- add_note／add_qa：外部 AI 的回答存回這份文件——一般的筆記，或排成提問紀錄（問題是標題、回答是正文，署名是哪個 AI，
  和在 FOLI 裡問的長得一樣）。都是在伺服器這邊套一筆 reader 的操作（和頁面自己存的走同一條路，會進同步日誌），
  開著的閱讀頁下一次輪詢就看得到。
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import time
from pathlib import Path

from . import config, derive, paperdata
from .i18n import tr
from .store import Workspace, now_iso

MAX_TEXT = 60000   # 一則筆記、一則回答最多存幾個字
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def title(ws: Workspace) -> str:
    meta = (ws.load("paper") or {}).get("meta") or {}
    item = (ws.load("item") or {}).get("meta_override") or {}
    # 原文標題優先（主頁的卡片也是原文標題）：給外部 AI 的檔名、提示詞都用它；沒有原文標題的（中文文件）才用中文的
    return str(item.get("title_en") or meta.get("title_en") or item.get("title_zh") or meta.get("title_zh") or meta.get("source") or ws.id).strip()


def page_count(ws: Workspace) -> int:
    meta = (ws.load("paper") or {}).get("meta") or {}
    return len(meta.get("pages") or []) or int(meta.get("page_count") or 0)


def _safe_name(text: str, limit: int = 80) -> str:
    """檔名：投影片檔名常見的「Microsoft PowerPoint -」「- Copy」拿掉（libask 的 _JUNK），不能用在檔名的字換成空白。"""
    from .libask import _JUNK
    for _ in range(3):
        text = _JUNK.sub("", text or "").strip()
    name = _BAD.sub(" ", text.replace("_", " ")).strip().strip(".") or "document"
    return re.sub(r"\s+", " ", name)[:limit].rstrip()


def _share_dir(ws: Workspace) -> Path:
    d = config.CACHE_DIR / ws.id / "share"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _fresh(out: Path, src: Path) -> bool:
    try:
        a, b = out.stat(), src.stat()
    except OSError:
        return False
    return a.st_size > 0 and a.st_mtime >= b.st_mtime


def _clear(d: Path, keep: Path, suffixes: tuple[str, ...]) -> None:
    for f in d.iterdir():  # 標題改過、換了一頁：舊的那個拿掉，資料夾裡不會越積越多
        if f != keep and f.suffix.lower() in suffixes:
            try:
                f.unlink()
            except OSError:
                pass


def share_file(ws: Workspace, kind: str, n: int | None = None) -> dict:
    """{path, name}：給外部 AI 的檔案在這台電腦上的路徑。kind="pdf" 整份；kind="page" 第 n 頁的圖。"""
    d = _share_dir(ws)
    name = _safe_name(title(ws))
    if kind == "pdf":
        src = ws.root / "source.pdf"
        if not src.exists():
            raise ValueError(tr("這份文件沒有 PDF"))
        out = d / f"{name}.pdf"
        if not _fresh(out, src):
            _clear(d, out, (".pdf",))
            tmp = out.with_name(out.name + ".part")
            try:
                os.link(src, tmp)  # 同一顆硬碟：不用真的複製一份
            except OSError:
                shutil.copyfile(src, tmp)
            tmp.replace(out)
        return {"path": str(out), "name": out.name}
    if kind == "page":
        total = page_count(ws)
        if not n or n < 1 or (total and n > total):
            raise ValueError(tr("沒有第 {n} 頁", n=n))
        img = derive.page_image(ws.root, int(n))
        if not img:
            raise ValueError(tr("沒有第 {n} 頁", n=n))
        out = d / f"{name} p{int(n)}.jpg"
        if not _fresh(out, img):
            _clear(d, out, (".jpg",))
            from PIL import Image
            with Image.open(img) as im, im.convert("RGB") as rgb:
                tmp = out.with_name(out.name + ".part")
                rgb.save(tmp, "JPEG", quality=90)
                tmp.replace(out)
        return {"path": str(out), "name": out.name}
    raise ValueError(tr("kind 只能是 pdf 或 page"))


def _uid() -> str:
    """和頁面上的 PR.uid("n") 一樣的樣子：n＋時間（36 進位）＋四個亂數字元。"""
    t, digits, s = int(time.time() * 1000), "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while t:
        t, r = divmod(t, 36)
        s = digits[r] + s
    return "n" + s + "".join(secrets.choice(digits) for _ in range(4))


def _note(ws: Workspace, kind: str, page: int, body: str, quote: str = "", src: str = "") -> dict:
    total = page_count(ws)
    page = max(1, min(int(page or 1), total or int(page or 1)))
    now = now_iso()
    note = {"id": _uid(), "kind": kind, "body": body, "created": now, "updated": now, "anchor": None,
            "page": page, "side": "pdf", "quote": (quote or "").strip()[:1000]}
    if src:
        note["src"] = src[:40]  # 從哪來的（ChatGPT、Claude…）：卡片上只當署名用
    ws.apply_reader_ops([{"op": "note", "note": note, "at": now}], client="handoff")
    return note


def add_note(ws: Workspace, page: int, body: str, quote: str = "", src: str = "") -> dict:
    body = (body or "").strip()[:MAX_TEXT]
    if not body:
        raise ValueError(tr("body 不能为空"))
    return _note(ws, "note", page, body, quote, src)


def add_qa(ws: Workspace, page: int, question: str, answer: str, by: str, quote: str = "") -> dict:
    """存成一則提問紀錄：問題（標題）＋回答（嵌在卡片裡的回覆，署名 by）。"""
    question = re.sub(r"\s+", " ", (question or "").strip())[:2000] or tr("（外部 AI 的回答）")
    answer = (answer or "").strip()[:MAX_TEXT]
    if not answer:
        raise ValueError(tr("body 不能为空"))
    by = (by or "AI").strip()[:40]
    note = _note(ws, "question", page, question, quote, by)
    paperdata.add_discussion(ws, [{"reply_to": note["id"], "kind": "reply", "body": answer, "by": by}])
    return note


def handle(ws: Workspace, body: dict) -> dict:
    """POST /api/p/<id>/handoff：{do: "file", kind, page} / {do: "note", page, body, quote, src} / {do: "qa", page, question, answer, by, quote}。"""
    do = str(body.get("do") or "")
    if do == "file":
        return share_file(ws, str(body.get("kind") or ""), int(body.get("page") or 0) or None)
    if do == "note":
        return {"note": add_note(ws, int(body.get("page") or 1), str(body.get("body") or ""), str(body.get("quote") or ""), str(body.get("src") or ""))}
    if do == "qa":
        return {"note": add_qa(ws, int(body.get("page") or 1), str(body.get("question") or ""), str(body.get("answer") or ""),
                               str(body.get("by") or ""), str(body.get("quote") or ""))}
    raise ValueError(tr("do 只能是 file、note 或 qa"))
