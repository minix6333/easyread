"""讓電腦上的 AI App（Claude、ChatGPT／Codex、Cursor、Claude Code…）讀得到、碰得到 FOLI：一個 MCP 伺服器（stdio）。
那些 App 的設定裡加一個「easyread mcp」的伺服器（設定頁「外部 AI App」有一鍵加，見 mcp_setup.py），它們就多了這幾個工具：
- 讀：現在在看哪一份、第幾頁、選了什麼字（current，要 FOLI 開著）；文獻庫清單；某幾頁的原文（整頁是圖的，用看圖讀出來的字；
  還沒看圖讀過、抽出來是亂碼或公式讀不出來的頁，連那一頁的圖一起給，讓那個 App 自己看）；
  全文搜尋；這份文件的筆記、畫線、提問。
- 寫：在某一頁加一則筆記；把回答存成提問紀錄（問題是標題、回答是正文，署名是那個 App）；請 FOLI 翻到某一頁（沒開會打開）。
資料直接讀文獻庫的檔案（和 FOLI 同一個資料夾、同一套跨行程的鎖，handoff.py），所以 FOLI 沒開也能讀、能寫；
「現在在看哪裡」問開著的 FOLI（config.SERVER_INFO 記著它的網址），「翻頁」用 easyread://open 連結（桌面版收到就翻過去）。
協定：JSON-RPC 2.0，一行一則（MCP 的 stdio 傳輸）。stdout 只放協定的訊息，別的一律寫到 stderr、記錄檔。只用標準函式庫。
"""
from __future__ import annotations

import base64
import io
import json
import re
import subprocess
import sys
import urllib.request

from . import VERSION, config, derive, docmap, handoff, pagevision, search
from .library import Library
from .log import log
from .store import Workspace, read_json

PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
PAGE_CHARS = 40000   # read_pages 一次最多給幾個字
PAGE_IMAGES = 4      # read_pages 一次最多附幾頁的圖（一張約 150 KB；太多 App 會嫌回應太大）
IMAGE_SIDE = 1400    # 附的圖長邊最多幾個像素：公式的上下標還看得清楚
NAMES = {"claude-ai": "Claude", "claude": "Claude", "claude-code": "Claude Code", "codex": "Codex", "codex-mcp-client": "Codex",
         "chatgpt": "ChatGPT", "cursor": "Cursor", "cursor-vscode": "Cursor", "gemini-cli": "Gemini", "vscode": "VS Code", "windsurf": "Windsurf"}

INSTRUCTIONS = (
    "FOLI is the user's PDF reader and research library (papers, slides, lecture notes). "
    "Start with `current` to see which document and page the user is reading and what they selected; "
    "then `read_pages` for the text (pages that are images were transcribed; pages whose text or formulas did not extract cleanly come with the page image — read those from the image), `search` across the library, `get_notes` for their highlights and notes. "
    "When you cite, give page numbers. With the user's consent you can `add_note`, `save_answer` (keeps your answer as a Q&A card on that page) "
    "or `go_to_page` to show them a page in FOLI.")

DOC = {"type": "string", "description": "Document id from list_documents or current. Omit to use the document the user is reading now."}
TOOLS = [
    {"name": "current", "description": "What the user is reading in FOLI right now: document id, title, current page, page count, and the text they have selected. Needs FOLI to be open.",
     "inputSchema": {"type": "object", "properties": {}}, "annotations": {"readOnlyHint": True}},
    {"name": "list_documents", "description": "List documents in the user's FOLI library (most recently opened first), optionally filtered by words in the title, authors or tags.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}}}, "annotations": {"readOnlyHint": True}},
    {"name": "read_pages", "description": "Read the text of pages of a document (1-based, inclusive). Pages that are images or scans contain FOLI's transcription; "
     "pages whose text or formulas could not be extracted cleanly also come with an image of the page (up to 4 per call). Long ranges are cut at about 40,000 characters.",
     "inputSchema": {"type": "object", "properties": {"doc_id": DOC, "start": {"type": "integer", "minimum": 1}, "end": {"type": "integer", "minimum": 1}}, "required": ["start"]},
     "annotations": {"readOnlyHint": True}},
    {"name": "search", "description": "Full-text search across the whole library (or one document): returns documents and pages with snippets. Also searches the user's notes.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "doc_id": {"type": "string", "description": "Limit to this document."}}, "required": ["query"]},
     "annotations": {"readOnlyHint": True}},
    {"name": "get_notes", "description": "The user's highlights, notes, questions (with saved answers) and per-page notes for a document.",
     "inputSchema": {"type": "object", "properties": {"doc_id": DOC}}, "annotations": {"readOnlyHint": True}},
    {"name": "add_note", "description": "Add a note card on a page of a document in FOLI (it appears beside that page). Write it as the user's own study note, not as a reply: "
     "start with a short topic heading (### …), then the key point first and bullets; no greetings, no \"you/I\", no closing offers. Markdown and $TeX$ are supported.",
     "inputSchema": {"type": "object", "properties": {"doc_id": DOC, "page": {"type": "integer", "minimum": 1}, "text": {"type": "string"},
                                                       "quote": {"type": "string", "description": "Optional sentence from the page the note is about."}}, "required": ["page", "text"]}},
    {"name": "save_answer", "description": "Save a question and your answer as a Q&A card on a page in FOLI, signed with your app's name. Use when the user wants to keep an answer.",
     "inputSchema": {"type": "object", "properties": {"doc_id": DOC, "page": {"type": "integer", "minimum": 1}, "question": {"type": "string"}, "answer": {"type": "string"}},
                     "required": ["page", "question", "answer"]}},
    {"name": "go_to_page", "description": "Show a page of a document in FOLI (opens FOLI and the document if needed). Optionally highlight a word or phrase on that page.",
     "inputSchema": {"type": "object", "properties": {"doc_id": DOC, "page": {"type": "integer", "minimum": 1}, "find": {"type": "string"}}, "required": ["page"]},
     "annotations": {"readOnlyHint": True}},
]


class Fail(Exception):
    """工具用錯了（給模型看的說明，isError）。"""


def _lib() -> Library:
    return Library(config.library_dir())


def _page_jpeg(ws: Workspace, n: int) -> str | None:
    """第 n 頁的圖：長邊最多 IMAGE_SIDE、JPEG，base64。做不出來回 None（只給字）。"""
    try:
        src = derive.page_image(ws.root, n)
        if not src:
            return None
        from PIL import Image
        with Image.open(src) as im, im.convert("RGB") as rgb:
            rgb.thumbnail((IMAGE_SIDE, IMAGE_SIDE))
            buf = io.BytesIO()
            rgb.save(buf, "JPEG", quality=80)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:  # noqa: BLE001
        log.exception("MCP：第 %s 頁的圖做不出來 %s", n, ws.id)  # i18n-ok 記錄
        return None


def _live(path: str, timeout: float = 2.0):
    """問開著的 FOLI（沒開回 None）。"""
    info = read_json(config.SERVER_INFO, {}) or {}
    url = str(info.get("url") or "")
    if not re.fullmatch(r"http://127\.0\.0\.1:\d{2,5}", url):
        return None
    try:
        with urllib.request.urlopen(url + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 —— 沒開、正在關
        return None


class Server:
    def __init__(self, out=None):
        self.out = out or sys.stdout
        self.client = "AI"

    # ---------- 協定 ----------
    def send(self, msg: dict) -> None:
        self.out.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.out.flush()

    def handle(self, msg: dict) -> dict | None:
        """一則請求 → 回應（通知回 None）。"""
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if mid is None:  # 通知（notifications/initialized、cancelled）：不回
            return None
        try:
            if method == "initialize":
                info = params.get("clientInfo") or {}
                name = str(info.get("name") or "").strip()
                self.client = NAMES.get(name.lower(), name[:40] or "AI")
                want = params.get("protocolVersion")
                return {"jsonrpc": "2.0", "id": mid, "result": {
                    "protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "foli", "title": "FOLI", "version": VERSION},
                    "instructions": INSTRUCTIONS}}
            if method == "ping":
                return {"jsonrpc": "2.0", "id": mid, "result": {}}
            if method == "tools/list":
                return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
            if method == "tools/call":
                name, args = str(params.get("name") or ""), params.get("arguments") or {}
                fn = getattr(self, "t_" + name, None)
                if not fn or name not in {t["name"] for t in TOOLS}:
                    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool: {name}"}}
                try:
                    out = fn(args if isinstance(args, dict) else {})  # 字串，或已經排好的內容（字＋圖）
                    content = out if isinstance(out, list) else [{"type": "text", "text": out}]
                    return {"jsonrpc": "2.0", "id": mid, "result": {"content": content, "isError": False}}
                except Fail as e:
                    return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": str(e)}], "isError": True}}
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}
        except Exception as e:  # noqa: BLE001 —— 一個請求出錯不能讓整個伺服器掉
            log.exception("MCP %s 出錯", method)  # i18n-ok 記錄
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)[:500]}}

    def run(self, inp=None) -> None:
        for line in inp or sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                continue
            for one in msg if isinstance(msg, list) else [msg]:
                if isinstance(one, dict):
                    res = self.handle(one)
                    if res is not None:
                        self.send(res)

    # ---------- 工具 ----------
    def _ws(self, args: dict) -> Workspace:
        pid = str(args.get("doc_id") or "").strip()
        if not pid:
            focus = _live("/api/focus") or {}
            pid = str(focus.get("id") or "")
            if not pid:
                raise Fail("No document given and FOLI has no document open. Pass doc_id (see list_documents).")
        lib = _lib()
        ws = lib.ws(pid)
        if ws is None:
            hits = [w for w in lib.all() if w.id.startswith(pid)] if len(pid) >= 4 else []
            if len(hits) != 1:
                raise Fail(f"No document with id {pid!r}. Use list_documents to find it.")
            ws = hits[0]
        return ws

    def t_current(self, args: dict) -> str:
        focus = _live("/api/focus")
        if focus is None:
            return "FOLI is not open. Use list_documents and read_pages to read the library directly."
        if not focus.get("id"):
            return "FOLI is open but no document is being read right now."
        out = {k: focus.get(k) for k in ("id", "title", "page", "pages") if focus.get(k) is not None}
        if focus.get("sel"):
            out["selected_text"] = focus["sel"]
        if focus.get("age") is not None:
            out["seconds_since_last_activity"] = focus["age"]
        return json.dumps(out, ensure_ascii=False, indent=1)

    def t_list_documents(self, args: dict) -> str:
        q = str(args.get("query") or "").strip().lower()
        limit = max(1, min(200, int(args.get("limit") or 50)))
        items = _lib().list()
        if q:
            items = [i for i in items if q in " ".join(str(i.get(k) or "") for k in ("title_zh", "title_en", "authors", "id")).lower() or q in " ".join(i.get("tags") or []).lower()]
        items.sort(key=lambda i: str(i.get("last_opened") or i.get("added") or ""), reverse=True)
        rows = [{"id": i.get("id"), "title": i.get("title_zh") or i.get("title_en") or i.get("id"), "original_title": i.get("title_en") if i.get("title_zh") else None,
                 "authors": i.get("authors") or None, "year": i.get("year") or None, "pages": i.get("pages") or None, "kind": i.get("kind") or None,
                 "tags": i.get("tags") or None, "last_opened": i.get("last_opened") or None} for i in items[:limit]]
        return json.dumps([{k: v for k, v in r.items() if v} for r in rows], ensure_ascii=False, indent=1) + (f"\n({len(items) - limit} more)" if len(items) > limit else "")

    def t_read_pages(self, args: dict):
        ws = self._ws(args)
        texts = docmap.page_texts(ws)
        if not texts:
            raise Fail("This document has no extracted text yet (FOLI may still be preparing it).")
        start = max(1, int(args.get("start") or 1))
        end = min(len(texts), int(args.get("end") or start))
        if start > len(texts):
            raise Fail(f"The document has {len(texts)} pages.")
        # 要看圖才讀得準、FOLI 還沒看過的頁（整頁是圖、亂碼、公式的上下標變成別的文字）：附上那一頁的圖，讓那個 App 自己看
        try:
            seen = pagevision.load(ws.root).get("pages") or {}
            unseen = {n for n in pagevision.scan(ws.root) if str(n) not in seen}
        except Exception:  # noqa: BLE001 —— 量不了就照舊只給字
            unseen = set()
        parts, images, later, used = [f"《{handoff.title(ws)}》 pages {start}–{end} of {len(texts)}"], [], [], 0  # i18n-ok 給模型看的
        for n in range(start, end + 1):
            body = (texts[n - 1] or "").strip()
            if used + len(body) > PAGE_CHARS and n > start:
                parts.append(f"[stopped at page {n - 1}: too long; ask for page {n} onwards separately]")
                break
            used += len(body)
            img = _page_jpeg(ws, n) if n in unseen and len(images) < PAGE_IMAGES else None
            if img:
                images.append((n, img))
                body = (f"[The text layer of page {n} is unreliable (formulas or text came out garbled) — read page {n} from the attached image.]"
                        + ("\n" + body if body else ""))
            elif n in unseen:
                later.append(n)
            parts.append(f"=== page {n} ===\n{body or '(no text on this page)'}")
        if later:
            parts.append(f"[pages {', '.join(map(str, later))} also need to be read from images; call read_pages for them separately]")
        text = "\n\n".join(parts)
        if not images:
            return text
        out = [{"type": "text", "text": text}]
        for n, data in images:
            out += [{"type": "text", "text": f"Image of page {n}:"}, {"type": "image", "data": data, "mimeType": "image/jpeg"}]
        return out

    def t_search(self, args: dict) -> str:
        q = str(args.get("query") or "").strip()
        if len(q) < 2:
            raise Fail("Query too short.")
        res = search.search(_lib(), q, limit=30)
        pid = str(args.get("doc_id") or "").strip()
        lib, rows = _lib(), []
        for r in res.get("results", []):
            if pid and r.get("id") != pid:
                continue
            ws = lib.ws(r["id"]) if r.get("kind") == "paper" else None
            title = handoff.title(ws) if ws else r.get("id")
            hits = [{"page": h.get("page"), "in": "user's note" if h.get("where") == "note" else "text", "snippet": h.get("text") or h.get("snippet") or ""} for h in r.get("hits", [])]
            rows.append({"doc_id": r.get("id"), "kind": r.get("kind"), "title": title, "matches": r.get("n"), "hits": hits})
        return json.dumps(rows, ensure_ascii=False, indent=1) if rows else f"No matches for {q!r}."

    def t_get_notes(self, args: dict) -> str:
        ws = self._ws(args)
        reader, disc = ws.load("reader") or {}, ws.load("discussion") or {}
        replies: dict[str, list] = {}
        for e in disc.get("entries", []):
            if e.get("reply_to"):
                replies.setdefault(e["reply_to"], []).append(e)
        notes = sorted((n for n in (reader.get("notes") or {}).values() if not n.get("deleted")), key=lambda n: (n.get("page") or 0, n.get("created") or ""))
        out = [f"# Notes in 《{handoff.title(ws)}》"]  # i18n-ok 給模型看的
        for n in notes:
            head = f"- page {n.get('page') or '?'} · {n.get('kind', 'note')}"
            if n.get("quote"):
                head += f" · quote: “{n['quote'][:300]}”"
            if (n.get("body") or "").strip():
                head += f"\n  {n['body'].strip()[:2000]}"
            for r in replies.get(n.get("id"), []):
                head += f"\n  answer ({r.get('by') or 'AI'}): {(r.get('body') or '').strip()[:3000]}"
            out.append(head)
        for page, pn in sorted((reader.get("page_notes") or {}).items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 0):
            if (pn.get("body") or "").strip():
                out.append(f"- page {page} · page note\n  {pn['body'].strip()[:3000]}")
        if ((reader.get("paper_note") or {}).get("body") or "").strip():
            out.append("## Summary note\n" + reader["paper_note"]["body"].strip()[:6000])
        return "\n".join(out) if len(out) > 1 else "No notes in this document yet."

    def t_add_note(self, args: dict) -> str:
        ws = self._ws(args)
        try:
            note = handoff.add_note(ws, int(args.get("page") or 1), str(args.get("text") or ""), str(args.get("quote") or ""), self.client)
        except ValueError as e:
            raise Fail(str(e)) from e
        return f"Added a note on page {note['page']} of 《{handoff.title(ws)}》."  # i18n-ok

    def t_save_answer(self, args: dict) -> str:
        ws = self._ws(args)
        try:
            note = handoff.add_qa(ws, int(args.get("page") or 1), str(args.get("question") or ""), str(args.get("answer") or ""), self.client)
        except ValueError as e:
            raise Fail(str(e)) from e
        return f"Saved as a Q&A card on page {note['page']} of 《{handoff.title(ws)}》, signed {self.client}."  # i18n-ok

    def t_go_to_page(self, args: dict) -> str:
        ws = self._ws(args)
        page = max(1, int(args.get("page") or 1))
        total = handoff.page_count(ws)
        if total and page > total:
            raise Fail(f"The document has {total} pages.")
        link = f"easyread://open?id={ws.id}&page={page}"
        find = re.sub(r"[^\w\s\-.,:;'()　-鿿＀-￯]", "", str(args.get("find") or ""))[:80].strip()  # i18n-ok 字元範圍
        if find:
            from urllib.parse import quote
            link += "&find=" + quote(find)
        if not _open_link(link):
            raise Fail("Could not ask FOLI to open the page (is FOLI installed?).")
        return f"FOLI is showing page {page} of 《{handoff.title(ws)}》."  # i18n-ok


def _open_link(link: str) -> bool:
    try:
        if sys.platform == "darwin":
            cmd = ["open", link]
        elif sys.platform.startswith("win"):
            cmd = ["cmd", "/c", "start", "", link]
        else:
            cmd = ["xdg-open", link]
        return subprocess.run(cmd, capture_output=True, timeout=10).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def main() -> None:
    """easyread mcp：stdin／stdout 上的 MCP 伺服器。"""
    out = sys.stdout
    sys.stdout = sys.stderr  # 之後誰不小心 print 都不會弄壞協定
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        out.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    Server(out).run(sys.stdin)


if __name__ == "__main__":
    main()
