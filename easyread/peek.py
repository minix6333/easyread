"""文件裡的連結，給閱讀頁的「預覽」用：指到引用編號、圖號、公式號，就地看那一筆參考文獻、那張圖，不用翻過去再翻回來。

links(root) → {"v": 1, "sig": …, "pages": {"<頁>": [連結, …]}, "refs": {"page": n, "y": y} 或 None, "appx": 同上}
- PDF 自己帶的內部跳轉（LaTeX 的 hyperref 會把引用、圖表、公式、章節編號都做成連結）：{"r": [x0, y0, x1, y1], "to": 頁, "y": y, "x": x}
  y、x 是跳過去那一點在目標頁的位置；有的 PDF 只說跳到哪一頁，就沒有。
- 外部網址：{"r": […], "u": "https://…"}
- 沒有內部連結的 PDF（投影片、講義、比較舊的論文）：從文字層找「Figure 3」「Table 2」「圖 3」這種字樣，
  連到同一份文件裡以它開頭的題注那一行：{"r": […], "to": 頁, "y": y, "m": "figure 3"}
- refs：參考文獻那一節的標題在哪一頁、哪個高度；appx：後面接著的附錄從哪裡開始。預覽用這兩個分辨「跳到參考文獻」還是「跳到附錄裡的圖」。
座標和文字層（extract/page-NNN.chars.json）一樣：按頁寬高歸一化、左上角原點，照 CropBox 和頁面旋轉換算過。
結果存在 extract/links.json（可重算，同步模式下在本機快取，不進雲端硬碟）；source.pdf 換了（大小、修改時間）就重算。
"""
from __future__ import annotations

import ctypes
import json
import re
import threading
from contextlib import closing
from pathlib import Path

from . import paths, pdfwork
from .log import log

VERSION = 2
MAX_PER_PAGE = 600  # 一頁最多記幾個連結（有的 PDF 每個字都是連結，記太多沒有意義）

_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}

# PDFium 的 FPDFDest_GetView 回傳的檢視方式
_FITH, _FITV, _FITR, _FITBH, _FITBV = 3, 4, 5, 7, 8
_ACTION_GOTO, _ACTION_URI = 1, 3

_REFS_HEAD = re.compile(r"^\s*(?:[0-9]+\.?|[ivxIVX]+\.)?\s*(references?|bibliography|literature cited|works cited|參考文獻|参考文献|引用文獻)\s*$", re.I)  # i18n-ok
# 內文提到圖表：Figure 3、Fig. 3a、Figs. 2、Table 2、Tab. 2、Algorithm 1、圖 3、表 2
_MENTION = re.compile(r"(?<![A-Za-z])(Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?|Alg(?:orithm)?\.?|圖|表)\s?(\d{1,3})(?![\d.]\d)", re.I)  # i18n-ok
# 題注：一行的開頭就是「Figure 3:」「Figure 3.」「Table 2 |」「圖 3：」，後面接著說明
_CAPTION = re.compile(r"^\s*(Fig(?:ure)?\.?|Tab(?:le)?\.?|Alg(?:orithm)?\.?|圖|表)\s?(\d{1,3})\s*(?:[:：.|]|\s+[A-Z(])", re.I)  # i18n-ok


def _kind(word: str) -> str:
    w = word.lower()
    if w.startswith("fig") or w == "圖":  # i18n-ok
        return "figure"
    if w.startswith("tab") or w == "表":  # i18n-ok
        return "table"
    return "algorithm"


def _lock(root: Path) -> threading.Lock:
    with _guard:
        return _locks.setdefault(str(root), threading.Lock())


def _sig(pdf: Path) -> str:
    st = pdf.stat()
    return f"{VERSION}:{st.st_size}:{st.st_mtime_ns}"


def links(root: Path) -> dict:
    """整份文件的連結（第一次算好存起來，之後直接讀）。"""
    root = Path(root)
    pdf = root / "source.pdf"
    if not pdf.is_file():
        return {"v": VERSION, "pages": {}, "refs": None}
    out = paths.derived(root, "extract") / "links.json"
    sig = _sig(pdf)
    cached = _read(out)
    if cached and cached.get("sig") == sig:
        return cached
    with _lock(root):
        cached = _read(out)
        if cached and cached.get("sig") == sig:
            return cached
        data = {"v": VERSION, "sig": sig, **compute(pdf, paths.derived(root, "extract"))}
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(out.name + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            tmp.replace(out)
        except OSError:
            log.exception("存不了連結表 %s", out)
        return data


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def compute(pdf: Path, extract_dir: Path | None = None) -> dict:
    pages: dict[str, list] = {}
    internal = 0
    try:
        with pdfwork.open_pdf(pdf) as doc:
            geo: dict[int, tuple] = {}

            def geometry(i: int):
                if i not in geo:
                    with closing(doc[i]) as page:
                        geo[i] = (page.get_bbox(), page.get_rotation())
                return geo[i]

            for i in range(len(doc)):
                with closing(doc[i]) as page:
                    found = _page_links(doc, page, i, geometry)
                if found:
                    pages[str(i + 1)] = found[:MAX_PER_PAGE]
                    internal += sum(1 for x in found if "to" in x)
    except Exception:  # noqa: BLE001  壞掉的 PDF：沒有連結就是了，預覽退回用文字找
        log.exception("讀不了 PDF 的連結 %s", pdf)
    lines = _all_lines(extract_dir) if extract_dir else {}
    if not internal and lines:
        for n, found in _mentions(lines).items():
            pages.setdefault(str(n), []).extend(found[:MAX_PER_PAGE])
    refs = _refs_start(lines)
    return {"pages": pages, "refs": refs, "appx": _appendix_start(lines, refs)}


def _point(x: float, y: float, bounds, rotation: int) -> tuple[float, float] | None:
    """目標頁上的一點（PDF 座標）換成按頁寬高歸一化、左上原點；超出頁面的夾回來（hyperref 的錨點常在那一行上面一點）。"""
    L, B, R, T = bounds
    if R <= L or T <= B:
        return None
    x = min(max(x, L), R)
    y = min(max(y, B), T)
    box = pdfwork._char_box((x - 1e-6, y - 1e-6, x + 1e-6, y + 1e-6), bounds, rotation)
    if not box:
        return None
    return round((box[0] + box[2]) / 2, 4), round((box[1] + box[3]) / 2, 4)


def _page_links(doc, page, index: int, geometry) -> list[dict]:
    from pypdfium2 import raw

    bounds, rotation = page.get_bbox(), page.get_rotation()
    found, pos, link = [], ctypes.c_int(0), raw.FPDF_LINK()
    while raw.FPDFLink_Enumerate(page.raw, ctypes.byref(pos), ctypes.byref(link)):
        rect = raw.FS_RECTF()
        if not raw.FPDFLink_GetAnnotRect(link, ctypes.byref(rect)):
            continue
        box = pdfwork._char_box((rect.left, min(rect.bottom, rect.top), rect.right, max(rect.bottom, rect.top)), bounds, rotation)
        if not box or box[2] - box[0] < .002 or box[3] - box[1] < .002:
            continue
        entry = {"r": box}
        dest = raw.FPDFLink_GetDest(doc.raw, link)
        action = None if dest else raw.FPDFLink_GetAction(link)
        if action:
            kind = raw.FPDFAction_GetType(action)
            if kind == _ACTION_URI:
                uri = _uri(doc, action)
                if uri:
                    entry["u"] = uri
                    found.append(entry)
                continue
            if kind == _ACTION_GOTO:
                dest = raw.FPDFAction_GetDest(doc.raw, action)
        if not dest:
            continue
        to = raw.FPDFDest_GetDestPageIndex(doc.raw, dest)
        if to < 0 or to >= len(doc):
            continue
        entry["to"] = to + 1
        spot = _dest_spot(dest)
        if spot:
            tb, tr = geometry(to)
            L, B, R, T = tb
            x, y = spot
            p = _point(L if x is None else x, T if y is None else y, tb, tr)
            if p:
                if y is not None:
                    entry["y"] = p[1]
                if x is not None:
                    entry["x"] = p[0]
        found.append(entry)
    return found


def _dest_spot(dest) -> tuple[float | None, float | None] | None:
    from pypdfium2 import raw

    has_x, has_y, has_z = raw.FPDF_BOOL(), raw.FPDF_BOOL(), raw.FPDF_BOOL()
    x, y, z = raw.FS_FLOAT(), raw.FS_FLOAT(), raw.FS_FLOAT()
    if raw.FPDFDest_GetLocationInPage(dest, ctypes.byref(has_x), ctypes.byref(has_y), ctypes.byref(has_z),
                                      ctypes.byref(x), ctypes.byref(y), ctypes.byref(z)) and (has_x.value or has_y.value):
        return (x.value if has_x.value else None, y.value if has_y.value else None)
    n = ctypes.c_ulong(4)
    params = (raw.FS_FLOAT * 4)()
    view = raw.FPDFDest_GetView(dest, ctypes.byref(n), params)
    if view in (_FITH, _FITBH) and n.value >= 1:
        return (None, params[0])
    if view in (_FITV, _FITBV) and n.value >= 1:
        return (params[0], None)
    if view == _FITR and n.value >= 4:
        return (params[0], params[3])
    return None


def _uri(doc, action) -> str:
    from pypdfium2 import raw

    size = raw.FPDFAction_GetURIPath(doc.raw, action, None, 0)
    if size <= 1 or size > 8192:
        return ""
    buf = ctypes.create_string_buffer(size)
    raw.FPDFAction_GetURIPath(doc.raw, action, buf, size)
    uri = buf.value.decode("utf-8", "replace").strip()
    return uri if re.match(r"^(https?://|mailto:)", uri, re.I) else ""


# ---------- 文字層：一行一行 ----------

def _all_lines(extract_dir: Path) -> dict[int, list[dict]]:
    out = {}
    for f in sorted(Path(extract_dir).glob("page-*.chars.json")):
        m = re.match(r"page-(\d+)\.chars\.json$", f.name)
        if not m:
            continue
        try:
            chars = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out[int(m.group(1))] = lines_of(chars)
    return out


def lines_of(chars: list) -> list[dict]:
    """字元串成行（和 pdftext.js 的切法一樣的想法）：垂直範圍重疊、x 接著前一個字就是同一行。
    每行 {"t": 文字, "b": [x0, y0, x1, y1], "i": [每個字在 t 裡的位置對應的字元框]}。"""
    lines, cur = [], None
    for c in chars:
        if not isinstance(c, list) or len(c) < 5:
            continue
        ch, x0, y0, x1, y1 = c[:5]
        if not (y1 > y0) or x1 < x0:
            continue
        h, w = y1 - y0, max(x1 - x0, .004)
        if cur:
            overlap = min(y1, cur["b"][3]) - max(y0, cur["b"][1])
            same = overlap >= .4 * min(h, cur["b"][3] - cur["b"][1]) and cur["b"][2] - w * 1.5 <= x0 <= cur["b"][2] + w * 3
        else:
            same = False
        if not same:
            cur = {"t": "", "b": [x0, y0, x1, y1], "i": []}
            lines.append(cur)
        elif cur["i"]:
            last = cur["i"][-1]
            gap = x0 - last[2]
            if gap > max(last[2] - last[0], w) * .28 and not ch.isspace() and not cur["t"].endswith(" ") and not re.match(r"[㐀-鿿]", ch + cur["t"][-1:]):  # i18n-ok
                cur["t"] += " "
                cur["i"].append([last[2], last[1], x0, last[3]])
        cur["t"] += ch
        cur["i"].append([x0, y0, x1, y1])
        b = cur["b"]
        cur["b"] = [min(b[0], x0), min(b[1], y0), max(b[2], x1), max(b[3], y1)]
    return [ln for ln in lines if ln["t"].strip()]


def _refs_start(lines: dict[int, list[dict]]) -> dict | None:
    """參考文獻的標題那一行。目錄裡也可能出現 References，所以取文件前三成以後的第一個；沒有就取最後一個。"""
    hits = [(n, ln) for n in sorted(lines) for ln in lines[n] if len(ln["t"]) <= 40 and _REFS_HEAD.match(ln["t"])]
    if not hits:
        return None
    total = max(lines)
    later = [h for h in hits if h[0] >= total * .3]
    n, ln = (later or hits[-1:])[0]
    return {"page": n, "y": round(ln["b"][1], 4)}


_APPX_HEAD = re.compile(r"^\s*(?:(?:appendix|appendices|supplementary (?:material|materials|information))\b|[A-H](?:\.\d+)?\s{1,3}[A-Z][A-Za-z])", re.I)


def _appendix_start(lines: dict[int, list[dict]], refs: dict | None) -> dict | None:
    """參考文獻後面接著的附錄（「A Examples of …」「Appendix B」）從哪裡開始：跳到這之後的就不是參考文獻了。
    標題的字比內文大一點，用行高分辨，免得把「A. Smith, …」這種條目當成標題。"""
    if not refs:
        return None
    body = sorted(ln["b"][3] - ln["b"][1] for n in lines for ln in lines[n] if len(ln["t"]) > 40)
    if not body:
        return None
    med = body[len(body) // 2]
    for n in sorted(lines):
        if n < refs["page"]:
            continue
        for ln in lines[n]:
            if n == refs["page"] and ln["b"][1] <= refs["y"] + .001:
                continue
            if len(ln["t"]) <= 90 and ln["b"][3] - ln["b"][1] >= med * 1.12 and _APPX_HEAD.match(ln["t"]):
                return {"page": n, "y": round(ln["b"][1], 4)}
    return None


def _mentions(lines: dict[int, list[dict]]) -> dict[int, list[dict]]:
    """沒有內部連結時：內文提到 Figure 3，就連到「Figure 3:」開頭的題注。"""
    captions: dict[str, tuple[int, float]] = {}
    for n in sorted(lines):
        for ln in lines[n]:
            m = _CAPTION.match(ln["t"])
            if m:
                key = _kind(m.group(1)) + " " + m.group(2)
                captions.setdefault(key, (n, round(ln["b"][1], 4)))
    if not captions:
        return {}
    out: dict[int, list[dict]] = {}
    for n in sorted(lines):
        for ln in lines[n]:
            cap = _CAPTION.match(ln["t"])
            for m in _MENTION.finditer(ln["t"]):
                if cap and m.start() == cap.start(1):
                    continue  # 題注自己
                key = _kind(m.group(1)) + " " + m.group(2)
                if key not in captions:
                    continue
                boxes = ln["i"][m.start():m.end()]
                if not boxes:
                    continue
                to, y = captions[key]
                r = [round(min(b[0] for b in boxes), 4), round(min(b[1] for b in boxes), 4),
                     round(max(b[2] for b in boxes), 4), round(max(b[3] for b in boxes), 4)]
                out.setdefault(n, []).append({"r": r, "to": to, "y": y, "m": key})
    return out
