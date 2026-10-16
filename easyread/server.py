"""本地服务：只监听 127.0.0.1。文献库页、阅读页、数据接口、导入、后台任务。"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading
import time

from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import config, paths  # 先載 config（paths 也會）：chat_models 和 config 互相引用，順序反了會炸
from . import VERSION, __version__, answer_styles, backdrop, cloudsync, covers, derive, figures, chat, chat_models, chat_store, cli_models, clips, config, detect, engines, i18n, kinds, langs, notehelp, notes, open_link, quick, paperdata, pdfwork, prefs, preread, search, settings_api, supp, trash, tw, library_api, translate_api, updates, usage, webimg, webtools, wsock, jobs, sync
from .log import log, tail
from .jobs import Jobs
from .library import Library
from .i18n import tr
from .store import now_iso
from .reader_files import refresh_layout as _refresh_layout, warm as _warm, reveal as _reveal, _warming

WEB = config.WEB
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
MAX_UPLOAD = 200 * 1024 * 1024


def _tags(value) -> list[str]:
    """匯入時要放進的分類：逗號分隔的字串或陣列；每個最多 30 字、最多 8 個。"""
    items = value if isinstance(value, list) else str(value or "").split(",")
    out: list[str] = []
    for t in items:
        t = str(t).strip()[:30]
        if t and t not in out:
            out.append(t)
    return out[:8]


def _safe(base: Path, rel: str) -> Path | None:
    target = (base / rel).resolve()
    return target if target.is_relative_to(base.resolve()) and target.is_file() else None


def _derived_file(root: Path, rel: str) -> Path | None:
    """pages/… extract/… 這類可重算的檔：同步模式下在本機快取（paths.derived），路徑一樣不能跳出去。"""
    top, _, rest = rel.partition("/")
    return _safe(paths.derived(root, top), rest) if rest else None


_PREFETCH_AHEAD = 4
_prefetching: set = set()
_prefetch_lock = threading.Lock()


def _prefetch_pages(root, rel: str, w: int) -> None:
    """讀者要了第 n 頁某個寬度的圖：n+1…n+4 頁同寬度的圖在背景先生成（已有的略過；pdfium 一次只做一張，排隊做完）。"""
    m = re.fullmatch(r"pages/page-(\d{3})(\.\w+)", rel)
    if not m:
        return
    n, ext = int(m.group(1)), m.group(2)
    todo = []
    pages_dir = paths.derived(root, "pages")  # 同步模式下在本機快取（以前這裡看的是論文資料夾，同步模式下永遠不預先做）
    total = derive.page_count(root)
    with _prefetch_lock:
        for k in range(n + 1, n + 1 + _PREFETCH_AHEAD):
            key = (str(root), k, w)
            nxt = f"pages/page-{k:03d}{ext}"
            if key in _prefetching or k > total or (pages_dir / f"w{max(400, min(4000, w // 100 * 100))}" / f"page-{k:03d}{ext}").exists():
                continue
            _prefetching.add(key)
            todo.append((key, nxt))
    if not todo:
        return

    def go():
        for key, nxt in todo:
            try:
                derive.page_image(root, derive.page_of(nxt))
                pdfwork.page_variant(root, nxt, w)
            except Exception:  # noqa: BLE001 —— 預先做失敗沒關係，真的要時再做
                pass
            finally:
                with _prefetch_lock:
                    _prefetching.discard(key)
    threading.Thread(target=go, daemon=True).start()


class App:
    def __init__(self, cfg: dict):
        self.lib = Library(config.library_dir(cfg))
        self.jobs = Jobs(self.lib)
        self.token = os.urandom(12).hex()
        self.location = library_api.LibraryLocation(self)
        self.presence = None  # presence.Presence，serve() 里设


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def handle_one_request(self):
        self._body_bytes = None  # 同一條連線會接著處理好幾個請求：每個請求自己的內容讀了沒，從頭算
        super().handle_one_request()

    def _settle_body(self):
        """回應之前，請求帶來的內容一定要處理掉。
        連線是保持著的（HTTP/1.1）：還沒讀就先回了（權杖不對、沒有這篇、路徑不認得），那段內容會留在連線上，被當成
        「下一個請求的開頭」——瀏覽器接著在同一條連線上要的東西（一支 JS、一張圖、整個頁面，什麼都可能）就拿到一個 501。
        小的讀掉丟棄、連線照用；大的（上傳被拒）不值得讀完，回完就把連線關掉。"""
        if getattr(self, "_body_bytes", None) is not None:
            return
        try:
            n = max(0, int(self.headers.get("Content-Length") or 0))
        except (TypeError, ValueError):
            n = 0
        self._body_bytes = b""
        if not n:
            return
        if n <= 1 << 20:
            try:
                self.rfile.read(n)
                return
            except OSError:
                pass
        self.close_connection = True

    # ---------- 输出 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: bool = False, etag: str = ""):
        self._settle_body()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 可以快取的檔案：文獻庫裡的東西（頁面的圖、封面、筆記的圖）瀏覽器留著，但每次用之前拿 ETag 來對一下（no-cache）——
        # 以前是「一天內不用問」：萬一哪一次給出去的是壞的（寫到一半的圖），那一頁一整天怎麼開都是壞的。
        # 跟著程式走的那些（cache="long"：附的程式庫、字型）不會自己變，照舊一天內不用問，開分頁才不會多幾十個請求
        self.send_header("Cache-Control", ("max-age=86400" if cache == "long" or not etag else "no-cache") if cache else "no-store")
        if etag:
            self.send_header("ETag", etag)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _file(self, path: Path | None, cache=False):
        if not path:
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        if not cache:
            return self._send(200, path.read_bytes(), ctype)
        try:
            st = path.stat()
        except OSError:
            return self._json(404, {"error": "not found"})
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'  # 檔案一變（重做、換過）就不一樣
        if self.headers.get("If-None-Match") == etag:  # 瀏覽器手上那份還是對的：不用再傳一次
            self._settle_body()
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "max-age=86400" if cache == "long" else "no-cache")
            self.end_headers()
            return
        self._send(200, path.read_bytes(), ctype, cache, etag)

    def _redirect(self, location: str):
        self._settle_body()
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _page(self, path: Path):
        self._send(200, i18n.inject(path.read_text(encoding="utf-8")).encode("utf-8"), "text/html; charset=utf-8")

    def _download(self, body: bytes, filename: str, ctype: str):
        self._settle_body()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename=\"export.html\"; filename*=UTF-8''{quote(filename)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _chat(self, ws, body: dict):
        """流式回答：一行一个 JSON，{"t": 片段} … 最后 {"done": true, "id": …} 或 {"error": …}。"""
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError(tr("问题是空的"))
        thread = chat_store.get(ws, body.get("thread"))
        style = answer_styles.parse(body.get("answer_style", (thread or {}).get("answer_style")))
        cfg = config.load()
        ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
        from . import chat_options
        options = chat_options.apply(ecfg, body.get("chat_options"))
        model = chat_models.label(m)
        tid = thread["id"] if thread else chat_store.new_id()
        refs = []
        for r in (body.get("refs") or [])[:12]:  # 引用：段落 id，或原 PDF 的頁碼（沒對到段落時）
            if not isinstance(r, dict) or not (r.get("anchor") or r.get("page")):
                continue
            try:
                page = int(r["page"]) if r.get("page") else None
            except (TypeError, ValueError):
                page = None
            refs.append({"anchor": str(r.get("anchor") or ""), "quote": str(r.get("quote") or "")[:1000], **({"page": page} if page else {})})
        first = refs[0] if refs else {}
        try:
            page = int(body.get("page") or first.get("page") or 0) or None
        except (TypeError, ValueError):
            page = None
        images = clips.resolve(ws.root, body.get("images"))  # 這次附的圖（框選的區域、貼進來的圖片）
        user = {"content": text, "anchor": body.get("anchor") or first.get("anchor"), "page": page, "quote": (body.get("quote") or first.get("quote") or "")[:1000],
                "note": body.get("note"), "refs": refs, "answer_style": style, "chat_options": options}
        if images:
            user["images"] = [clips.rel(p) for p in images]
        mode = body.get("mode") if body.get("mode") in chat.MODES or body.get("mode") == "overview" else None  # 推導、圖解、整份導讀
        if mode:
            user["mode"] = mode
        # 小視窗追問：指著之前某段回答裡的一句另外問（第一問帶 aside，之後這個對話裡的追問從對話上記的拿）
        aside_in = body.get("aside") if isinstance(body.get("aside"), dict) else (thread or {}).get("aside")
        aside = chat.aside_context(ws, aside_in)
        if aside and isinstance(body.get("aside"), dict):
            user["aside"] = {"thread": str(aside_in.get("thread")), "msg": str(aside_in.get("msg") or ""), "quote": aside["quote"]}
        past = (thread or {}).get("messages", [])
        convo = [{"role": x["role"], "content": x["content"] + chat.images_note(x.get("images"))} for x in past] + [{"role": "user", "content": text}]
        # 可以上網查：頁面上那顆地球（每問一次都帶著）；沒帶就照設定。模型不能上網的（別家的 API）當成沒開
        web = (bool(body["web"]) if "web" in body else webtools.enabled_default()) and webtools.supported(ecfg)
        if web:
            user["web"] = True
        prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs, answer_style=style, page=page,
                                  images=user.get("images"), mode=mode, aside=aside, web=web)
        # 模型行程还记着这个对话（claude_live / codex_live）：只送新问题；读者还指着同一处连位置上下文也省掉
        prev_turns = sum(1 for x in past if x.get("role") == "assistant")
        live = {"thread": tid, "turns": prev_turns}
        if prev_turns and chat.bound_turns(ecfg, ws, tid, web) == prev_turns:
            prev_user = next((x for x in reversed(past) if x.get("role") == "user"), None)
            same = chat.same_spot(prev_user, user, refs, page) and not images
            live["followup_text"] = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs, answer_style=style, page=page,
                                                images=user.get("images"), followup=True, with_context=not same, mode=mode, aside=aside, web=web)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cancel = threading.Event()
        pieces: list[str] = []
        meter = usage.Meter(ecfg["engine"])
        watching = chat.cancel_when_gone(self, cancel)  # 讀者按停止：馬上知道（不用等到下一次送字）

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()

        found = webtools.Sources()  # 這一題上網碰過的網頁；回答底下列的是回答裡引用的＋真的打開讀過的（found.final）

        def on_source(url, title="", domain="", kind="result"):
            if found.add(url, title, domain, kind) and kind != "result":  # 真的打開讀過的：馬上加到回答底下；搜尋結果只是候選，最後看有沒有引用
                send({"source": found.get(url)})

        def keep_partial():  # 寫到一半被停下來：已經寫出來的留著，後面記一筆（已停止）
            if pieces:
                text = webtools.clean("".join(pieces))
                chat_store.append(ws, tid, {**user, "note": None}, text + "\n\n" + tr("（已停止）"), m["id"], model, meter.snapshot(),
                                  sources=found.final(text))
        try:
            send({"model": model, "thread": tid, "answer_style": style})
            def seen(actual):
                chat_models.remember(m.get("model", ""), actual)
                if m.get("engine") == "claude":
                    send({"model": chat_models.label(m)})
            guard = tw.Stream(tw.is_tw(langs.reply_code(ws.load("paper").get("meta"))))  # 繁體保險：模型夾帶的簡體字轉掉
            t0 = time.time()
            first = 0.0
            answer = chat.stream(ecfg, prompt_text, ws.root, cancel, seen, meter, **({"images": images} if images else {}),
                                 live=live, on_live=lambda: send({"stream": "live"}),
                                 on_status=lambda st: send({"status": st}),  # 還沒出字時：重新連線、太擠自動再問、開始思考；上網查的動作隨時報
                                 web=web, on_source=on_source)
            try:
                for piece in answer:
                    piece = guard.feed(piece)
                    if piece:
                        if not pieces:  # 首字花了多久（終端機裡看得到；追問、預熱有沒有生效就看這個）
                            first = time.time() - t0
                            log.info("問 AI 首字 %.1f 秒（%s%s）", first, model, "，追問" if live.get("followup_text") else "")  # i18n-ok 終端機記錄
                        pieces.append(piece)
                        send({"t": piece})
            finally:
                if hasattr(answer, "close"):
                    answer.close()  # 讀者按了停止（送不出去了）：馬上收掉，模型那邊才會跟著停（codex_live 會送 turn/interrupt）
            tail = guard.flush()
            if tail:
                pieces.append(tail)
                send({"t": tail})
            answer_text = webtools.clean("".join(pieces))
            final = found.final(answer_text)
            if final:  # 回答最後自己列的那份「Sources:」：底下已經有來源了，拿掉（先算完引用了哪些再拿）
                answer_text = webtools.strip_source_list(answer_text)
            if final or len(found):
                send({"sources": final})  # 換掉寫的時候一個個加進來的那幾個：最後的清單（引用的照文中順序）
            msg = chat_store.append(ws, tid, user, answer_text, m["id"], model, meter.snapshot(), sources=final)
            # 整則花了多久、寫得多快（慢是等第一個字、還是寫得慢，看這一行就知道）
            total, snap = time.time() - t0, meter.snapshot() or {}
            log.info("問 AI 寫完 %.1f 秒（首字 %.1f 秒，%d 字，輸出 %s token，每秒約 %.0f；輸入 %s、快取 %s；%s%s）", total, first, len("".join(pieces)),  # i18n-ok 終端機記錄
                     snap.get("output", "?"), (snap.get("output") or 0) / max(0.1, total - first), snap.get("input", "?"), snap.get("cached", "?"),
                     model, ("，Fast" if (ecfg.get(ecfg.get("engine")) or {}).get("service_tier") == "fast" else "") + ("，上網查了 %d 個網頁" % len(found) if found else ""))  # i18n-ok
            send({"done": True, "id": msg["id"], "usage": msg.get("usage"), **({"text": answer_text} if answer_text != "".join(pieces) else {})})  # 存的和寫出來的不一樣（拿掉了引用記號、來源清單）：頁面換成存的
            # 還沒讀過整份（舊論文、另一台匯入的）：答完這一問才在背景讀，下一問起就帶著全文筆記。
            # 以前是一收到問題就開始讀——兩件事同時搶同一個帳號，這一問的第一個字被拖慢（實測 30 秒以上）
            preread.auto(ws)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            cancel.set()  # 读者点了停止或关了页面
            keep_partial()
        except engines.Cancelled:
            keep_partial()
        except Exception as e:  # noqa: BLE001
            log.exception("对话出错 %s", ws.id)
            try:
                send({"error": str(e)[:500]})
            except OSError:
                pass
        finally:
            watching()

    def _body(self) -> bytes:
        if getattr(self, "_body_bytes", None) is not None:  # 讀過了：連線上已經沒有這段，再讀會卡住等下一個請求
            return self._body_bytes
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_UPLOAD:
            raise ValueError(tr("文件太大"))  # 沒讀的那一大段由 _settle_body 處理（關連線）
        self._body_bytes = self.rfile.read(n) if n else b""
        return self._body_bytes

    def _import_result(self, ws, fresh, translate_after, scope, read=False, model="", target="", kind="", tags=None):
        # A failed first preparation still leaves a library entry. Re-importing
        # that PDF must retry preparation instead of silently skipping it.
        if tags:  # 匯入框裡選的分類（或正在看的那個分類）：直接放進去；已經在庫裡的也加上
            have = list((ws.load("item") or {}).get("tags") or [])
            ws.patch_item({"tags": have + [t for t in tags if t not in have]})
        paper = ws.load("paper") or {}
        active = (ws.load("job") or {}).get("state") in ("queued", "running")
        queued = fresh or (not paper.get("meta", {}).get("pages") and not active)
        if queued:
            if kinds.valid(kind):  # 匯入框裡選的文件類型；沒選就準備好頁面後自動判斷
                ws.update("paper", lambda p: p.setdefault("meta", {}).__setitem__("kind", kind))
            if translate_after and not read:
                langs.remember(ws, target)  # 导入框里选的译文语言
            self.app.jobs.enqueue(ws, translate_after=translate_after, scope=scope, read=read, model=model)
        return self._json(200, {"id": ws.id, "new": fresh, "queued": queued})

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            with self.app.location.request(self.command, self.path):
                self._get()
        except ValueError as e:
            self._json(409, {"error": str(e), "library_status": self.app.location.status})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        app, lib = self.app, self.app.lib
        if path in ("/", "/index.html"):  # 外殼：分頁和分割格子，文獻庫和每份文件各是裡面的一個 iframe
            return self._page(WEB / "shell.html")
        if path == "/library":
            return self._page(WEB / "library.html")
        if path.startswith("/read/"):
            return self._page(WEB / "reader.html")
        if path.startswith("/note/"):  # 獨立筆記（notes.py）
            return self._page(WEB / "note.html")
        if path == "/api/notes":
            return self._json(200, {"items": notes.listing(lib.root), "folders": notes.folder_styles(lib.root), "token": app.token})
        if path.startswith("/api/notes/"):
            n = notes.get(lib.root, path.split("/")[3])
            if not n:
                return self._json(404, {"error": tr("沒有這份筆記")})
            return self._json(200, {**n, "token": app.token})
        if path.startswith("/n/"):  # 筆記裡貼的圖
            bits = path.split("/", 3)
            if len(bits) == 4 and bits[3].startswith("clips/"):
                return self._file(notes.clip_path(lib.root, bits[2], bits[3][6:]), cache=True)
            return self._json(404, {"error": "not found"})
        if path == "/open":  # 外部工具打开指定论文/段落；桌面版的 easyread://open 也转到这里 → 交給外殼開成分頁
            target = open_link.target(lib, parse_qs(url.query))
            return self._redirect("/?open=" + quote(target, safe="") if target != "/" else "/")
        if path == "/api/version":
            return self._json(200, open_link.version())
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache="long" if path.startswith("/web/vendor/") else False)
        if path == "/api/presence" and wsock.is_upgrade(self.headers):
            return self._presence()
        location = library_api.get(app, path)
        if location is not None:
            return self._json(200, location)
        if path == "/api/sync":  # 雲端同步的現況：哪些電腦在用這個文獻庫、收到幾批別台的修改、雲端硬碟裡有沒有別的文獻庫（cloudsync.py）
            report = cloudsync.report(lib.root, sync.status())
            if app.location.status != "idle":  # 已經換了位置、等重啟：不要再建議一次
                report.update(advice=None, restart_required=True)
            return self._json(200, report)
        if path == "/api/library":
            cfg = config.load()
            return self._json(200, {"items": lib.list(), "token": app.token, "jobs": app.jobs.small_status(),
                                    "library_status": app.location.status, "other_device": app.location.marker.other_device(),
                                    "engine": cfg.get("engine"), "engine_label": cli_models.engine_label(cfg), "auto_translate": bool(cfg.get("auto_translate")),
                                    "first_run": config.is_first_run(), "version": VERSION, "trash": len(trash.items(lib.root))})
        if path == "/api/search":  # 全文搜尋：文件的內文、文件上自己寫的筆記、獨立筆記（search.py；外殼的 ⌘K 用）
            qs = parse_qs(url.query)
            try:
                limit = int((qs.get("limit") or ["12"])[0])
            except ValueError:
                limit = 12
            return self._json(200, search.search(lib, (qs.get("q") or [""])[0][:200], limit))
        if path == "/api/update":  # 有没有新版本（一天最多问一次 GitHub）
            return self._json(200, updates.check(force=parse_qs(url.query).get("force") == ["1"]))
        if path == "/api/trash":
            return self._json(200, {"items": trash.items(lib.root)})
        if path == "/api/config":
            return self._json(200, {"config": config.public(config.load()), "presets": config.PRESETS, "groups": config.PRESET_GROUPS})
        if path == "/api/engines":
            cfg = config.load()
            found = detect.detect(cfg, fresh=parse_qs(url.query).get("fresh") == ["1"])
            return self._json(200, {"found": found, "ready": detect.ready(cfg, found), "engine": cfg.get("engine"), "models": cli_models.listing()})
        if path == "/api/prefs":
            return self._json(200, prefs.load())
        if path in ("/backdrop.jpg", "/backdrop-s.jpg"):  # 自選的背景圖（設定 → 外觀）；網址帶 ?v=，換了圖瀏覽器才會重抓
            return self._file(backdrop.path("small" if path.endswith("-s.jpg") else "full"), cache=True)
        if path == "/api/chat/models":
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/webimg":  # 回答裡的 ```pic 區塊：到維基百科／維基共享資源找圖（webimg.py）；設定裡關掉了就回空的
            q = parse_qs(url.query)
            one = lambda k: (q.get(k) or [""])[0]  # noqa: E731
            if not webimg.enabled():
                return self._json(200, {"items": [], "off": True})
            found = webimg.find(one("article"), one("q"), one("file"))
            return self._json(200, {**found, "items": [{**it, "src": "/webimg?u=" + quote(it["src"], safe="")} for it in found["items"]]})
        if path == "/webimg":  # 那張圖本身（抓一次存在本機快取）
            return self._file(webimg.fetch((parse_qs(url.query).get("u") or [""])[0]) if webimg.enabled() else None, cache="long")
        if path == "/api/log":
            return self._json(200, {"text": tail(config.LOG_PATH, 200), "path": str(config.LOG_PATH)})
        if path == "/api/jobs":
            return self._json(200, {"jobs": app.jobs.small_status(parse_qs(url.query).get("pid", [None])[0])})
        if path.startswith("/api/p/"):
            parts = path.split("/")  # ['', 'api', 'p', id, action, name?]
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": tr("没有这篇论文")})
            action = parts[4]
            if action == "state":
                opened = {"last_opened": now_iso()}
                if (ws.load("item") or {}).get("status", "unread") == "unread":  # 打开过就算在读
                    opened["status"] = "reading"
                if app.location.status == "idle":
                    ws.patch_item(opened)
                    derive.ensure(ws.root, app.location)  # 另一台電腦匯入的論文：這台的頁面圖、文字要從 PDF 重做（derive.py）
                    _warm(ws.root, app.location)
                    _refresh_layout(ws)
                state = {**{n: ws.load(n) for n in ("paper", "discussion", "reader", "layout", "item")}, "job": jobs.view(ws.load("job")),
                         "versions": ws.versions(), "token": app.token, "id": ws.id, "library_status": app.location.status,
                         "engine": config.load().get("engine")}
                # 旧论文的图按定位框补截图；等内容和版本号都取完再开始，页面轮询到 paper 变了就会重画
                if app.location.status == "idle" and (state["job"] or {}).get("state") not in ("queued", "running"):
                    figures.fill_later(ws, app.location)
                return self._json(200, state)
            if action == "versions":
                return self._json(200, {**ws.versions(), "library_status": app.location.status})
            if action == "chat":
                return self._json(200, {"threads": chat_store.threads(ws), **chat_models.listing(config.load()), "limits": usage.latest()})
            if action == "brief":  # AI 讀過這份了沒（預讀的狀態、補充資料清單；preread.py）
                return self._json(200, preread.status(ws))
            if action == "log":
                return self._json(200, {"text": tail(ws.root / "job.log", 300)})
            if action == "export":
                if app.location.status != "idle":
                    raise app.location._error()
                from .build import build
                out = build(ws)
                return self._download(out.read_bytes(), out.name, "text/html; charset=utf-8")
            if action == "part" and len(parts) > 5 and parts[5] in ("paper", "discussion", "reader", "layout", "job"):
                data = ws.load(parts[5])
                return self._json(200, {"data": jobs.view(data) if parts[5] == "job" else data, "version": ws.versions()[parts[5]]})
        if path.startswith("/p/"):
            _, _, pid, rel = path.split("/", 3)
            ws = lib.ws(pid)
            if ws and rel == "cover.webp":  # 文獻庫卡片上的封面（covers.py：第一頁最上面那一塊，或自己框的）
                return self._file(covers.cover(ws.root, covers.spec_of(ws)) if app.location.status == "idle" else None, cache=True)
            if ws and app.location.status == "idle" and rel.startswith("pages/") and derive.page_of(rel):
                derive.page_image(ws.root, derive.page_of(rel))  # 這台的快取沒有這一頁：先從 PDF 做出來
            if ws and app.location.status == "idle" and rel.startswith("pages/") and "w=" in url.query:  # 原页面板用的小一号图，第一次请求时生成
                try:
                    w = int(parse_qs(url.query)["w"][0])
                except (KeyError, IndexError, ValueError):
                    w = 1000
                variant = pdfwork.page_variant(ws.root, rel, w)
                _prefetch_pages(ws.root, rel, w)  # 後面幾頁同一個寬度的圖先在背景做好，捲過去時不用等（一頁 100–240 ms）
                return self._file(variant or _derived_file(ws.root, rel), cache=True)
            if ws and rel.startswith("pages/"):  # 原頁圖（同步模式下在本機快取，見 paths.py）
                return self._file(_derived_file(ws.root, rel), cache=True)
            if ws and (rel.split("/", 1)[0] in ("figures", clips.DIR, supp.DIR) or rel == "source.pdf"):
                return self._file(_safe(ws.root, rel), cache=rel != "source.pdf")
            if ws and rel.startswith("extract/") and rel.endswith((".chars.json", ".txt")):  # PDF 文字層用的字元座標
                if app.location.status == "idle":
                    derive.extract(ws.root)
                return self._file(_derived_file(ws.root, rel), cache=True)
        return self._json(404, {"error": "not found"})

    # ---------- POST ----------
    def do_POST(self):
        if self.headers.get("X-Token") != self.app.token:  # 挡住别的网页跨站写
            return self._json(403, {"error": "bad token"})
        try:
            with self.app.location.request("POST", self.path):
                self._post()
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _presence(self):
        """页面开着就一直连着这条 WebSocket；断开就是页面关了（见 presence.py）。"""
        host = self.headers.get("Host") or ""
        if self.headers.get("Origin") not in (None, f"http://{host}"):  # 别的网站不能来占着
            self.close_connection = True
            return self._json(403, {"error": "bad origin"})
        p = self.app.presence
        self.app.location.enter_page()
        try:
            wsock.accept(self)
            self.close_connection = True
            wsock.hold(self)
        finally:
            if p:
                p.leave()

    def _post(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app, lib = self.app, self.app.lib

        if path in library_api.POST:
            return self._json(200, library_api.post(app, path, json.loads(self._body() or b"{}")))
        if path == "/api/sync/pull":  # 立即同步：馬上讀一次別台的筆記日誌、寫一次這台的心跳
            self._body()  # 請求體要讀掉：連線是保持著的，留在裡面會被當成下一個請求
            if paths.is_synced(lib.root):
                sync.pull_once(lib.root)
                cloudsync.beat(lib.root)
            cloudsync.roots(fresh=True)
            return self._json(200, cloudsync.report(lib.root, sync.status()))
        if path == "/api/sync/absorb":  # 把雲端硬碟裡走散的別的 EasyRead 文獻庫併進這一個（原資料夾不刪，留路標）
            self._body()
            if app.jobs.busy():
                raise ValueError(tr("还有翻译或 AI 任务在运行，请等任务结束再更改文献库位置"))
            advice = cloudsync.report(lib.root).get("advice") or {}
            if advice.get("kind") != "absorb":
                raise ValueError(tr("沒有需要合併的文獻庫"))
            results = [cloudsync.absorb(lib.root, Path(p)) for p in advice["paths"]]
            paths.forget()
            if paths.is_synced(lib.root):
                sync.pull_once(lib.root)
                cloudsync.beat(lib.root)
            return self._json(200, {"results": results, "copied": sum(len(r["copied"]) for r in results), "merged": sum(len(r["merged"]) for r in results),
                                    **cloudsync.report(lib.root, sync.status())})
        if path == "/api/notes":  # 新筆記
            body = json.loads(self._body() or b"{}")
            return self._json(200, notes.create(lib.root, str(body.get("title") or ""), str(body.get("body") or ""), body.get("papers"),
                                                style={k: body[k] for k in notes.STYLE_KEYS if k in body}))
        if path == "/api/notes-folder":  # 分類改名／刪掉（from、to）：放在裡面的筆記跟著改；或設分類的圖示顏色（name、icon、color）
            body = json.loads(self._body() or b"{}")
            if "name" in body:
                return self._json(200, {"folders": notes.set_folder_style(lib.root, str(body.get("name") or ""), body.get("icon"), body.get("color"))})
            changed = notes.rename_folder(lib.root, str(body.get("from") or ""), str(body.get("to") or ""))
            return self._json(200, {"changed": changed, "folders": notes.folder_styles(lib.root)})
        if path.startswith("/api/notes/"):
            bits = path.split("/")  # ['', 'api', 'notes', id, action?]
            nid, action = bits[3], bits[4] if len(bits) > 4 else ""
            if action == "clip":  # 貼進筆記的圖：請求體是圖片
                raw = self._body()
                return self._json(200, {"src": notes.clip(lib.root, nid, raw, self.headers.get("Content-Type") or "")})
            body = json.loads(self._body() or b"{}")
            if action == "delete":  # 挪到回收站；trash 是回收站裡的名字（復原用）
                name = notes.delete(lib.root, nid)
                return self._json(200, {"deleted": bool(name), "trash": name})
            if action == "duplicate":
                return self._json(200, notes.duplicate(lib.root, nid))
            if action == "append":  # 在最後接一段（閱讀頁的「加到筆記」）
                return self._json(200, notes.append(lib.root, nid, body.get("md") or "", body.get("paper") or ""))
            if action == "ai":  # 筆記 AI（edit / write），串流
                n = notes.get(lib.root, nid)
                if not n:
                    raise ValueError(tr("沒有這份筆記"))
                return notehelp.handle_note(self, body, n, notes.note_dir(lib.root, nid))
            if not action:
                style = {k: body[k] for k in notes.STYLE_KEYS if k in body}
                return self._json(200, notes.save(lib.root, nid, title=body.get("title") if "title" in body else None,
                                                  body=body.get("body") if "body" in body else None, papers=body.get("papers") if "papers" in body else None,
                                                  style=style or None))
            return self._json(404, {"error": "not found"})
        if path == "/api/update":  # 开关“自动检查新版本”
            config.save({"check_updates": bool(json.loads(self._body() or b"{}").get("enabled"))})
            return self._json(200, updates.check())
        if path == "/api/presence/keep":  # easyread serve 复用了关页会退出的服务：改成常驻
            if app.presence:
                app.presence.keep()
            return self._json(200, {"ok": True})
        if path == "/api/import":  # 请求体就是 PDF 文件
            data = self._body()
            ws, fresh = lib.create_from_pdf(data, q.get("name", "paper.pdf"))
            return self._import_result(ws, fresh, q.get("translate", "1") == "1", q.get("scope"),
                                       read=q.get("read") == "1", model=q.get("model", ""), target=q.get("target", ""), kind=q.get("kind", ""), tags=_tags(q.get("tags", "")))
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            return self._import_result(ws, fresh, bool(body.get("translate", True)), body.get("scope"),
                                       read=bool(body.get("read")), model=str(body.get("model") or ""), target=str(body.get("target") or ""), kind=str(body.get("kind") or ""), tags=_tags(body.get("tags")))
        if path in settings_api.POST:  # 设置页：保存配置、模型名单、试一下、取模型列表
            return self._json(200, settings_api.POST[path](json.loads(self._body() or b"{}")))
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
        if path == "/api/backdrop":
            return self._json(200, backdrop.save(json.loads(self._body() or b"{}")))
        if path == "/api/trash":  # 回收站：restore 恢复一篇 / purge 彻底删一篇 / empty 清空
            body = json.loads(self._body() or b"{}")
            act, name = body.get("action"), body.get("name", "")
            if act not in ("restore", "purge", "empty"):
                raise ValueError(tr("action 只能是 restore / purge / empty"))
            if act == "restore":
                return self._json(200, {"id": trash.restore(lib.root, name)})
            return self._json(200, {"deleted": trash.purge(lib.root, name) if act == "purge" else trash.empty(lib.root)})

        if path.startswith("/api/p/"):
            parts = path.split("/")
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": tr("没有这篇论文")})
            action = parts[4]
            if action == "clip":  # 給模型看的圖：請求體是圖片（貼進對話的），或 JSON {page, rect}（在原 PDF 上框選的一塊）
                raw = self._body()
                if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower().startswith("image/"):
                    return self._json(200, {"src": clips.save_upload(ws.root, raw)})
                spec = json.loads(raw or b"{}")
                return self._json(200, {"src": clips.region(ws.root, spec.get("page"), spec.get("rect"))})
            if action == "supp":  # 補充資料：請求體是 PDF（?name=檔名）就加一份；JSON {remove: 檔名} 是拿掉（supp.py）
                raw = self._body()
                if "name" in q:
                    supp.add(ws.root, raw, q.get("name", ""))
                else:
                    supp.remove(ws.root, str(json.loads(raw or b"{}").get("remove") or ""))
                preread.auto(ws)  # 補充資料變了：全文筆記重讀一次
                return self._json(200, preread.status(ws))
            body = json.loads(self._body() or b"{}")
            if action == "brief":  # 讓 AI 現在把整份讀一遍（start）、或停下來（cancel）
                if body.get("action") == "cancel":
                    preread.cancel(ws)
                else:
                    preread.start(ws, body.get("model") or None)
                return self._json(200, preread.status(ws))
            if action == "chat" and len(parts) > 5:
                sub, tid = parts[5], body.get("thread", "")
                if sub == "warm":  # 讀者打開面板、開始打字：先把模型行程拉起來（claude_live / codex_live），不連網、不花額度
                    ecfg, _ = chat_models.engine_cfg(config.load(), body.get("model"))
                    chat.warm(ecfg, ws.root, web=(bool(body["web"]) if "web" in body else webtools.enabled_default()) and webtools.supported(ecfg))
                    return self._json(200, {"ok": True})
                if sub == "pin":
                    chat_store.pin(ws, tid, body.get("id", ""))
                elif sub == "rename":
                    chat_store.rename(ws, tid, body.get("title", ""))
                elif sub == "delete":
                    chat_store.delete(ws, tid)
                return self._json(200, {"threads": chat_store.threads(ws)})
            if action == "chat":
                return self._chat(ws, body)
            if action == "notehelp":
                return notehelp.handle(self, ws, body)
            if action == "quick":
                if body.get("mode") == "warm":
                    return self._json(200, quick.warm(ws, body))
                return quick.handle(self, ws, body)
            if action == "discussion_del":
                return self._json(200, {"deleted": paperdata.delete_discussion(ws, str(body.get("id", "")))})
            if action == "ops":
                ops = body.get("ops") or []
                if not isinstance(ops, list):
                    raise ValueError(tr("ops 必须是数组"))
                res = ws.apply_reader_ops(ops, client=str(body.get("client", ""))[:40])
                res["versions"] = ws.versions()
                return self._json(200, res)
            if action == "item":
                if "cover" in body:  # 封面：{page, box} 是自己框的那一塊，其他的（null）＝恢復自動
                    body["cover"] = covers.clean(body["cover"])
                return self._json(200, ws.patch_item(body))
            if action == "translate":
                return self._json(200, translate_api.enqueue(app.jobs, ws, body))
            if action == "reveal":  # 在资源管理器 / 访达里打开这篇的文件夹
                _reveal(ws.root)
                return self._json(200, {"ok": True})
            if action == "cancel":
                app.jobs.cancel(ws.id)
                return self._json(200, {"ok": True})
            if action == "answer":
                return self._json(200, app.jobs.submit_small("answer", ws.id, note=body["note"]))
            if action == "retranslate":
                return self._json(200, app.jobs.submit_small("retranslate", ws.id, key=body["key"], hint=body.get("hint", "")))
            if action == "delete":
                app.jobs.cancel(ws.id)
                return self._json(200, {"trash": str(lib.trash(ws.id))})
        return self._json(404, {"error": "not found"})

