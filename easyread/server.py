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
from . import __version__, answer_styles, figures, chat, chat_models, chat_store, cli_models, clips, config, detect, engines, i18n, kinds, langs, notehelp, open_link, quick, paperdata, pdfwork, prefs, settings_api, trash, tw, library_api, translate_api, updates, usage, wsock, jobs, sync
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
    with _prefetch_lock:
        for k in range(n + 1, n + 1 + _PREFETCH_AHEAD):
            key = (str(root), k, w)
            nxt = f"pages/page-{k:03d}{ext}"
            if key in _prefetching or not (root / nxt).exists() or (paths.derived(root, "pages") / f"w{max(400, min(4000, w // 100 * 100))}" / f"page-{k:03d}{ext}").exists():
                continue
            _prefetching.add(key)
            todo.append((key, nxt))
    if not todo:
        return

    def go():
        for key, nxt in todo:
            try:
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

    # ---------- 输出 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: bool = False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
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
        self._send(200, path.read_bytes(), ctype, cache)

    def _redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _page(self, path: Path):
        self._send(200, i18n.inject(path.read_text(encoding="utf-8")).encode("utf-8"), "text/html; charset=utf-8")

    def _download(self, body: bytes, filename: str, ctype: str):
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
        prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs, answer_style=style, page=page,
                                  images=user.get("images"), mode=mode, aside=aside)
        # 模型行程还记着这个对话（claude_live / codex_live）：只送新问题；读者还指着同一处连位置上下文也省掉
        prev_turns = sum(1 for x in past if x.get("role") == "assistant")
        live = {"thread": tid, "turns": prev_turns}
        if prev_turns and chat.bound_turns(ecfg, ws, tid) == prev_turns:
            prev_user = next((x for x in reversed(past) if x.get("role") == "user"), None)
            same = chat.same_spot(prev_user, user, refs, page) and not images
            live["followup_text"] = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs, answer_style=style, page=page,
                                                images=user.get("images"), followup=True, with_context=not same, mode=mode, aside=aside)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cancel = threading.Event()
        pieces: list[str] = []
        meter = usage.Meter(ecfg["engine"])

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        try:
            send({"model": model, "thread": tid, "answer_style": style})
            def seen(actual):
                chat_models.remember(m.get("model", ""), actual)
                if m.get("engine") == "claude":
                    send({"model": chat_models.label(m)})
            guard = tw.Stream(tw.is_tw(langs.reply_code(ws.load("paper").get("meta"))))  # 繁體保險：模型夾帶的簡體字轉掉
            t0 = time.time()
            for piece in chat.stream(ecfg, prompt_text, ws.root, cancel, seen, meter, **({"images": images} if images else {}),
                                     live=live, on_live=lambda: send({"stream": "live"})):
                piece = guard.feed(piece)
                if piece:
                    if not pieces:  # 首字花了多久（終端機裡看得到；追問、預熱有沒有生效就看這個）
                        log.info("問 AI 首字 %.1f 秒（%s%s）", time.time() - t0, model, "，追問" if live.get("followup_text") else "")  # i18n-ok 終端機記錄
                    pieces.append(piece)
                    send({"t": piece})
            tail = guard.flush()
            if tail:
                pieces.append(tail)
                send({"t": tail})
            msg = chat_store.append(ws, tid, user, "".join(pieces), m["id"], model, meter.snapshot())
            send({"done": True, "id": msg["id"], "usage": msg.get("usage")})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            cancel.set()  # 读者点了停止或关了页面
            if pieces:
                chat_store.append(ws, tid, {**user, "note": None}, "".join(pieces) + "\n\n" + tr("（已停止）"), m["id"], model, meter.snapshot())
        except engines.Cancelled:
            pass
        except Exception as e:  # noqa: BLE001
            log.exception("对话出错 %s", ws.id)
            try:
                send({"error": str(e)[:500]})
            except OSError:
                pass

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_UPLOAD:
            raise ValueError(tr("文件太大"))
        return self.rfile.read(n) if n else b""

    def _import_result(self, ws, fresh, translate_after, scope, read=False, model="", target="", kind=""):
        # A failed first preparation still leaves a library entry. Re-importing
        # that PDF must retry preparation instead of silently skipping it.
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
        if path == "/open":  # 外部工具打开指定论文/段落；桌面版的 easyread://open 也转到这里 → 交給外殼開成分頁
            target = open_link.target(lib, parse_qs(url.query))
            return self._redirect("/?open=" + quote(target, safe="") if target != "/" else "/")
        if path == "/api/version":
            return self._json(200, open_link.version())
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache=path.startswith("/web/vendor/"))
        if path == "/api/presence" and wsock.is_upgrade(self.headers):
            return self._presence()
        location = library_api.get(app, path)
        if location is not None:
            return self._json(200, location)
        if path == "/api/sync":  # 文獻庫在同步資料夾時：合併了幾批、看過哪些電腦、有沒有雲端硬碟的衝突副本
            return self._json(200, {**sync.status(), "device": paths.device()})
        if path == "/api/library":
            cfg = config.load()
            return self._json(200, {"items": lib.list(), "token": app.token, "jobs": app.jobs.small_status(),
                                    "library_status": app.location.status, "other_device": app.location.marker.other_device(),
                                    "engine": cfg.get("engine"), "engine_label": cli_models.engine_label(cfg), "auto_translate": bool(cfg.get("auto_translate")),
                                    "first_run": config.is_first_run(), "version": __version__, "trash": len(trash.items(lib.root))})
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
        if path == "/api/chat/models":
            return self._json(200, chat_models.listing(config.load()))
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
            if ws and (rel.split("/", 1)[0] in ("figures", clips.DIR) or rel == "source.pdf"):
                return self._file(_safe(ws.root, rel), cache=rel != "source.pdf")
            if ws and rel.startswith("extract/") and rel.endswith((".chars.json", ".txt")):  # PDF 文字層用的字元座標
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
                                       read=q.get("read") == "1", model=q.get("model", ""), target=q.get("target", ""), kind=q.get("kind", ""))
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            return self._import_result(ws, fresh, bool(body.get("translate", True)), body.get("scope"),
                                       read=bool(body.get("read")), model=str(body.get("model") or ""), target=str(body.get("target") or ""), kind=str(body.get("kind") or ""))
        if path in settings_api.POST:  # 设置页：保存配置、模型名单、试一下、取模型列表
            return self._json(200, settings_api.POST[path](json.loads(self._body() or b"{}")))
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
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
            body = json.loads(self._body() or b"{}")
            if action == "chat" and len(parts) > 5:
                sub, tid = parts[5], body.get("thread", "")
                if sub == "warm":  # 讀者打開面板、開始打字：先把模型行程拉起來（claude_live / codex_live），不連網、不花額度
                    ecfg, _ = chat_models.engine_cfg(config.load(), body.get("model"))
                    chat.warm(ecfg, ws.root)
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

