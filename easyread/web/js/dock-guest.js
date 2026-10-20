/* 放進右邊外部工具欄那個 AI 網頁裡的一小段程式（ChatGPT、Claude、Gemini…）。dock-ai.js 在它每次載好時用
   webview.executeJavaScript 放進去；它看不到 FOLI 的任何東西，只做這幾件事，而且不動那個網站的畫面結構
   （不包、不搬它的元素——它們是 React／Angular 管的，動了會在重畫時壞掉）：
   1. 換底色（skinCss）：找出它中性灰的表面色——根節點上的顏色變數、蓋住一大片畫面的區塊——把整組明暗平移到 FOLI 面板的顏色，
      越接近文字的顏色動得越少，文字色不動。算出來的 CSS 交回給 FOLI，由 FOLI 用 insertCSS 放上去（不受網站的 CSP 限制）。
   2. 回答裡的頁碼（第 5 頁、p. 5、pp. 3–4、第 3 張投影片）用 CSS 的「自訂標示」（Highlight API：只標範圍，不改 DOM）標成強調色，
      滑過去是手指，點了請 FOLI 翻到那一頁。
   3. 讀者送出問題時先攔一下，請 FOLI 附上正在讀的那一頁，傳完再替讀者送出（hold 開著時；外部工具欄的迴紋針裡可以關）；
      找讀者在 ChatGPT／Claude 建好的「FOLI」專案（findProject），FOLI 讓新對話從那個專案開始。
   4. 一則一則的訊息：滑過去右上角有「書籤」「存成筆記」兩顆小按鈕（#foli-tools，放在 body 最後，不碰網站自己的元素），
      有書籤的那幾則左邊一條線（data-foli-mark 屬性）；在回答裡選字冒出「問這句」（#foli-ask），點了在漂浮小視窗另外問；
      transcript() 把整段對話轉成 Markdown（漂浮小視窗附上它，接著原本的對話問）。
   5. 給 FOLI 叫的幾個函式：找輸入框並聚焦（回傳位置，附檔時拖到那裡）、讀選取的字、讀最後一則回答（都轉成 Markdown，公式還原成 TeX）。
   對 FOLI 說話：console.debug("⁣foli:" + JSON)，FOLI 在 webview 的 console-message 收（只接受翻頁、重新配色、要送出了這幾種）。
   不靠 DOM 的部分（頁碼的格式、顏色換算）放在 pure，tests/test_dock_guest.cjs 測。 */
(function (root) {
  "use strict";
  const VERSION = 3;

  /* ---------- 純函式 ---------- */
  // 頁碼：中文「第 5 頁／第 3–5 頁／第 3 至 5 頁」、「第 5 張投影片」「投影片第 5 張」；英文「p. 5」「pp. 3–4」「page 12」「pages 3-4」「slide 7」。
  // 「p5」「p-value」「p < 0.05」不算：p 後面要有點或空白再接數字
  const REFS = [
    /第\s*(\d{1,4})\s*(?:[-–—~～至到]\s*(?:第\s*)?(\d{1,4})\s*)?[頁页]/g,  // i18n-ok 比對用
    /第\s*(\d{1,4})\s*(?:[-–—~～至到]\s*(\d{1,4})\s*)?張投影片/g,  // i18n-ok
    /投影片\s*第?\s*(\d{1,4})(?:\s*[-–—~～至到]\s*(\d{1,4}))?\s*張?/g,  // i18n-ok
    /(?:^|[^A-Za-z])((?:pp?\.|pages?|slides?)\s*(\d{1,4})(?!\d)(?:\s*[-–—]\s*(\d{1,4})(?!\d))?)(?![.,]\d)/gi,
  ];
  function pageRefs(text, max) {
    const out = [];
    const s = String(text || "");
    for (let k = 0; k < REFS.length; k++) {
      const re = REFS[k];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        let start = m.index, len = m[0].length, a = m[1], b = m[2];
        if (k === 3) { start = m.index + m[0].indexOf(m[1]); len = m[1].length; a = m[2]; b = m[3]; }  // 英文：前面那個不是字母的字元不算在連結裡
        const from = parseInt(a, 10), to = b ? parseInt(b, 10) : from;
        if (!(from >= 1) || (max && from > max) || to < from || to - from > 50) continue;
        if (out.some((r) => start < r.start + r.len && r.start < start + len)) continue;  // 和前面認到的重疊（「第 5 頁」也長得像別的格式）
        out.push({ start, len, page: from, to });
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }
  // 顏色：sRGB（0–255）⇄ OKLab（L 0–1）。表面色的明暗平移在 OKLab 的 L 上做，看起來才均勻
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const gam = (c) => { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, c)) * 255); };
  function toLab(rgb) {
    const r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function toRgb(lab) {
    const l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
    const m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
    const s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2], 3);
    return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
  }
  // 一個中性的表面色要換成什麼：網站的底色（site）對到 FOLI 的面板色（ours），往文字那邊走到邊界（深色 0.5、淺色 0.8）就不動；
  // 中間照比例，整組的深淺順序不變。邊界外的（文字、圖示的顏色）、有顏色的（按鈕、連結）都不換：回傳 null
  function remap(lab, site, ours, dark) {
    const chroma = Math.hypot(lab[1], lab[2]);
    if (chroma > 0.035) return null;
    const L = lab[0], s = site[0], o = ours[0];
    let w;  // 1：就是底色；0：到邊界，不動
    if (dark) {
      const B = 0.5;
      if (L >= B || s >= B) return null;
      w = L <= s ? 1 : (B - L) / (B - s);
    } else {
      const B = 0.8;
      if (L <= B || s <= B) return null;
      w = L >= s ? 1 : (L - B) / (s - B);
    }
    const nl = L + (o - s) * w;
    return [nl, lab[1] + (ours[1] - site[1]) * w, lab[2] + (ours[2] - site[2]) * w];
  }
  const pure = { pageRefs, toLab, toRgb, remap, VERSION };
  if (typeof module !== "undefined" && module.exports) { module.exports = pure; return; }
  if (root.__foliGuest && root.__foliGuest.v === VERSION) return;  // 已經放過了（同一頁又叫一次）

  /* ---------- 在網頁裡 ---------- */
  const say = (msg) => { try { console.debug("⁣foli:" + JSON.stringify(msg)); } catch (e) { /* 不能說就算了 */ } };
  let opts = { pages: 0 };
  const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width < 40 || r.height < 12) return false; const cs = getComputedStyle(e); return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05; };

  /* 顏色字串（#hex、rgb()、oklch()、color-mix()…）→ [r, g, b, a]：交給瀏覽器畫一格再讀回來，什麼寫法都認得 */
  let cv = null;
  function parse(str) {
    if (!str || /^(transparent|none|inherit|initial|unset|currentcolor)$/i.test(str.trim())) return null;
    if (!cv) { const c = document.createElement("canvas"); c.width = c.height = 1; cv = c.getContext("2d", { willReadFrequently: true }); }
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = "#010203";
    cv.fillStyle = str;
    if (cv.fillStyle === "#010203" && !/010203/.test(str)) return null;  // 不是顏色
    cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  const css = (rgb) => "rgb(" + rgb[0] + " " + rgb[1] + " " + rgb[2] + ")";
  function siteBase() {  // 網站的底色：body／html 的，透明的話找蓋住最多畫面的那一塊
    for (const e of [document.body, document.documentElement]) { const c = e && parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0.98) return c; }
    let best = null, area = 0;
    for (const e of document.querySelectorAll("body > *, body > * > *, main")) {
      const r = e.getBoundingClientRect(), a = r.width * r.height, c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0.98 && a > area) { best = c; area = a; }
    }
    return best;
  }

  /* 換底色：回傳要放上去的 CSS（FOLI 用 insertCSS 放）。o：{ base: "rgb(…)", dark: bool, accent: "rgb(…)" } */
  let marked = 0;
  function skinCss(o) {
    const base = siteBase(), ours = parse(o && o.base);
    if (!base || !ours) return "";
    const dark = !!o.dark, site = toLab(base), our = toLab(ours);
    const swap = (str) => { const c = parse(str); if (!c || c[3] < 0.98) return null; const n = remap(toLab(c), site, our, dark); return n ? css(toRgb(n)) : null; };
    const rules = [];
    // 1. 根節點、body 上的顏色變數（ChatGPT 的是雜湊過的名字、Claude 是 --cds-surface-1、Gemini 是 --gem-sys-color--surface…）
    for (const [sel, el] of [[":root", document.documentElement], ["body", document.body]]) {
      if (!el) continue;
      const cs = getComputedStyle(el), decl = [];
      for (let i = 0; i < cs.length; i++) {
        const n = cs[i];
        if (!n.startsWith("--")) continue;
        const v = cs.getPropertyValue(n).trim();
        if (!v || v.length > 60 || /^(var|calc)\(|\d(px|rem|em|%|s|ms)\b|^\d+$/i.test(v)) continue;
        const nv = swap(v);
        if (nv) decl.push(n + ":" + nv + " !important");
      }
      if (decl.length) rules.push("html " + (sel === ":root" ? "" : "body") + "{" + decl.join(";") + "}");
    }
    // 2. 蓋住一大片畫面、自己寫死底色的區塊：做記號（屬性，不動它的 class 和 style），用屬性選擇器換
    for (const e of document.querySelectorAll("[data-foli-skin]")) e.removeAttribute("data-foli-skin");
    const W = innerWidth, H = innerHeight, seen = {};
    marked = 0;
    for (const e of document.querySelectorAll("html, body, body *")) {
      if (marked > 400) break;
      const r = e.getBoundingClientRect();
      if (r.width < W * 0.5 || r.height < 40) continue;  // 只換大塊的：小的（按鈕、清單項目）留著它自己的滑過效果
      const bg = getComputedStyle(e).backgroundColor;
      if (!bg || bg === "rgba(0, 0, 0, 0)") continue;
      const key = bg;
      if (!(key in seen)) seen[key] = swap(bg);
      if (!seen[key]) continue;
      e.setAttribute("data-foli-skin", String(Object.keys(seen).indexOf(key)));
      marked++;
    }
    Object.keys(seen).forEach((k, i) => { if (seen[k]) rules.push('[data-foli-skin="' + i + '"]{background-color:' + seen[k] + " !important}"); });
    return rules.join("\n");
  }

  /* ---------- 回答裡的頁碼 ---------- */
  const SKIP = "textarea, input, [contenteditable='true'], [contenteditable=''], code, pre, script, style, svg, button, nav, header";
  let hits = [];  // [{range, page, to}]
  function scanRefs() {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    const found = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\d/.test(n.nodeValue) && /[頁页張片pPsS]/.test(n.nodeValue) && !(n.parentElement && n.parentElement.closest(SKIP)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),  // i18n-ok
    });
    for (let n = walker.nextNode(); n && found.length < 400; n = walker.nextNode()) {
      for (const r of pageRefs(n.nodeValue, opts.pages)) {
        const range = document.createRange();
        range.setStart(n, r.start);
        range.setEnd(n, r.start + r.len);
        found.push({ range, page: r.page, to: r.to });
      }
    }
    hits = found;
    if (found.length) CSS.highlights.set("foli-page", new Highlight(...found.map((h) => h.range)));
    else CSS.highlights.delete("foli-page");
  }
  let scanT = 0, lastScan = 0;
  function scanSoon() {  // 回答一邊流出來一邊改：停下來 0.5 秒才掃；一直在流的話最多兩秒掃一次
    clearTimeout(scanT);
    const wait = Date.now() - lastScan > 2000 ? 60 : 500;
    scanT = setTimeout(() => { lastScan = Date.now(); (window.requestIdleCallback || setTimeout)(scanRefs); }, wait);
  }
  function hitAt(x, y) {
    if (!hits.length) return null;
    let node = null, off = 0;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
    else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
    if (!node) return null;
    for (const h of hits) {
      if (h.range.startContainer !== node || off < h.range.startOffset || off > h.range.endOffset) continue;
      const b = h.range.getBoundingClientRect();  // 游標在那幾個字的框裡才算（點在行尾空白處，最近的字也可能是它）
      if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) return h;
    }
    return null;
  }
  let handT = 0;
  document.addEventListener("mousemove", (e) => {
    if (handT) return;
    handT = setTimeout(() => { handT = 0; }, 40);
    document.documentElement.classList.toggle("foli-hand", !!hitAt(e.clientX, e.clientY));
  }, true);
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || (getSelection() && String(getSelection()))) return;
    const h = hitAt(e.clientX, e.clientY);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    say({ t: "page", page: h.page, to: h.to });
  }, true);

  /* ---------- 轉成 Markdown（存成筆記用）：公式從 KaTeX 的 annotation、Gemini 的 data-math 還原成 TeX ---------- */
  function md(node, depth) {
    depth = depth || 0;
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, " ");
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    const el = node.nodeType === 1 ? node : null;
    const kids = () => Array.from(node.childNodes).map((c) => md(c, depth)).join("");
    if (!el) return kids();
    const tag = el.tagName.toLowerCase();
    if (/^(script|style|svg|button|noscript|template|textarea|input|select)$/.test(tag) || el.getAttribute("aria-hidden") === "true") return "";
    if (el.classList.contains("katex") || el.hasAttribute("data-math")) {  // 公式：KaTeX 的原式在 annotation 裡，Gemini 的在 data-math
      const ann = el.classList.contains("katex") && el.querySelector('annotation[encoding="application/x-tex"]');
      const tex = ann ? ann.textContent : el.getAttribute("data-math");
      if (tex == null) return (el.querySelector(".katex-mathml") || el).textContent;
      const block = !!el.closest(".katex-display, .math-block") || el.classList.contains("math-block");
      return block ? "\n\n$$" + tex.trim() + "$$\n\n" : "$" + tex.trim() + "$";
    }
    if (el.classList.contains("katex-display")) { const k = el.querySelector(".katex"); return k ? md(k, depth) : ""; }
    switch (tag) {
      case "br": return "\n";
      case "hr": return "\n\n---\n\n";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "\n\n" + "#".repeat(+tag[1]) + " " + kids().trim() + "\n\n";
      case "strong": case "b": { const t = kids(); return t.trim() ? "**" + t.trim() + "**" : t; }
      case "em": case "i": { const t = kids(); return t.trim() ? "*" + t.trim() + "*" : t; }
      case "code": return el.closest("pre") ? el.textContent : "`" + el.textContent + "`";
      case "pre": {
        const code = el.querySelector("code") || el, lang = ((code.className || "").match(/language-([\w+-]+)/) || [])[1] || "";
        return "\n\n```" + lang + "\n" + code.textContent.replace(/\n+$/, "") + "\n```\n\n";
      }
      case "a": { const h = el.getAttribute("href") || "", t = kids().trim(); return /^https?:/i.test(h) && t ? "[" + t + "](" + h + ")" : t; }
      case "img": { const s = el.getAttribute("src") || ""; return /^https?:/i.test(s) ? "![" + (el.getAttribute("alt") || "") + "](" + s + ")" : ""; }
      case "ul": case "ol": {
        let i = 0;
        const items = Array.from(el.children).filter((c) => c.tagName === "LI").map((li) => {
          i++;
          const body = Array.from(li.childNodes).map((c) => md(c, depth + 1)).join("").replace(/\n{2,}/g, "\n").trim();
          return "  ".repeat(depth) + (tag === "ol" ? i + ". " : "- ") + body.replace(/\n/g, "\n" + "  ".repeat(depth + 1));
        });
        return "\n" + items.join("\n") + "\n\n";
      }
      case "blockquote": return "\n\n" + kids().trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
      case "table": {
        const rows = Array.from(el.querySelectorAll("tr")).map((tr) => Array.from(tr.children).map((c) => md(c, depth).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()));
        if (!rows.length) return "";
        const n = Math.max(...rows.map((r) => r.length));
        const line = (r) => "| " + Array.from({ length: n }, (_, k) => r[k] || "").join(" | ") + " |";
        return "\n\n" + [line(rows[0]), "| " + Array(n).fill("---").join(" | ") + " |"].concat(rows.slice(1).map(line)).join("\n") + "\n\n";
      }
      case "p": case "div": case "section": case "article": case "li": case "figure": case "figcaption": return "\n\n" + kids() + "\n\n";
      default: return kids();
    }
  }
  const tidy = (s) => String(s || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  function selection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).cloneRange(), host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    if (host && host.closest("textarea, input, [contenteditable='true'], [contenteditable='']")) return null;  // 選的是輸入框裡自己打的字
    // 選到一半的公式：把範圍撐到整個公式（只複製到 KaTeX 裡面的一部分的話，原式 annotation 不在裡面）。撐的是複本，讀者選的不動
    const math = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest(".katex-display, .katex, [data-math]"); };
    const m1 = math(r.startContainer), m2 = math(r.endContainer);
    if (m1) r.setStartBefore(m1);
    if (m2) r.setEndAfter(m2);
    const box = document.createElement("div");
    box.append(r.cloneContents());
    return { text: String(sel).trim(), md: tidy(md(box)) || String(sel).trim(), question: question(host) };
  }

  /* ---------- 最後一則回答：各家標記回答的方式不一樣，先試認得的，認不到就回 null（FOLI 會請讀者選起來再存） ---------- */
  const ANSWERS = ['[data-message-author-role="assistant"]', '[data-testid="assistant-message"]', ".font-claude-response", ".font-claude-message", "model-response", ".model-response-text"];
  const ASKS = ['[data-message-author-role="user"]', '[data-testid="user-message"]', "user-query", ".user-query-container", ".query-text"];
  function lastOf(list) {
    let best = null;
    for (const sel of list) for (const e of document.querySelectorAll(sel)) if (!best || (best.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) best = e;
    return best;
  }
  function question(before) {  // 在這個位置之前、最近的那一則讀者自己問的
    let best = null;
    for (const sel of ASKS) for (const e of document.querySelectorAll(sel)) {
      if (before && !(e.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (!best || (best.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) best = e;
    }
    return best ? tidy(best.innerText || best.textContent).slice(0, 2000) : "";
  }
  function lastAnswer() {
    const a = lastOf(ANSWERS);
    if (!a) return null;
    return { md: tidy(md(a)), text: tidy(a.innerText || a.textContent), question: question(a) };
  }

  /* ---------- 輸入框 ---------- */
  const COMPOSERS = ["#prompt-textarea", "textarea#mobile-composer-prompt", "div.ProseMirror[contenteditable='true']", "rich-textarea .ql-editor", ".ql-editor[contenteditable='true']"];
  function composer() {
    let best = null, score = -1;
    const known = new Set();
    for (const sel of COMPOSERS) for (const e of document.querySelectorAll(sel)) known.add(e);
    for (const e of document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable=''], [role='textbox']")) {
      if (/captcha/i.test(e.id || "") || e.closest("[aria-hidden='true']") || !visible(e)) continue;
      const r = e.getBoundingClientRect();
      const s = (known.has(e) ? 1e6 : 0) + r.bottom * 2 + r.width;  // 認得的優先；不然挑最下面、最寬的那個（各家的對話框都在下面）
      if (s > score) { best = e; score = s; }
    }
    return best;
  }
  function focusComposer() {
    const e = composer();
    if (!e) return null;
    e.focus();
    if (e.tagName === "TEXTAREA") e.setSelectionRange(e.value.length, e.value.length);
    else { const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height, 60) / 2), empty: !(e.value || e.textContent || "").trim() };
  }

  /* ---------- 送出問題時，先讓 FOLI 附上正在讀的那一頁 ---------- */
  // 讀者在輸入框按 Enter 或按送出鈕：先攔下來（hold 開著時），請 FOLI 把那一頁的圖（問整份時加上 PDF）放進上傳欄位，
  // 等它傳完、送出鈕能按了，再替讀者按送出。FOLI 1.5 秒內沒說收到、或一分鐘還沒好，就照常送出：問題不會卡在這裡。
  // 輸入法選字的 Enter、Shift+Enter（換行）、選單開著時的 Enter 都不攔。
  const SENDS = ['button[data-testid="send-button"]', "#composer-submit-button", "button.send-button"];
  const SEND_RE = /send|submit|傳送|送出|发送|提交/i;  // i18n-ok 比對各家送出鈕的標籤
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const enabled = (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true";
  const textOf = (c) => (c ? (c.tagName === "TEXTAREA" ? c.value : c.innerText || c.textContent || "") : "").trim();
  function sendButton() {
    for (const sel of SENDS) for (const b of document.querySelectorAll(sel)) if (shown(b)) return b;
    // 輸入框所在的表單（ChatGPT、Claude 都是）或往上幾層裡，標籤像「送出」的按鈕（ChatGPT 沒登入、Gemini 都叫「傳送訊息」）；
    // 都沒有才拿明寫 type="submit" 的（沒寫 type 的按鈕在表單裡也算 submit，Gemini 的「上傳與工具」就是）
    const c = composer(), form = c && c.closest("form");
    let box = form || c, typed = null;
    for (let i = 0; box && i < (form ? 1 : 9); i++, box = box.parentElement) {
      for (const b of box.querySelectorAll("button, [role='button']")) {
        if (!shown(b)) continue;
        if (SEND_RE.test([b.getAttribute("aria-label"), b.title, b.getAttribute("data-testid")].join(" "))) return b;
        if (!typed && b.getAttribute("type") === "submit") typed = b;
      }
    }
    return typed;
  }
  function uploading() {  // 附件還在傳：送出鈕不能按，或輸入框那一塊有在轉的進度
    const b = sendButton(), c = composer();
    if (b && !enabled(b)) return true;
    const box = c && (c.closest("form") || c.parentElement && c.parentElement.parentElement);
    return !!box && Array.from(box.querySelectorAll("[role='progressbar'], [aria-busy='true'], .animate-spin")).some(shown);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let hold = false, pending = 0, acked = false, passKey = 0;  // passKey：FOLI 替讀者按的那一下 Enter 放行到什麼時候（只放那一下）
  function ask(how) {
    if (pending) return;  // 已經在等 FOLI：多按的 Enter 不算
    const mine = pending = Date.now();
    acked = false;
    say({ t: "send", how, q: textOf(composer()).slice(0, 400), path: location.pathname });
    setTimeout(() => { if (pending === mine && !acked) release({}); }, 1500);
    setTimeout(() => { if (pending === mine) release({}); }, 60000);
  }
  async function release(o) {
    if (!pending) return { sent: false };
    const mine = pending;
    acked = true;
    try {
      if (o && o.attached) {  // 等附件傳完：先給網站一點時間把它放上去（送出鈕會先變成不能按），再等它連續穩定 0.6 秒
        await sleep(500);
        for (let ok = 0, t0 = Date.now(); ok < 3 && Date.now() - t0 < 60000; await sleep(200)) ok = uploading() ? 0 : ok + 1;
      }
      if (pending !== mine) return { sent: false };
      const b = sendButton(), before = textOf(composer());
      if (b && enabled(b)) {
        b.click();  // 程式按的（不是讀者按的）：下面攔點擊的不會攔
        if (o && o.attached) retry(before);  // 不等它：讀者馬上接著問也不會被擋
        return { sent: true };
      }
      passKey = Date.now() + 1500;  // 找不到送出鈕：在輸入框按一下 Enter（放行那一下）
      if (o && o.host) return { sent: false, key: true };  // FOLI 叫的：請 FOLI 按（真的按鍵）
      pressEnter();  // FOLI 沒回應：自己按（程式按的，網站大多也認得）
      return { sent: true };
    } finally { if (pending === mine) pending = 0; }
  }
  // 附件還在傳、網站沒理那一下（輸入框的字還在）：等它能按再按，最多再兩次。送出去了輸入框會清空（或讀者已經打了別的），就停
  async function retry(before) {
    for (let n = 0; n < 2; n++) {
      await sleep(900);
      if (textOf(composer()) !== before) return;
      for (let t0 = Date.now(); Date.now() - t0 < 30000 && uploading(); ) await sleep(250);
      const b = sendButton();
      if (!b || !enabled(b) || textOf(composer()) !== before) return;
      b.click();
    }
  }
  function pressEnter() {
    const c = composer();
    if (!c) return;
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    for (const k of ["keyCode", "which"]) Object.defineProperty(ev, k, { get: () => 13 });
    c.dispatchEvent(ev);
  }
  const menuOpen = () => Array.from(document.querySelectorAll("[role='listbox'], [role='menu']")).some(shown);
  window.addEventListener("keydown", (e) => {
    if (!hold || e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    if (passKey) { const ok = Date.now() < passKey; passKey = 0; if (ok) return; }
    const c = composer();
    if (!c || !(c === e.target || c.contains(e.target)) || (!pending && (!textOf(c) || menuOpen()))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ask("key");
  }, true);
  window.addEventListener("click", (e) => {
    if (!hold || !e.isTrusted) return;
    const b = e.target && e.target.closest && e.target.closest("button, [role='button']");
    if (!b || b !== sendButton() || !textOf(composer())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ask("click");
  }, true);

  /* ---------- 專案（ChatGPT、Claude 的「專案」）：找讀者建好、叫 FOLI 的那一個，新對話放進去 ---------- */
  // 專案頁的網址：ChatGPT 是 /g/g-p-<編號>-<名字>/project，Claude 是 /project/<uuid>。依序找：現在這一頁、側邊欄的連結、
  // 網站自己的專案清單（ChatGPT、Claude 的網頁用的那個；只讀，不改任何東西）。回傳 { path, name } 或 null
  const PROJECT = /^\/(?:g\/(g-p-[\w-]+)\/project|project\/([0-9a-f-]{36}))\/?$/i;
  const projectPath = (p) => { const m = PROJECT.exec(p || ""); return m ? (m[1] ? "/g/" + m[1] + "/project" : "/project/" + m[2]) : ""; };
  function projectHere() {
    const path = projectPath(location.pathname);
    if (!path) return null;
    const h = document.querySelector("main h1, h1");
    const name = ((h && h.textContent) || document.title || "").replace(/\s*[|·–—-]\s*(ChatGPT|Claude)\s*$/i, "").replace(/^(ChatGPT|Claude)\s*[|·–—-]\s*/i, "").trim();
    return { path, name: name.slice(0, 60) };
  }
  function projectLinks() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/g/g-p-"], a[href*="/project/"]')) {
      let u;
      try { u = new URL(a.getAttribute("href"), location.href); } catch (e) { continue; }
      const path = u.origin === location.origin && projectPath(u.pathname);
      const name = (a.innerText || a.textContent || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || "";
      if (path && name) out.push({ path, name: name.slice(0, 60) });
    }
    return out;
  }
  async function projectList() {
    const get = (u, headers) => Promise.race([fetch(u, { credentials: "include", headers: headers || {} }).then((r) => (r.ok ? r.json() : null)), sleep(6000).then(() => null)]).catch(() => null);
    const out = [];
    if (opts.site === "chatgpt") {  // 側邊欄的專案清單（ChatGPT 內部叫 snorlax）：認名字和 g-p- 開頭的編號，不管外面包了幾層
      const s = await get("/api/auth/session");
      const walk = (o, depth) => {
        if (!o || typeof o !== "object" || depth > 8) return;
        const name = typeof o.name === "string" ? o.name : o.display && typeof o.display.name === "string" ? o.display.name : "";
        const id = [o.short_url, o.id].find((x) => typeof x === "string" && /^g-p-[\w-]+$/.test(x));
        if (name && id) out.push({ path: "/g/" + id + "/project", name: name.slice(0, 60) });
        for (const k in o) if (o[k] && typeof o[k] === "object") walk(o[k], depth + 1);
      };
      if (s && s.accessToken) walk(await get("/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0", { Authorization: "Bearer " + s.accessToken }), 0);
    } else if (opts.site === "claude") {
      const orgs = await get("/api/organizations");
      for (const org of Array.isArray(orgs) ? orgs.slice(0, 4) : []) {
        const list = org && typeof org.uuid === "string" ? await get("/api/organizations/" + encodeURIComponent(org.uuid) + "/projects") : null;
        for (const p of Array.isArray(list) ? list : []) if (p && typeof p.uuid === "string" && /^[0-9a-f-]{36}$/i.test(p.uuid) && typeof p.name === "string") out.push({ path: "/project/" + p.uuid, name: p.name.slice(0, 60) });
      }
    }
    return out;
  }
  async function findProject(want) {
    const key = (n) => String(n || "").trim().toLowerCase(), w = key(want || "FOLI");
    const pick = (list) => list.find((p) => key(p.name) === w) || list.find((p) => key(p.name).includes(w)) || null;
    const here = projectHere();
    return pick(here ? [here] : []) || pick(projectLinks()) || pick(await projectList());
  }

  /* ---------- 一則一則的訊息：書籤、存成筆記、給漂浮小視窗的「原本的對話」 ---------- */
  // 各家標記訊息的方式（ChatGPT 的 data-message-author-role、Claude 的 user-message／font-claude-…、Gemini 的 user-query／model-response）
  const MSG = '[data-message-author-role], [data-testid="user-message"], .font-claude-response, .font-claude-message, user-query, model-response';
  const roleOf = (el) => { const r = el.getAttribute("data-message-author-role"); return r ? (r === "user" ? "user" : "assistant") : el.matches('[data-testid="user-message"], user-query') ? "user" : "assistant"; };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  function messages() {  // 最外層的才算（同一則裡面又有一層同樣記號的不重複算）
    return Array.from(document.querySelectorAll(MSG)).filter((el) => !(el.parentElement && el.parentElement.closest(MSG)) && norm(el.textContent).length).map((el) => ({ el, role: roleOf(el) }));
  }
  const snippetOf = (el) => norm(el.textContent).slice(0, 90);  // textContent：不用排版（innerText 每次都要算版面，對話長了滑鼠一動就卡）
  const outer = (el) => { let top = el && el.closest(MSG); while (top && top.parentElement && top.parentElement.closest(MSG)) top = top.parentElement.closest(MSG); return top; };
  function findMsg(m) {  // 書籤對到哪一則：開頭的字一樣（同一個角色）；認不到再看第幾則
    const want = norm(m.snippet).slice(0, 48), list = messages();
    return (list.find((x) => x.role === m.role && want && snippetOf(x.el).startsWith(want)) || list.find((x) => want && snippetOf(x.el).includes(want.slice(0, 24))) || {}).el || null;
  }
  function transcript() {  // 原本的對話（漂浮小視窗附上它）：一則一則轉成 Markdown
    return { title: transcriptTitle(), msgs: messages().map((x) => ({ role: x.role, md: tidy(md(x.el)) || norm(x.el.textContent) })) };
  }

  /* 書籤：FOLI 記著（dock-ai.js），載好、換頁時交過來；有書籤的那幾則左邊一條強調色的線 */
  let marks = [];
  function paintMarks() {
    for (const el of document.querySelectorAll("[data-foli-mark]")) el.removeAttribute("data-foli-mark");
    for (const m of marks) { const el = findMsg(m); if (el) el.setAttribute("data-foli-mark", ""); }
  }
  async function jumpTo(m) {  // 捲到那一則（還沒載進來的較早訊息：往上捲幾次讓網站載）
    for (let k = 0; k < 6; k++) {
      const el = findMsg(m);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: k ? "auto" : "smooth" });
        el.removeAttribute("data-foli-flash"); void el.offsetWidth; el.setAttribute("data-foli-flash", "");
        setTimeout(() => el.removeAttribute("data-foli-flash"), 1700);
        return true;
      }
      const first = messages()[0];
      if (!first) await sleep(700);
      else { first.el.scrollIntoView({ block: "start" }); await sleep(800); }
    }
    return false;
  }

  /* 滑過一則訊息：右上角兩顆小按鈕——書籤、存成筆記（回答才有）。按鈕自己的樣子在 FOLI 放上來的 CSS 裡（dock-ai.js 的 markCss） */
  let tools = null, toolFor = null, hideT = 0, taken = null;
  function toolsEl() {
    if (tools && tools.isConnected) return tools;
    tools = document.createElement("div");
    tools.id = "foli-tools";
    tools.addEventListener("mousedown", (e) => e.preventDefault());  // 不搶焦點、不清掉選取
    tools.addEventListener("mouseenter", () => clearTimeout(hideT));
    tools.addEventListener("mouseleave", () => hideSoon());
    tools.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b || !toolFor) return;
      e.preventDefault(); e.stopPropagation();
      const el = toolFor, role = roleOf(el), act = b.dataset.act;
      if (act === "mark") {
        const on = !el.hasAttribute("data-foli-mark");
        if (on) el.setAttribute("data-foli-mark", ""); else el.removeAttribute("data-foli-mark");
        say({ t: "mark", on, role, snippet: snippetOf(el), path: location.pathname, title: transcriptTitle() });
        paintTools();
      } else if (act === "note") {
        taken = { md: tidy(md(el)) || norm(el.textContent), question: question(el) };
        say({ t: "tonote" });
      }
    });
    (document.body || document.documentElement).appendChild(tools);
    return tools;
  }
  const transcriptTitle = () => norm(document.title).replace(/\s*[|·–—-]\s*(ChatGPT|Claude|Gemini)\s*$/i, "").slice(0, 80);
  function paintTools() {
    const t = toolsEl(), el = toolFor;
    if (!el) { t.classList.remove("on"); return; }
    const marked = el.hasAttribute("data-foli-mark"), tx = opts.text || {}, ic = opts.icons || {};
    t.innerHTML = '<button data-act="mark" class="' + (marked ? "is-on" : "") + '" title="' + (marked ? tx.unmark || "" : tx.mark || "") + '">' + (marked ? ic.markon || "★" : ic.mark || "☆") + "</button>" +
      (roleOf(el) === "assistant" ? '<button data-act="note" title="' + (tx.note || "") + '">' + (ic.note || "✎") + "</button>" : "");
    const r = el.getBoundingClientRect(), w = t.offsetWidth || 64;
    if (r.bottom < 40 || r.top > innerHeight - 30) { t.classList.remove("on"); return; }
    t.style.top = Math.round(Math.max(8, r.top + 4)) + "px";
    t.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 10, r.right - w - 6))) + "px";
    t.classList.add("on");
  }
  function hideSoon() { clearTimeout(hideT); hideT = setTimeout(() => { toolFor = null; if (tools) tools.classList.remove("on"); }, 350); }
  let moveT = 0;
  document.addEventListener("mousemove", (e) => {
    if (!opts.tools || moveT) return;
    moveT = setTimeout(() => { moveT = 0; }, 60);
    if (tools && tools.contains(e.target)) return;
    const top = e.target.closest ? outer(e.target) : null;
    if (!top) { if (toolFor) hideSoon(); return; }
    clearTimeout(hideT);
    if (top !== toolFor) { toolFor = top; paintTools(); }
  }, true);
  document.addEventListener("scroll", () => { if (toolFor) paintTools(); }, true);

  // 在這個網頁裡按下滑鼠：告訴 FOLI（漂浮小視窗沒釘選的話要收起來——FOLI 收不到網頁裡的滑鼠）
  let downAt = 0;
  document.addEventListener("pointerdown", () => { if (Date.now() - downAt > 400) { downAt = Date.now(); say({ t: "down" }); } }, true);

  /* 在回答裡選字：冒出一顆「問這句」，點了在漂浮小視窗另外問（原本的對話不動） */
  let askPill = null, askedAt = 0;
  function pillEl() {
    if (askPill && askPill.isConnected) return askPill;
    askPill = document.createElement("button");
    askPill.id = "foli-ask";
    askPill.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const text = norm(String(getSelection() || "")).slice(0, 1500);
      askPill.classList.remove("on");
      askedAt = Date.now();
      if (text) say({ t: "aside", text });
      try { getSelection().removeAllRanges(); } catch (err) { /* 選取清不掉就算了 */ }  // 字已經交給小視窗：放開滑鼠時這顆不要再冒出來
    });
    (document.body || document.documentElement).appendChild(askPill);
    return askPill;
  }
  document.addEventListener("mouseup", (e) => {
    if (!opts.aside || (askPill && askPill.contains(e.target)) || Date.now() - askedAt < 600) return;
    setTimeout(() => {
      const sel = getSelection(), p = pillEl();
      const text = sel && !sel.isCollapsed && sel.rangeCount ? norm(String(sel)) : "";
      const node = text && sel.getRangeAt(0).commonAncestorContainer, host = node && (node.nodeType === 1 ? node : node.parentElement);
      const inAnswer = host && outer(host) && roleOf(outer(host)) === "assistant" && !host.closest("textarea, input, [contenteditable='true'], [contenteditable='']");
      if (!inAnswer || text.length < 2 || text.length > 1500) { p.classList.remove("on"); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      p.innerHTML = (opts.icons && opts.icons.ask ? opts.icons.ask : "") + "<span>" + ((opts.text && opts.text.ask) || "Ask") + "</span>";
      p.classList.add("on");
      const w = p.offsetWidth, h = p.offsetHeight;
      p.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))) + "px";
      p.style.top = Math.round(r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + "px";
    }, 10);
  }, true);
  document.addEventListener("selectionchange", () => { const s = getSelection(); if (askPill && (!s || s.isCollapsed)) askPill.classList.remove("on"); });

  /* ---------- 開始 ---------- */
  let skinKey = "";
  const mo = new MutationObserver((list) => {
    let theme = false;
    for (const m of list) if (m.type === "attributes" && (m.target === document.documentElement || m.target === document.body) && m.attributeName !== "data-foli-skin") theme = true;
    if (theme) { const k = document.documentElement.className + "|" + (document.body && document.body.className); if (k !== skinKey) { skinKey = k; say({ t: "reskin" }); } }
    scanSoon();
    if (marks.length) marksSoon();
  });
  let marksT = 0;
  const marksSoon = () => { clearTimeout(marksT); marksT = setTimeout(paintMarks, 400); };  // 網站重畫了那一則：記號再放一次
  function init(o) {
    opts = Object.assign({ pages: 0, hold: false, site: "", tools: false, aside: false, text: {}, icons: {} }, o || {});
    hold = !!opts.hold;
    skinKey = document.documentElement.className + "|" + (document.body && document.body.className);
    mo.disconnect();
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "data-theme"] });
    scanSoon();
    return true;
  }
  root.__foliGuest = { v: VERSION, init, skinCss, focusComposer, selection, lastAnswer, setPages: (n) => { opts.pages = n || 0; scanSoon(); }, marked: () => marked, hits: () => hits.length,
    hold: (on) => { hold = !!on; if (!hold && pending) release({}); return hold; }, ack: () => { acked = true; return true; }, release, findProject, projectHere,
    transcript, jumpTo, setMarks: (list) => { marks = Array.isArray(list) ? list : []; paintMarks(); return marks.length; }, take: () => { const x = taken; taken = null; return x; },
    count: () => messages().length,
    probe() {  // 檢查用：在這個網站認到的輸入框、送出鈕（新網站或網站改版時，看是哪一個沒認到）
      const say = (e) => (e ? e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.getAttribute("data-testid") ? "[testid=" + e.getAttribute("data-testid") + "]" : "") + (e.getAttribute("aria-label") ? '["' + e.getAttribute("aria-label") + '"]' : "") : null);
      const c = composer(), b = sendButton();
      return { composer: say(c), text: textOf(c).slice(0, 40), send: say(b), enabled: !!(b && enabled(b)), uploading: uploading(), hold };
    } };
})(typeof window !== "undefined" ? window : globalThis);
