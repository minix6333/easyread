/* 示意圖：AI 的回答裡 ```viz 區塊寫的一小段受限 HTML，畫成卡片（比較幾種做法、各階段、數量對比、簡單曲線）。
   模型能用的部件寫在 chat.py 的 VIZ：viz（外框）、row / panel（並排的格子）、cells（一排排小方塊，data-map）、arrow、big、bar、cap、note、tag、hl，
   加上少數行內標籤、表格和簡單的 svg。這裡做兩件事：
   - 過濾（PR.vizClean）：只留允許的標籤和屬性，其他一律丟掉——沒有 script、style、圖片、連結、事件屬性，也不會去連外面的網址。
   - 展開：cells 的 data-map 變成一格一格；svg 裡的箭頭標記換成這張圖自己的 id；文字裡的 $TeX$ 交給 PR.md。
   PR.vizHtml(src) 回傳可以直接放進頁面的 HTML（markup.js 用）；純函式的部分（PR.vizCells）有測試：tests/test_viz.cjs。 */
(function (PR) {
  "use strict";
  const HTML_TAGS = new Set(["div", "p", "span", "b", "strong", "i", "em", "u", "small", "br", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "sub", "sup", "code"]);
  const RENAME = { h1: "h4", h2: "h4", h3: "h4", section: "div", article: "div", figure: "div", figcaption: "p", header: "div", footer: "div", label: "span" };
  const SVG_TAGS = new Set(["svg", "g", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text", "tspan", "title"]);
  const SVG_NUM = new Set(["x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "dx", "dy", "font-size", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]);
  const CLASS_OK = /^[\w\- ]{1,80}$/;
  const MAX_SRC = 20000, MAX_CELLS = 600, MAX_NODES = 900;
  const cache = new Map();
  let seq = 0;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* 純函式：data-map → {cols, cells: [類別…]}。1 亮、0 暗、2 3 是另外兩種顏色、x 劃掉、. 或 _ 空一格；/ 或換行是下一排 */
  PR.vizCells = function (map) {
    const rows = String(map || "").split(/[\/\n|]+/).map((r) => r.replace(/[^0-9a-zA-Z._]/g, "")).filter(Boolean);
    const cols = Math.min(24, rows.reduce((m, r) => Math.max(m, r.length), 0));
    const cells = [];
    const KIND = { "0": "c0", "1": "c1", "2": "c2", "3": "c3", x: "cx", X: "cx", ".": "sp", _: "sp" };
    for (const r of rows) {
      for (let i = 0; i < cols; i++) {
        if (cells.length >= MAX_CELLS) break;
        cells.push(i < r.length ? KIND[r[i]] || "c1" : "sp");
      }
    }
    return { cols, cells };
  };

  function styleOf(el) {
    // 只認兩個自訂屬性：--v（橫條長度 0–100）、--cols（一排幾格）
    const out = [];
    const s = el.getAttribute("style") || "";
    const v = /--v\s*:\s*(-?[\d.]+)/.exec(s);
    if (v) out.push("--v:" + Math.max(0, Math.min(100, parseFloat(v[1]) || 0)));
    const c = /--cols\s*:\s*(\d+)/.exec(s);
    if (c) out.push("--cols:" + Math.max(1, Math.min(24, +c[1])));
    return out.length ? ' style="' + out.join(";") + '"' : "";
  }
  const cls = (el) => { const c = (el.getAttribute("class") || "").trim(); return c && CLASS_OK.test(c) ? ' class="' + c + '"' : ""; };

  function svgAttrs(el, tag, st) {
    let out = cls(el);
    for (const a of Array.from(el.attributes)) {
      const k = a.name.toLowerCase(), v = a.value.trim();
      if (k === "class" || k.startsWith("on")) continue;
      if (SVG_NUM.has(k) && /^-?[\d.]+(%|px|em)?$/.test(v)) out += " " + k + '="' + v + '"';
      else if (k === "viewbox" && /^[-\d.\s,]+$/.test(v)) out += ' viewBox="' + v + '"';
      else if ((k === "d" || k === "points") && /^[\w\s.,\-+]+$/.test(v) && v.length < 4000) out += " " + k + '="' + v + '"';
      else if (k === "transform" && /^[\w\s.,\-+()]+$/.test(v) && v.length < 200) out += ' transform="' + v + '"';
      else if ((k === "text-anchor" || k === "dominant-baseline" || k === "stroke-linecap" || k === "stroke-linejoin" || k === "font-weight") && /^[\w-]+$/.test(v)) out += " " + k + '="' + v + '"';
      else if (k === "stroke-dasharray" && /^[\d.\s,]+$/.test(v)) out += ' stroke-dasharray="' + v + '"';
      else if ((k === "fill" || k === "stroke") && /^(none|currentcolor)$/i.test(v)) out += " " + k + '="' + v + '"';
      else if ((k === "marker-end" || k === "marker-start") && /^url\(#[\w-]+\)$/.test(v)) out += " " + k + '="url(#' + st.arrow + ')"';
    }
    if (tag === "svg" && !/viewBox=/.test(out)) out += ' viewBox="0 0 320 160"';
    return out;
  }

  function walk(node, st, inSvg) {
    if (st.n++ > MAX_NODES) return "";
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      if (!t.trim()) return /\s/.test(t) ? " " : "";
      const flat = t.replace(/\s+/g, " ");  // 原始碼裡的換行、縮排不是內容
      return inSvg || !PR.md ? esc(flat) : PR.md(flat, { cite: false, xref: false });
    }
    if (node.nodeType !== 1) return "";
    let tag = node.tagName.toLowerCase();
    if (inSvg || tag === "svg") {
      if (!SVG_TAGS.has(tag)) return "";
      const kids = Array.from(node.childNodes).map((c) => walk(c, st, true)).join("");
      if (tag !== "svg") return "<" + tag + svgAttrs(node, tag, st) + ">" + kids + "</" + tag + ">";
      const body = kids;
      const attrs = svgAttrs(node, tag, st);
      const defs = /url\(#/.test(body) ? '<defs><marker id="' + st.arrow + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fill"/></marker></defs>' : "";
      return "<svg" + attrs + ' xmlns="http://www.w3.org/2000/svg">' + defs + body + "</svg>";
    }
    tag = RENAME[tag] || tag;
    if (!HTML_TAGS.has(tag)) {
      // 不認得的標籤：script、style 這類整個丟掉；其餘只留裡面的字
      if (/^(script|style|iframe|object|embed|link|meta|img|video|audio|canvas|form|input|button|textarea|select|template|noscript)$/.test(tag)) return "";
      return Array.from(node.childNodes).map((c) => walk(c, st, false)).join("");
    }
    if (tag === "br") return "<br>";
    const c = (node.getAttribute("class") || "");
    if (tag === "div" && /(^|\s)cells(\s|$)/.test(c)) {
      const g = PR.vizCells(node.getAttribute("data-map") || node.textContent);
      if (!g.cols) return "";
      return '<div class="cells" style="--cols:' + g.cols + '">' + g.cells.map((k) => '<i class="' + k + '"></i>').join("") + "</div>";
    }
    let attrs = cls(node) + styleOf(node);
    if (tag === "td" || tag === "th") for (const k of ["colspan", "rowspan"]) { const v = node.getAttribute(k); if (v && /^\d{1,2}$/.test(v)) attrs += " " + k + '="' + v + '"'; }
    return "<" + tag + attrs + ">" + Array.from(node.childNodes).map((x) => walk(x, st, false)).join("") + "</" + tag + ">";
  }

  /* 過濾＋展開：回傳乾淨的 HTML；最外層不是 .viz 就包一層 */
  PR.vizClean = function (src) {
    src = String(src || "").slice(0, MAX_SRC);
    if (typeof DOMParser === "undefined") return "<pre><code>" + esc(src) + "</code></pre>";
    const doc = new DOMParser().parseFromString("<!doctype html><body>" + src, "text/html");  // 這樣解析出來的文件不會執行 script、不會載入資源
    const st = { n: 0, arrow: "viz-arr-" + (++seq) };
    let html = Array.from(doc.body.childNodes).map((n) => walk(n, st, false)).join("").trim();
    if (!html) return "";
    if (!/^<div class="viz[\s"]/.test(html)) html = '<div class="viz">' + html + "</div>";
    return html;
  };

  PR.vizHtml = function (src) {
    if (cache.has(src)) return cache.get(src);
    let html;
    try { html = PR.vizClean(src); } catch (e) { html = ""; }
    if (!html) html = "<pre><code>" + esc(src) + "</code></pre>";
    if (cache.size > 200) cache.clear();
    cache.set(src, html);
    return html;
  };
})(window.PR);
