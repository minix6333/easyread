"""看圖讀頁：有的文件整頁是圖（掃描的講義、截圖貼成的作業、做成圖片的投影片），或字型沒有對應表、抽出來是亂碼，
AI 就讀不到那一頁。這裡挑出這種頁，請能看圖的模型照實轉成文字（題目照抄、公式寫成 TeX、表格、圖在畫什麼），存起來；
之後問 AI、問整個文獻庫、全文搜尋、預讀用的都是這份文字（docmap.page_texts、search._paper_pages、chat._page_text 疊上去）。

- 哪些頁要看（scan）：抽得出的字很少、但頁面上有東西；或內容圖片佔了一大塊、字又不多；
  或抽出來是亂碼（字型沒有對應表：`! #"%$'&() *,+.-"/0214`——字數很多，但英文字母兩兩相連幾乎都不像英文）。
  每一頁都在同一個位置的圖（投影片的底圖、頁首的商標）不算內容，先排除——不然整份投影片都會被當成圖。
- 存在文件資料夾的 vision.json（跟著同步，另一台不用再看一次）：
  {"v": 1, "sig": PDF 的指紋, "scan": [要看的頁], "pages": {"3": "…"}, "model": "…", "at": "…"}
- 什麼時候看：問 AI 時（chat）先看這一問用得到、還沒看過的頁（不多就整份），畫面上說「正在看第幾頁的圖」；
  其餘的放在背景（預讀時也會先看完，最多 AUTO_PAGES 頁；再多的等讀者問到那幾頁再看）。
"""
from __future__ import annotations

import hashlib
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import chat_models, chat_options, config, derive, kinds, langs, paths, tw
from .log import log
from .prompts import localize
from .store import Workspace, dir_lock, now_iso, read_json, write_json_atomic

FILE = "vision.json"
VERSION = 1
BATCH = 3          # 一次請模型看幾頁（圖多一次會慢、也容易漏）
WORKERS = 2        # 同時送幾個請求（背景）
NOW_WORKERS = 3    # 讀者在等的時候：同時送幾個
NOW_PAGES = 12     # 問的時候當場看的上限（讀者在等）
AUTO_PAGES = 40    # 背景自動看的上限；再多就等讀者問到那幾頁
LATER_DOCS = 4     # 問一個分類／整個文獻庫時，當場看不完的：一問最多排幾份到背景
SCAN_VERSION = 2   # 判斷的方法改了就加一：每台電腦上量過的快取重量一次
_MEANING = re.compile(r"[A-Za-z0-9㐀-䶿一-鿿぀-ヿ가-힯]")  # i18n-ok 字元範圍
# 英文裡常見的兩個字母連在一起（約 300 組）。正常的英文頁（含公式、程式、表格）有七成以上的字母對在這裡面；
# 亂碼頁（字型沒有對應表）只有兩三成到五成
_PAIRS = frozenset(
    "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea "
    "ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly nc et ut ss so rs un lo wa ge ie "
    "wh ee wi em ad ol rt po we ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu ev ld ry mp fe bl ab gh "
    "ty op wo sa ay ex ke fr oo av ag if ap gr od bo sp rd do uc bu ei ov by rm ep tt oc fa ef cu rn sc gi da yo cr cl du ga "
    "qu ue ff ba ey ls va um pp ua up lu go ht ru ug ds lt pi rc rr eg au ck ew mu br bi pt ak pu ui rg ib tl ny ki rk ys ob "
    "mm fu ph og ms ye ud mb ip ub oi rl gu dr hr cc tw ft wn nu af hu nn eo vo rv nf xp gn sm fl iz ok nl my gl aw ju oa eq "
    "sy sl ps jo rf dd ox ze ii cy".split())
_sig_cache: dict[str, tuple[tuple, str]] = {}
_data_cache: dict[str, tuple[tuple, dict]] = {}
_lock = threading.Lock()
_running: set[str] = set()
_gate = threading.Semaphore(1)  # 背景一次只看一份（範圍裡好幾份都有圖片頁時，不要一次送出十幾個請求）
_root_locks: dict[str, threading.Lock] = {}


def _pdf(root: Path) -> Path:
    return Path(root) / "source.pdf"


def signature(root: Path) -> str:
    """PDF 的指紋：大小＋開頭 1 MB 的雜湊（兩台電腦上同一個檔案一樣；換了檔案就不一樣）。"""
    pdf = _pdf(root)
    try:
        st = pdf.stat()
    except OSError:
        return ""
    key = (st.st_size, st.st_mtime_ns)
    with _lock:
        hit = _sig_cache.get(str(pdf))
        if hit and hit[0] == key:
            return hit[1]
    with open(pdf, "rb") as f:
        sig = f"{st.st_size:x}-" + hashlib.sha1(f.read(1 << 20)).hexdigest()[:16]
    with _lock:
        _sig_cache[str(pdf)] = (key, sig)
    return sig


def load(root: Path) -> dict:
    """這份文件看圖讀出來的東西；PDF 換過了就當沒有。照檔案的修改時間快取（每一頁的文字都會來問一次）。"""
    f = Path(root) / FILE
    try:
        st = f.stat()
    except OSError:
        return {}
    key = (st.st_size, st.st_mtime_ns)
    with _lock:
        hit = _data_cache.get(str(f))
    if hit and hit[0] == key:
        data = hit[1]
    else:
        data = read_json(f, {}) or {}
        with _lock:
            if len(_data_cache) > 2000:
                _data_cache.clear()
            _data_cache[str(f)] = (key, data)
    if not isinstance(data, dict) or data.get("v") != VERSION or data.get("sig") != signature(root):
        return {}
    return data


def stamp(root: Path) -> tuple:
    """vision.json 的修改時間：別人拿來當快取的一部分（看了新的頁，搜尋的快取就要換）。"""
    try:
        st = (Path(root) / FILE).stat()
        return (st.st_size, st.st_mtime_ns)
    except OSError:
        return ()


def text(root: Path, n: int) -> str:
    return str((load(root).get("pages") or {}).get(str(n)) or "")


def overlay(root: Path, n: int, extracted: str) -> str:
    """第 n 頁給 AI、搜尋用的文字：看圖讀過的就用讀出來的（它把頁面上的字也抄了），沒有就是抽取的字——
    抽出來是亂碼的當作沒有字（給 AI 只是浪費篇幅，還會讓它以為那一頁在講別的）。"""
    seen = text(root, n)
    if seen.strip():
        return seen
    return "" if garbled(extracted) else extracted


def _extracted(root: Path, total: int) -> list[str]:
    d = derive.extract(Path(root))
    out = []
    for n in range(1, total + 1):
        p = d / f"page-{n:03d}.txt"
        try:
            out.append(p.read_text(encoding="utf-8", errors="replace") if p.exists() else "")
        except OSError:
            out.append("")
    return out


def _measure(root: Path) -> list[dict]:
    """每一頁：有意義的字有幾個、內容圖片佔頁面多少（扣掉每頁都一樣的底圖）、頁面上有幾個物件。"""
    import pypdfium2.raw as c
    from contextlib import closing
    from . import pdfwork
    rows, boxes = [], []
    with pdfwork.open_pdf(_pdf(root)) as doc:
        total = len(doc)
        for i in range(total):
            with closing(doc[i]) as page:
                w, h = page.get_size()
                imgs = []
                for obj in page.get_objects(filter=[c.FPDF_PAGEOBJ_IMAGE], max_depth=3):
                    l, b, r, t = obj.get_bounds()
                    l, r, b, t = max(0.0, l), min(w, r), max(0.0, b), min(h, t)
                    if r > l and t > b:
                        try:  # 圖本身的內容（原始資料的開頭）：同一張底圖每頁一樣；掃描的每頁位置一樣、內容不一樣
                            raw = obj.get_data(decode_simple=False)
                            digest = hashlib.md5(bytes(raw[:65536])).hexdigest()[:12]
                        except Exception:  # noqa: BLE001
                            digest = ""
                        imgs.append((round(l), round(b), round(r), round(t), digest))
                objs = sum(1 for _ in page.get_objects(max_depth=1))
                rows.append({"area": w * h, "imgs": imgs, "objs": objs})
                boxes.append(set(imgs))
    # 底圖：同一個位置、同一張圖（內容一樣）出現在一半以上的頁（至少三頁）。只看位置的話，整份掃描（每頁一張全頁圖）也會被當成底圖
    count: dict[tuple, int] = {}
    for bs in boxes:
        for b in bs:
            count[b] = count.get(b, 0) + 1
    template = {b for b, k in count.items() if b[4] and k >= 3 and k >= 0.5 * len(boxes)}
    texts = _extracted(root, len(rows))
    out = []
    for r, t in zip(rows, texts):
        cover = sum((b[2] - b[0]) * (b[3] - b[1]) for b in r["imgs"] if b not in template) / max(1.0, r["area"])
        out.append({"chars": len(_MEANING.findall(t)), "cover": min(1.0, cover), "objs": r["objs"], "garbled": garbled(t)})
    return out


def garbled(text: str) -> bool:
    """抽出來的字是不是亂碼：英文字母兩兩相連，像英文的不到六成。至少要有 24 對、20 種不同的才判斷——
    字太少看不出來；種類很少的是同幾個字母一直重複（DNA 序列 ACGT、一排 xxxx），不是亂碼。
    德、法、西、印尼文、程式碼、參考文獻都在七成以上（見 tests/test_pagevision.py）。"""
    runs = re.findall(r"[A-Za-z]{2,}", text or "")
    pairs = [r[i:i + 2].lower() for r in runs for i in range(len(r) - 1)]
    if len(pairs) < 24 or len(set(pairs)) < 20:
        return False
    return sum(p in _PAIRS for p in pairs) / len(pairs) < 0.6


def needs_vision(m: dict) -> bool:
    """這一頁要不要看圖：字幾乎沒有但頁面上有東西；內容圖片佔四分之一以上、字又不多；或整頁幾乎都是圖。"""
    chars, cover, objs = m["chars"], m["cover"], m["objs"]
    if m.get("garbled"):
        return True
    if chars < 40 and (cover > 0.05 or objs > 10):
        return True
    if cover >= 0.25 and chars < 400:
        return True
    return cover >= 0.6 and chars < 1200


def scan(root: Path) -> list[int]:
    """要看圖才讀得到的頁（1 起算）。量一次記在這台電腦的快取（paths.derived；PDF 沒換就不再量），
    不寫進文件資料夾——大部分文件一頁都沒有，不用在雲端硬碟上每一份都多一個檔案。"""
    root = Path(root)
    sig = signature(root)
    if not sig:
        return []
    cache = paths.derived(root, "extract") / "vision-scan.json"
    data = read_json(cache, {}) or {}
    if isinstance(data, dict) and data.get("sig") == sig and data.get("v") == SCAN_VERSION and isinstance(data.get("pages"), list):
        return [int(n) for n in data["pages"]]
    try:
        pages = [i for i, m in enumerate(_measure(root), 1) if needs_vision(m)]
    except Exception:  # noqa: BLE001 —— 量不了（PDF 壞了、被鎖住）：當作沒有，下次再量
        log.exception("看圖讀頁：量頁面失敗 %s", root)  # i18n-ok 記錄
        return []
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(cache, {"v": SCAN_VERSION, "sig": sig, "pages": pages})
    except OSError:
        pass
    return pages


def missing(root: Path, within=None) -> list[int]:
    """要看圖、但還沒看過的頁；within：只看這幾頁。"""
    seen = load(root).get("pages") or {}
    pages = [n for n in scan(root) if str(n) not in seen]
    if within is not None:
        want = set(within)
        pages = [n for n in pages if n in want]
    return pages


def _save(root: Path, change) -> None:
    root = Path(root)
    with dir_lock(paths.lock_dir(root)):
        data = read_json(root / FILE, {}) or {}
        sig = signature(root)
        if not isinstance(data, dict) or data.get("v") != VERSION or data.get("sig") != sig:
            data = {"v": VERSION, "sig": sig, "pages": {}}
        change(data)
        write_json_atomic(root / FILE, data)


def vision_cfg(model: str | None = None) -> dict | None:
    """看圖用的模型設定（預設是問 AI 的那個）；看不了圖的（沒開「能看圖」的 API）回 None。思考強度低：照抄不用想太多。"""
    cfg = config.load()
    try:
        ecfg, _m = chat_models.engine_cfg(cfg, model)
    except Exception:  # noqa: BLE001
        return None
    engine = ecfg.get("engine")
    if engine == "openai" and not ecfg["openai"].get("vision"):
        return None
    if engine not in ("claude", "codex", "openai"):
        return None
    if engine in ("claude", "codex"):
        try:
            chat_options.apply(ecfg, {"reasoning_effort": "low"})
        except ValueError:
            pass
    return ecfg


ASK = (
    "下面附上{noun}《{title}》第 {pages} 頁的圖片（照這個順序）。這幾頁的字沒辦法直接從 PDF 抽出來（是圖、截圖、掃描，或抽出來是亂碼），"  # i18n-ok 提示詞
    "請把每一頁上的內容照實轉成文字，讓沒看到圖的人也知道這一頁寫了什麼：\n"  # i18n-ok 提示詞
    "- 所有的字照原文抄，不要翻譯、不要改寫、不要摘要；題號、編號、標題、段落照原本的順序。\n"  # i18n-ok 提示詞
    "- 數學式寫成 TeX：行內用 $…$，獨立一行的用 $$…$$。\n"  # i18n-ok 提示詞
    "- 表格寫成 Markdown 表格。\n"  # i18n-ok 提示詞
    "- 圖、示意圖、照片：用一兩句說它畫了什麼（座標軸、標記、箭頭、各部分的關係）。\n"  # i18n-ok 提示詞
    "- 看不清楚的地方寫「（看不清楚）」，不要猜。\n"  # i18n-ok 提示詞
    "不要解題、不要加說明、不要客套。每一頁用單獨一行「=== 第 N 頁 ===」開頭（N 是上面說的頁碼），接著寫那一頁的內容。"  # i18n-ok 提示詞
)
_HEAD = re.compile(r"^\s*=+\s*第\s*(\d{1,4})\s*[頁页]\s*=+\s*$", re.M)  # i18n-ok


def parse(out: str, pages: list[int]) -> dict[int, str]:
    """模型的回答 → {頁碼: 那一頁的文字}；沒照格式（只送一頁時）就整段當那一頁。"""
    found = list(_HEAD.finditer(out or ""))
    res: dict[int, str] = {}
    for k, m in enumerate(found):
        n = int(m.group(1))
        body = out[m.end(): found[k + 1].start() if k + 1 < len(found) else len(out)].strip()
        if n in pages and body:
            res[n] = body
    if not found and len(pages) == 1 and (out or "").strip():
        res[pages[0]] = out.strip()
    return res


def _batch(root: Path, pages: list[int], ecfg: dict, cancel: threading.Event) -> dict[int, str]:
    from . import chat  # chat 也 import 這個模組（_page_text），放在這裡避免互相 import
    ws = Workspace(Path(root))
    meta = (ws.load("paper") or {}).get("meta") or {}
    images = [str(p) for p in (derive.page_image(Path(root), n) for n in pages) if p]
    if len(images) != len(pages):
        return {}
    label = "、".join(str(n) for n in pages)  # i18n-ok 提示詞裡的頁碼
    code = langs.reply_code(meta)
    prompt = ASK.format(noun=kinds.noun(kinds.of(meta)), title=meta.get("title_en") or meta.get("title_zh") or "", pages=label)
    prompt = localize(prompt if tw.is_tw(code) else tw.to_cn(prompt), code)
    out = "".join(chat.stream(ecfg, prompt, Path(root), cancel, images=images, live={"tools": ""}))
    return parse(out, pages)


def read(root: Path, pages: list[int], ecfg: dict, cancel: threading.Event | None = None, on_progress=None, workers: int = WORKERS) -> int:
    """看這幾頁（分批、同時送 workers 批），讀出來的存進 vision.json；回傳讀到幾頁。on_progress(看完的頁數, 全部)。"""
    root = Path(root)
    pages = sorted(set(int(n) for n in pages))
    if not pages:
        return 0
    cancel = cancel or threading.Event()
    groups = [pages[i:i + BATCH] for i in range(0, len(pages), BATCH)]
    got = 0
    done = 0

    def one(group):
        if cancel.is_set():
            return {}
        try:
            return _batch(root, group, ecfg, cancel)
        except Exception as e:  # noqa: BLE001 —— 一批沒讀成不影響其他批；下次問到再試
            log.warning("看圖讀頁失敗 %s 第 %s 頁：%s", root.name, group, e)  # i18n-ok 記錄
            return {}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for group, res in zip(groups, pool.map(one, groups)):
            done += len(group)
            if res:
                got += len(res)
                _save(root, lambda d, res=res: (d.setdefault("pages", {}).update({str(n): t for n, t in res.items()}),
                                                 d.update(model=str((ecfg.get(ecfg.get("engine")) or {}).get("model") or ecfg.get("engine")), at=now_iso())))
            if on_progress:
                on_progress(done, len(pages))
    if got:
        log.info("看圖讀頁 %s：讀了 %d 頁", root.name, got)  # i18n-ok 記錄
    return got


def busy(root: Path) -> bool:
    """背景正在看這一份（問答時就不再看一次，等它看完）。"""
    with _lock:
        return str(Path(root)) in _running


def _root_lock(root: Path) -> threading.Lock:
    with _lock:
        return _root_locks.setdefault(str(root), threading.Lock())


def read_all(root: Path, model: str | None = None, cancel: threading.Event | None = None, limit: int = AUTO_PAGES) -> int:
    """背景用：把還沒看的頁看完（最多 limit 頁；再多就等讀者問到）。同一份同時只有一個在看（預讀前的和背景的不會各看一次），
    所有文件一次只看一份；用一般速度（背景工作不搶 Fast）。"""
    root = Path(root)
    with _root_lock(root):
        with _lock:
            _running.add(str(root))
        try:
            with _gate:
                todo = missing(root)  # 排隊的時候可能已經在問答時看過了
                if not todo or len(scan(root)) > limit:
                    return 0
                ecfg = vision_cfg(model)
                if not ecfg:
                    return 0
                if ecfg.get("engine") in ("codex", "openai") and ecfg[ecfg["engine"]].get("service_tier") == "fast":
                    ecfg[ecfg["engine"]]["service_tier"] = "default"
                return read(root, todo, ecfg, cancel)
        finally:
            with _lock:
                _running.discard(str(root))


def start(root: Path, limit: int = AUTO_PAGES) -> bool:
    """在背景把還沒看的頁看完（見 read_all）。已經在看、或沒有要看的就不開。"""
    root = Path(root)
    if not missing(root) or len(scan(root)) > limit:
        return False
    with _lock:
        if str(root) in _running:
            return False
        _running.add(str(root))

    def go():
        try:
            read_all(root, limit=limit)
        except Exception:  # noqa: BLE001
            log.exception("看圖讀頁（背景）出錯 %s", root)  # i18n-ok 記錄
    threading.Thread(target=go, daemon=True, name="vision-" + root.name).start()
    return True


_PAGE_REF = re.compile(r"(?:第\s*(\d{1,4})\s*[頁页])|(?:\b[Pp](?:age|\.)\s*(\d{1,4})\b)")  # i18n-ok


def wanted(root: Path, page: int | None, question: str) -> list[int]:
    """這一問用得到、還沒看過的頁：不多（NOW_PAGES 以內）就整份；多的話是讀者正在看的那一頁前後、問題裡提到的那幾頁。"""
    todo = missing(root)
    if not todo:
        return []
    if len(todo) <= NOW_PAGES:
        return todo
    near = set()
    if page:
        near |= {page - 1, page, page + 1}
    for m in _PAGE_REF.finditer(question or ""):
        near.add(int(m.group(1) or m.group(2)))
    return [n for n in todo if n in near][:6]
