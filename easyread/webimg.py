"""回答裡的網路圖片（```pic 區塊）：模型只說「要哪個條目的圖、圖上要看什麼」，這裡到維基百科／維基共享資源找一張，連出處一起交給頁面。

為什麼不讓模型自己貼圖片網址：
- 模型記得的圖片網址常常是錯的或編的，貼出來多半是破圖；
- 任意網址等於讓回答能向外面任何主機發請求——文件裡要是藏了惡意的指示，就能把內容夾在網址裡帶出去。
  這裡只連這幾個地方：en.wikipedia.org 和 commons.wikimedia.org（查）、upload.wikimedia.org／thumb.wikimedia.org（拿圖），網址是查回來再檢查過的。
- 維基共享資源的圖都有授權和作者，可以照規定註明出處。

找法：
1. 模型給了英文維基百科的條目名：拿那個條目用到的圖（編者挑過的，最相關），去掉圖示、標誌那些，再照「要看什麼」的關鍵詞排序；
2. 模型給了共享資源的檔名：直接拿那一張（檔名對不上就當沒給）；
3. 都沒有、或上面找不到：用關鍵詞到共享資源搜尋，只留檔名／說明裡真的提到關鍵詞的（不然「Adagrad」會找到一張演講者的照片）。
找不到就回空的，頁面什麼都不放。查到的結果和下載的圖都放在 HOME/cache/webimg/（不進文獻庫、不進雲端硬碟）。
設定 → 模型 可以整個關掉（config["web_images"]）。
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from . import VERSION, config, http
from .log import log
from .store import read_json, write_json_atomic

WIKI = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
IMG_PREFIXES = ("https://upload.wikimedia.org/wikipedia/commons/", "https://thumb.wikimedia.org/wikipedia/commons/")  # 原圖／現做的縮圖
PAGE_PREFIXES = ("https://commons.wikimedia.org/wiki/", "https://en.wikipedia.org/wiki/")  # 圖的說明頁（出處連到這裡）
UA = f"FOLI/{VERSION} (https://github.com/minix6333/easyread; reading app, on-demand illustration lookup)"
WIDTH = 960            # 要多寬的縮圖（共享資源會現做；SVG 也是給 PNG）
MAX_BYTES = 8_000_000  # 一張圖最多下載這麼多
KEEP_OK = 30 * 86400   # 查到的結果記多久
KEEP_EMPTY = 86400     # 沒查到的記一天（條目之後可能有圖了）
MAX_ITEMS = 6
_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "png", "image/webp": "webp"}
# 條目裡常見、但不是內容的圖：維基的圖示、標誌、維護模板用的小圖
_JUNK = re.compile(r"(?i)\b(icon|logo|ambox|question[ _]book|symbol|commons-logo|wiki(letter|tionary|quote|source|books|versity|data|media)?[ _-]|"
                   r"edit-|padlock|folder|portal|nuvola|crystal[ _]clear|disambig|stub|text[ _]document|emblem|flag[ _]of|ooui|oojs|red[ _]pog|"
                   r"increase2|decrease2|steady2|loudspeaker|speaker[ _]icon|sound-icon)")
_STOP = frozenset("""the a an of and or in on for to with by from at as is are be this that these those its it into over under between
diagram illustration image picture figure schematic example examples showing shows show overview visualization visualisation plot graph chart
model models method methods algorithm algorithms concept using used use how what""".split())


def enabled() -> bool:
    return config.load().get("web_images", True) is not False


def _dir() -> Path:
    d = config.CACHE_DIR / "webimg"
    d.mkdir(parents=True, exist_ok=True)
    return d


def words_of(q: str) -> list[str]:
    """「要看什麼」→ 拿來比對的關鍵詞（小寫、去掉虛詞和「diagram」這類每張圖都能套的字）。"""
    out: list[str] = []
    for w in re.findall(r"[a-z][a-z0-9\-]{2,}|[一-鿿]{2,}", (q or "").lower()):  # i18n-ok 漢字範圍
        w = w.strip("-")
        if w and w not in _STOP and w not in out:
            out.append(w)
    return out


def plain(s, limit: int = 160) -> str:
    """extmetadata 裡的 Artist、ImageDescription 是 HTML：只留文字。"""
    if isinstance(s, dict):
        s = s.get("value")
    s = html.unescape(re.sub(r"<[^>]+>", " ", str(s or "")))
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[:limit - 1].rstrip() + "…"


def candidate(page: dict, shared_only: bool = False) -> dict | None:
    """API 回來的一頁（一張圖）→ 頁面要的那幾樣；不是能用的圖回 None。"""
    title = str(page.get("title") or "")
    name = title.split(":", 1)[1] if ":" in title else title
    info = (page.get("imageinfo") or [None])[0]
    if not name or not isinstance(info, dict):
        return None
    if shared_only and page.get("imagerepository") not in ("shared", None):  # 英文維基自己存的多半是合理使用的圖，不能隨便再用
        return None
    mime = info.get("mime") or ""
    thumb = str(info.get("thumburl") or info.get("url") or "").split("?", 1)[0]  # 後面那串 utm_… 是維基自己的統計用參數，不需要
    w, h = int(info.get("thumbwidth") or info.get("width") or 0), int(info.get("thumbheight") or info.get("height") or 0)
    full_w, full_h = int(info.get("width") or 0), int(info.get("height") or 0)
    if mime not in _MIME or not thumb.startswith(IMG_PREFIXES) or min(full_w, full_h) < 140 or max(full_w, full_h) < 240 or _JUNK.search(name):
        return None
    if w and h and not (0.2 <= w / h <= 5):  # 長條的橫幅、分隔線
        return None
    meta = info.get("extmetadata") or {}
    where = str(info.get("descriptionurl") or "")
    if not where.startswith(PAGE_PREFIXES):  # 出處那一頁會變成頁面上的連結：只認維基自己的網址，不然自己照檔名組一個
        where = "https://commons.wikimedia.org/wiki/File:" + urllib.parse.quote(name.replace(" ", "_"))
    return {"name": name, "src": thumb, "w": w, "h": h, "page": where, "mime": mime,
            "artist": plain(meta.get("Artist"), 80), "license": plain(meta.get("LicenseShortName"), 40),
            "license_url": plain(meta.get("LicenseUrl"), 200), "desc": plain(meta.get("ImageDescription"), 220)}


def score(item: dict, words: list[str]) -> float:
    """這張圖和關鍵詞對得上多少（0–1）：檔名裡有算整分，只在說明裡有算半分。"""
    if not words:
        return 0.0
    flat = lambda t: re.sub(r"[\s_\-.]+", " ", str(t or "")).lower()  # noqa: E731 —— 檔名裡的底線、連字號和空白當成同一種（k-means／K_means）
    name, desc = flat(item.get("name")), flat(item.get("desc"))
    got = 0.0
    for w in words:
        stem = flat(w[:-1] if len(w) > 4 and w.endswith("s") else w)
        got += 1.0 if stem in name else 0.5 if stem in desc else 0.0
    return got / len(words)


def rank(items: list[dict], words: list[str], lead: str = "", need: float = 0.0, topic: list[str] | None = None) -> list[dict]:
    """排序：先看「要看什麼」的關鍵詞對得上多少，再看條目名的詞（topic，占一半：檔名裡有條目名的多半就是講它的圖），條目的代表圖再加一點；
    need > 0 時，關鍵詞分數低於它的不要（搜尋來的才設）。分數一樣的維持原來的先後。"""
    scored = []
    for i, it in enumerate(items):
        s = score(it, words)
        if need and s < need:
            continue
        is_lead = bool(lead) and it["name"].replace("_", " ") == lead.replace("_", " ")
        scored.append((-(s + 0.5 * score(it, topic or []) + (0.3 if is_lead else 0.0)), i, it))
    return [it for _, _, it in sorted(scored, key=lambda x: (x[0], x[1]))]


def _api(base: str, params: dict) -> dict:
    url = base + "?" + urllib.parse.urlencode({"action": "query", "format": "json", "formatversion": "2", **params})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with http.urlopen(req, timeout=8) as r:
        return json.loads(r.read(4_000_000))


_INFO = {"prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": WIDTH,
         "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl|ImageDescription"}


def _pages(d: dict) -> list[dict]:
    pages = (d.get("query") or {}).get("pages") or []
    if isinstance(pages, dict):  # formatversion 1 的樣子
        pages = list(pages.values())
    return sorted(pages, key=lambda p: p.get("index", 0))


def lookup(article: str = "", q: str = "", file: str = "") -> list[dict]:
    """連網去找（不看快取）。回傳排好的候選，最多 MAX_ITEMS 張；找不到是空的。網路出錯往外抛。"""
    words = words_of(q)
    out: list[dict] = []
    seen: set[str] = set()

    def add(items):
        for it in items:
            if it and it["src"] not in seen and len(out) < MAX_ITEMS:
                seen.add(it["src"])
                out.append(it)
    file = re.sub(r"^(file|image)\s*:\s*", "", (file or "").strip(), flags=re.I)
    if file:
        add(candidate(p) for p in _pages(_api(COMMONS, {"titles": "File:" + file, **_INFO})) if not p.get("missing"))
    if article.strip():
        d = _api(WIKI, {"titles": article.strip(), "redirects": 1, "generator": "images", "gimlimit": 50, **_INFO})
        items = [c for c in (candidate(p, shared_only=True) for p in _pages(d)) if c]
        lead = ""
        if items:
            try:
                lp = _pages(_api(WIKI, {"titles": article.strip(), "redirects": 1, "prop": "pageimages", "piprop": "name"}))
                lead = str((lp[0] if lp else {}).get("pageimage") or "")
            except Exception:  # noqa: BLE001 —— 代表圖只是加分用
                pass
        add(rank(items, words, lead, topic=words_of(article)))
    if not out and words:
        d = _api(COMMONS, {"generator": "search", "gsrsearch": " ".join(words) + " filetype:bitmap|drawing", "gsrnamespace": 6, "gsrlimit": 12, **_INFO})
        add(rank([c for c in (candidate(p) for p in _pages(d)) if c], words, need=0.5))
    return out


def find(article: str = "", q: str = "", file: str = "") -> dict:
    """給頁面用：{"items": [...]}（可能是空的）。查過的記在快取裡；網路不通時有舊的就用舊的。"""
    article, q, file = (article or "").strip()[:120], (q or "").strip()[:200], (file or "").strip()[:160]
    if not (article or q or file):
        return {"items": []}
    key = hashlib.sha1(json.dumps([article.lower(), q.lower(), file.lower()], ensure_ascii=False).encode()).hexdigest()[:20]
    path = _dir() / f"q-{key}.json"
    old = read_json(path, None)
    if isinstance(old, dict) and time.time() - float(old.get("at") or 0) < (KEEP_OK if old.get("items") else KEEP_EMPTY):
        return {"items": old.get("items") or []}
    try:
        items = lookup(article, q, file)
    except Exception as e:  # noqa: BLE001 —— 沒網路、維基那邊出錯：有舊的用舊的，沒有就當沒找到（不記，下次再試）
        log.info("找網路圖片沒成功（%s／%s）：%s", article, q, str(e)[:160])  # i18n-ok 終端機記錄
        return {"items": (old or {}).get("items") or [], "error": True}
    write_json_atomic(path, {"at": time.time(), "article": article, "q": q, "file": file, "items": items})
    return {"items": items}


def _looks_like(data: bytes, ext: str) -> bool:
    """開頭那幾個位元組是不是這種圖檔。"""
    if ext == "png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == "jpg":
        return data.startswith(b"\xff\xd8\xff")
    if ext == "gif":
        return data[:6] in (b"GIF87a", b"GIF89a")
    return ext == "webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def fetch(url: str) -> Path | None:
    """把一張縮圖抓到快取裡（抓過的直接給）。只認共享資源的圖檔網址；別的一律不抓。"""
    if not isinstance(url, str) or not url.startswith(IMG_PREFIXES) or ".." in url or "?" in url or "#" in url or "\\" in url:
        return None
    ext = url.rsplit(".", 1)[-1].lower()
    ext = {"jpeg": "jpg"}.get(ext, ext)
    if ext not in ("png", "jpg", "gif", "webp"):
        return None
    out = _dir() / (hashlib.sha1(url.encode()).hexdigest()[:24] + "." + ext)
    if out.exists() and out.stat().st_size > 0:
        return out
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with http.urlopen(req, timeout=15) as r:
            data = r.read(MAX_BYTES + 1)
    except Exception as e:  # noqa: BLE001
        log.info("網路圖片下載失敗：%s", str(e)[:160])  # i18n-ok 終端機記錄
        return None
    if not data or len(data) > MAX_BYTES or not _looks_like(data, ext):  # 回來的不是圖（錯誤頁之類）：不存，不然之後每次都給那個壞檔
        return None
    tmp = out.with_suffix(out.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(out)
    return out
