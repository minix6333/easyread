/* 所見即所得的一段字：筆記編輯器（blocks.js）正在編的那一塊、表格的每一格，都是一個可以直接編輯的元素，
   裡面就是排好的樣子——粗體是粗的、螢光有底色、公式畫成公式、連結是連結。存的還是同一套 Markdown：
   **粗**、*斜*、++底線++、~~刪除線~~、==螢光==、`程式碼`、$TeX$、[字](網址)、![](clips/圖)，換行就是換行。
   - 不用打記號：⌘B 這類快捷鍵、選字工具列、格式面板直接改樣子（toggle）；
     會打記號的照打也行——打完一對（**字**、`字`、$式$、==字==…）就變成那個樣子（autoformat）。
   - 注音、拼音選字中（composition）不動畫面，選好字才收（呼叫的人在 compositionend 之後再叫）。
   - 位置一律用「看得到的單位」算：一個字一格，一個公式、一張圖、一個換行各一格，和 Markdown 原文的位置無關。
   純函式（tests/test_richtext.cjs）：parse(md) → 樹、runsOfTree(樹) → 一段段、emit(一段段) → md、cleanPaste(純文字)。 */
(function (PR) {
  "use strict";
  const ZW = "\u200b";
  const ORDER = ["b", "i", "u", "s", "hl", "code"];  // 一起開的時候外到內（程式碼最裡面，裡面不能再有別的）
  const OPEN = { b: "**", i: "*", u: "++", s: "~~", hl: "==", code: "\x60" };
  const TAG = { b: "b", i: "i", u: "u", s: "s", hl: "mark", code: "code" };
  const DOUBLE = { "**": "b", "++": "u", "~~": "s", "==": "hl" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const isUrl = (u) => /^(https?:\/\/\S+|\/(?:read|note)\/[\w\-]+(?:[?#]\S*)?)$/.test(u);

  /* ---------- Markdown → 樹（純函式） ---------- */
  /* 節點：{t: 字}、{k: "b"|"i"|"u"|"s"|"hl"|"code", c: [子節點]}、{tex: TeX}、{raw: 原樣（圖）}、{link: 網址, c: […]}、{br: 1} */
  function parse(md) {
    const s = String(md == null ? "" : md);
    const out = [];
    let buf = "";
    const flush = () => { if (buf) { out.push({ t: buf }); buf = ""; } };
    for (let i = 0; i < s.length;) {
      const c = s[i], rest = s.slice(i);
      if (c === "\\" && i + 1 < s.length && /[\\*\x60$~+=\[\]#>\-.!|_(){}]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }  // 跳脫的字：照字面
      if (c === "\n") { flush(); out.push({ br: 1 }); i++; continue; }
      let m;
      if (c === "\x60" && (m = /^(\x60+)([\s\S]*?[^\x60])\1(?!\x60)/.exec(rest)) && !m[2].includes("\n")) { flush(); out.push({ k: "code", c: [{ t: m[2] }] }); i += m[0].length; continue; }
      if (c === "$" && s[i + 1] !== "$" && (m = /^\$((?:\\\$|[^$\n])+?)\$(?!\$)/.exec(rest))) { flush(); out.push({ tex: m[1] }); i += m[0].length; continue; }
      if (c === "\\" && (m = /^\\\(([\s\S]+?)\\\)/.exec(rest)) && !m[1].includes("\n")) { flush(); out.push({ tex: m[1] }); i += m[0].length; continue; }
      if (c === "!" && (m = /^!\[[^\]\n]*\]\([^)\s]+\)/.exec(rest))) { flush(); out.push({ raw: m[0] }); i += m[0].length; continue; }
      if (c === "[" && (m = /^\[((?:\\\]|[^\]\n])+)\]\(([^)\s]+)\)/.exec(rest)) && isUrl(m[2])) { flush(); out.push({ link: m[2], c: parse(m[1]) }); i += m[0].length; continue; }
      if (s.startsWith("***", i)) {  // 粗斜體（同一段又粗又斜，存的時候就是 ***字***）
        const end = s.indexOf("***", i + 3), inner = end > i + 3 ? s.slice(i + 3, end) : "";
        if (inner && !inner.includes("\n")) { flush(); out.push({ k: "b", c: [{ k: "i", c: parse(inner) }] }); i = end + 3; continue; }
      }
      const two = s.slice(i, i + 2);
      if (DOUBLE[two]) {
        const end = s.indexOf(two, i + 2);
        const inner = end > i + 2 ? s.slice(i + 2, end) : "";
        if (inner && !inner.includes("\n")) { flush(); out.push({ k: DOUBLE[two], c: parse(inner) }); i = end + 2; continue; }
      }
      if (c === "*" && s[i + 1] !== "*" && s[i - 1] !== "*") {
        m = /^\*((?:\\\*|[^*\n])+)\*(?!\*)/.exec(rest);
        if (m) { flush(); out.push({ k: "i", c: parse(m[1]) }); i += m[0].length; continue; }
      }
      buf += c; i++;
    }
    flush();
    return out;
  }

  /* 樹 → 一段段（每段帶著自己有哪些樣式、在哪個連結裡）；長度：字一個一格，公式、圖、換行一格 */
  function runsOfTree(tree, marks, link, out) {
    out = out || [];
    for (const n of tree) {
      if (n.t != null) out.push({ t: n.t, m: marks || [], link: link || null });
      else if (n.br) out.push({ br: 1 });
      else if (n.tex != null) out.push({ tex: n.tex, m: marks || [], link: link || null });
      else if (n.raw != null) out.push({ raw: n.raw, m: marks || [], link: link || null });
      else if (n.link) runsOfTree(n.c, marks, n.link, out);
      else if (n.k) runsOfTree(n.c, (marks || []).concat(n.k), link, out);
    }
    return out;
  }

  /* ---------- 一段段 → Markdown（純函式） ---------- */
  /* 平常的字裡會被當成記號的那幾個要跳脫（\*、\$…）；行首的 # > - 1. 也是，不然重新讀的時候變成標題、清單 */
  function escText(t, lineStart) {
    let s = t.replace(/\\(?=[\\*\x60$~+=\[\]#>\-.!|_(){}]|$)/g, "\\\\").replace(/[*\x60$]/g, "\\$&").replace(/(~~|\+\+|==)/g, (m) => "\\" + m).replace(/\](?=\()/g, "\\]");
    if (lineStart) s = s.replace(/^(\s*)(#|>|[-+](?=\s)|\d+(?=[.)]\s))/, "$1\\$2");
    return s;
  }
  function emitSeq(runs) {
    let s = "", stack = [], lineStart = true;
    const close = (k) => { while (stack.length > k) s += OPEN[stack.pop()]; };
    for (const r of runs) {
      if (r.br) { close(0); s += "\n"; lineStart = true; continue; }
      const want = ORDER.filter((k) => (r.m || []).includes(k));
      let k = 0;
      while (k < stack.length && want.includes(stack[k]) && stack.indexOf(stack[k]) === k) k++;
      close(k);
      for (const mk of want) if (!stack.includes(mk)) { s += OPEN[mk]; stack.push(mk); }
      if (r.tex != null) s += "$" + r.tex + "$";
      else if (r.raw != null) s += r.raw;
      else s += stack.includes("code") ? r.t : escText(r.t, lineStart && !stack.length);
      lineStart = false;
    }
    close(0);
    return s;
  }
  /* 連結：連著同一個網址的幾段包成 [ … ](網址)，樣式在連結外面先收、裡面另外開 */
  function emit(runs) {
    let s = "", seq = [];
    const flush = () => { if (seq.length) { s += emitSeq(seq); seq = []; } };
    for (let i = 0; i < runs.length;) {
      const r = runs[i];
      if (r.link) {
        flush();
        const group = [];
        while (i < runs.length && runs[i].link === r.link) group.push(Object.assign({}, runs[i++], { link: null }));
        s += "[" + emitSeq(group).replace(/\]/g, "\\]") + "](" + r.link + ")";
        continue;
      }
      seq.push(r);
      i++;
    }
    flush();
    return s;
  }

  /* ---------- 樹 → 可以編輯的 HTML ---------- */
  function html(md) {
    const tree = parse(md);
    let h = treeHtml(tree);
    if (/\n$/.test(String(md || ""))) h += "<br>";  // 最後是換行：多放一個，空的那一行才看得到、點得進去
    return h;
  }
  function texHtml(tex) {
    let k = "";
    try { k = PR.tex ? PR.tex(tex, false) : esc(tex); } catch (e) { k = esc(tex); }
    return '<span class="rt-tex" contenteditable="false" data-tex="' + esc(tex) + '">' + k + "</span>";
  }
  function treeHtml(tree) {
    return tree.map((n) => {
      if (n.t != null) return esc(n.t);
      if (n.br) return "<br>";
      if (n.tex != null) return texHtml(n.tex);
      if (n.raw != null) return '<span class="rt-raw" contenteditable="false" data-md="' + esc(n.raw) + '">' + (PR.md ? PR.md(n.raw, { cite: false, xref: false }) : esc(n.raw)) + "</span>";
      if (n.link) return '<a class="rt-a" data-href="' + esc(n.link) + '" href="' + esc(n.link) + '">' + treeHtml(n.c) + "</a>";
      return "<" + TAG[n.k] + ">" + treeHtml(n.c) + "</" + TAG[n.k] + ">";
    }).join("");
  }

  /* ---------- 可以編輯的元素 → 一段段 ---------- */
  const isAtom = (n) => n.nodeType === 1 && (n.classList.contains("rt-tex") || n.classList.contains("rt-raw"));
  function styleMarks(el, m) {  // 貼上來的 <span style="font-weight:700"> 之類
    const st = el.style || {};
    const add = (k) => { if (!m.includes(k)) m = m.concat(k); };
    if (/^(bold|[6-9]00)$/.test(st.fontWeight || "")) add("b");
    if (st.fontStyle === "italic") add("i");
    if (/underline/.test(st.textDecoration || st.textDecorationLine || "")) add("u");
    if (/line-through/.test(st.textDecoration || st.textDecorationLine || "")) add("s");
    return m;
  }
  /* 換行有兩種寫法：<br>，或（white-space: pre-wrap 的時候瀏覽器自己插的）字裡的 \n——都當成換行 */
  function rawRuns(el) {
    const out = [];
    (function walk(p, marks, link) {
      for (const c of Array.from(p.childNodes)) {
        if (c.nodeType === 3) {
          const parts = c.nodeValue.split(ZW).join("").replace(/\u00a0/g, " ").split("\n");
          parts.forEach((t, k) => { if (k) out.push({ br: 1 }); if (t) out.push({ t, m: marks, link }); });
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (c.tagName === "BR") { out.push({ br: 1 }); continue; }
        if (c.classList.contains("rt-tex")) { out.push({ tex: c.dataset.tex || "", m: marks, link }); continue; }
        if (c.classList.contains("rt-raw")) { out.push({ raw: c.dataset.md || "", m: marks, link }); continue; }
        if (c.classList.contains("rt-ph")) continue;
        let m = marks;
        const add = (k) => { if (!m.includes(k)) m = m.concat(k); };
        const tag = c.tagName;
        if (tag === "B" || tag === "STRONG") { if (!/^(normal|[1-5]00)$/.test((c.style && c.style.fontWeight) || "")) add("b"); }
        else if (tag === "I" || tag === "EM") add("i");
        else if (tag === "U" || tag === "INS") add("u");
        else if (tag === "S" || tag === "STRIKE" || tag === "DEL") add("s");
        else if (tag === "MARK") add("hl");
        else if (tag === "CODE") add("code");
        else if (tag === "SPAN" || tag === "FONT") m = styleMarks(c, m);
        const ln = tag === "A" ? (c.dataset.href || c.getAttribute("href") || link) : link;
        const blockish = tag === "DIV" || tag === "P" || tag === "LI";
        if (blockish && out.length && !out[out.length - 1].br) out.push({ br: 1 });
        walk(c, m, ln && isUrl(ln) ? ln : null);
      }
    })(el, [], null);
    return out;
  }
  function runs(el) {
    const out = rawRuns(el);
    if (out.length && out[out.length - 1].br) out.pop();  // 結尾佔位的那一個換行（只拿一個：最後一行是空的時候，前面那個是真的換行）
    return out;
  }
  const md = (el) => emit(runs(el));

  /* ---------- 位置：看得到的單位 ⇄ DOM ---------- */
  const units = (t) => t.split(ZW).join("").length;
  function rawOffset(t, u) {  // 第 u 個看得到的字在字串裡的位置（跳過零寬字）
    let k = 0;
    for (let i = 0; i < t.length; i++) { if (t[i] === ZW) continue; if (k === u) return i; k++; }
    return t.length;
  }
  function toUnits(el, node, offset) {
    let n = 0, done = false;
    (function walk(p) {
      const kids = p.childNodes;
      for (let k = 0; k < kids.length; k++) {
        if (done) return;
        if (p === node && k === offset) { done = true; return; }
        const c = kids[k];
        if (c.nodeType === 3) { if (c === node) { n += units(c.nodeValue.slice(0, offset)); done = true; return; } n += units(c.nodeValue); }
        else if (c.nodeType === 1) {
          if (isAtom(c) || c.tagName === "BR") { if (c === node || c.contains(node)) { done = true; return; } n += 1; }
          else walk(c);
        }
      }
      if (p === node) done = true;
    })(el);
    return n;
  }
  function fromUnits(el, u) {
    let left = Math.max(0, u), res = null;
    (function walk(p) {
      const kids = p.childNodes;
      for (let k = 0; k < kids.length && !res; k++) {
        const c = kids[k];
        if (c.nodeType === 3) {
          const len = units(c.nodeValue);
          if (left <= len) { res = { node: c, offset: rawOffset(c.nodeValue, left) }; return; }
          left -= len;
        } else if (c.nodeType === 1) {
          if (isAtom(c) || c.tagName === "BR") { if (left === 0) { res = { node: p, offset: k }; return; } left -= 1; }
          else walk(c);
        }
      }
    })(el);
    return res || { node: el, offset: el.childNodes.length };
  }
  function length(el) { return runs(el).reduce((n, r) => n + (r.t != null ? r.t.length : 1), 0); }
  function caret(el) {
    const sel = window.getSelection && getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
    return { start: toUnits(el, r.startContainer, r.startOffset), end: toUnits(el, r.endContainer, r.endOffset) };
  }
  function setCaret(el, start, end) {
    const a = fromUnits(el, start), z = end == null || end === start ? a : fromUnits(el, end);
    const r = document.createRange();
    r.setStart(a.node, a.offset); r.setEnd(z.node, z.offset);
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  }
  /* 從第 a 格到第 b 格的 Markdown（分段、選起來的那幾個字用） */
  function slice(el, a, b) {
    const rs = runs(el), out = [];
    let pos = 0;
    for (const r of rs) {
      const len = r.t != null ? r.t.length : 1;
      const s0 = Math.max(a, pos), s1 = Math.min(b == null ? Infinity : b, pos + len);
      if (s1 > s0) out.push(r.t != null ? Object.assign({}, r, { t: r.t.slice(s0 - pos, s1 - pos) }) : r);
      pos += len;
    }
    return emit(out);
  }
  const text = (el) => runs(el).map((r) => (r.t != null ? r.t : r.br ? "\n" : "\uFFFC")).join("");

  /* 游標在第一行／最後一行嗎（↑↓ 要不要走到上一塊、下一塊）：比游標和元素的上下緣 */
  function caretRect(el) {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(false);
    const rects = r.getClientRects();
    if (rects.length) return rects[rects.length - 1];
    const at = caret(el);
    const probe = document.createElement("span");
    probe.textContent = ZW;
    r.insertNode(probe);
    const box = probe.getBoundingClientRect();
    const parent = probe.parentNode;
    probe.remove();
    if (parent) parent.normalize();
    if (at) setCaret(el, at.start, at.end);
    return box;
  }
  /* 最後一行是空的嗎（引用、說明框裡空一行再按 Enter 就跳出去）：結尾是兩個換行（第二個是佔位的） */
  function endsWithEmptyLine(el) {
    const rs = rawRuns(el);
    return rs.length >= 2 && !!rs[rs.length - 1].br && !!rs[rs.length - 2].br;
  }
  function lineH(el) { const cs = getComputedStyle(el); return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6 || 20; }
  function onFirstLine(el) { const c = caretRect(el); if (!c) return true; return c.top - el.getBoundingClientRect().top < lineH(el) * 0.8; }
  function onLastLine(el) { const c = caretRect(el); if (!c) return true; return el.getBoundingClientRect().bottom - c.bottom < lineH(el) * 0.8; }

  /* ---------- 改樣式 ---------- */
  function closestIn(el, node, test) {
    for (let n = node && (node.nodeType === 1 ? node : node.parentNode); n && n !== el; n = n.parentNode) if (n.nodeType === 1 && test(n)) return n;
    return null;
  }
  function unwrap(n) { const p = n.parentNode; while (n.firstChild) p.insertBefore(n.firstChild, n); n.remove(); p.normalize(); }
  /* 相鄰的同一種包起來的併成一個、空的拿掉：<b>a</b><b>b</b> → <b>ab</b>（不然存成 **a****b**） */
  function tidy(el) {
    (function walk(p) {
      for (let c = p.firstChild; c;) {
        const next = c.nextSibling;
        if (c.nodeType === 1 && !isAtom(c) && c.tagName !== "BR") {
          walk(c);
          if (!c.textContent.split(ZW).join("") && !c.querySelector(".rt-tex, .rt-raw, br")) { c.remove(); c = next; continue; }
          if (next && next.nodeType === 1 && next.tagName === c.tagName && (c.tagName !== "A" || next.dataset.href === c.dataset.href) && !isAtom(next)) {
            while (next.firstChild) c.append(next.firstChild);
            next.remove();
            continue;  // 再看一次（下一個可能也是同一種）
          }
        }
        c = next;
      }
    })(el);
    el.normalize();
  }
  /* 選起來的字加上／拿掉一種樣式。粗、斜、底線、刪除線交給瀏覽器（會處理只選到一半的情況）；螢光、程式碼自己包 */
  const NATIVE = { b: "bold", i: "italic", u: "underline", s: "strikeThrough" };
  function toggle(el, k) {
    const sel = getSelection();
    if (!sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return false;
    if (NATIVE[k]) {
      try { document.execCommand("styleWithCSS", false, false); } catch (e) { /* 舊的瀏覽器 */ }
      document.execCommand(NATIVE[k], false, null);
      tidy(el);
      return true;
    }
    const tag = TAG[k].toUpperCase();
    const inside = closestIn(el, r.commonAncestorContainer, (n) => n.tagName === tag);
    if (inside) { const at = caret(el); unwrap(inside); tidy(el); if (at) setCaret(el, at.start, at.end); return true; }
    if (r.collapsed) return false;
    const at = caret(el);
    const frag = r.extractContents();
    frag.querySelectorAll && frag.querySelectorAll(tag.toLowerCase()).forEach(unwrapFrag);
    const w = document.createElement(TAG[k]);
    if (k === "code") w.textContent = fragText(frag); else w.append(frag);
    r.insertNode(w);
    tidy(el);
    if (at) setCaret(el, at.start, at.end);
    return true;
  }
  function unwrapFrag(n) { const p = n.parentNode; while (n.firstChild) p.insertBefore(n.firstChild, n); p.removeChild(n); }
  function fragText(frag) { const d = document.createElement("div"); d.append(frag); return d.textContent.split(ZW).join(""); }
  /* 現在游標（或選的字）在哪幾種樣式裡（工具列亮哪幾顆） */
  function active(el) {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    let n = r.startContainer;
    // 選取從樣式的邊上開始（例如剛好在 <b> 前面）：看選到的第一個字在哪裡
    if (!r.collapsed) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (!r.intersectsNode(t)) continue;
        const from = t === r.startContainer ? r.startOffset : 0;
        if (t.nodeValue.slice(from).split(ZW).join("")) { n = t; break; }
      }
    }
    const out = [];
    for (const k of ORDER) if (closestIn(el, n, (x) => x.tagName === TAG[k].toUpperCase() || (k === "b" && x.tagName === "STRONG") || (k === "i" && x.tagName === "EM") || (k === "s" && (x.tagName === "STRIKE" || x.tagName === "DEL")))) out.push(k);
    if (closestIn(el, n, (x) => x.tagName === "A")) out.push("link");
    return out;
  }
  /* 選的字變成公式（選的字就是 TeX）；沒選字就在游標處放一個空的，回傳那個元素（讓呼叫的人開編輯框） */
  function insertTex(el, tex) {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return null;
    const src = tex != null ? tex : r.collapsed ? "" : fragText(r.cloneContents());
    r.deleteContents();
    const box = document.createElement("span");
    box.innerHTML = texHtml(src || "x");
    const atom = box.firstChild;
    if (!src) atom.dataset.tex = "";
    r.insertNode(atom);
    const after = document.createTextNode(ZW);
    atom.after(after);
    const sel2 = getSelection(), r2 = document.createRange();
    r2.setStart(after, 1); r2.collapse(true);
    sel2.removeAllRanges(); sel2.addRange(r2);
    return atom;
  }
  function setTex(atom, tex) {
    const box = document.createElement("span");
    box.innerHTML = texHtml(tex);
    atom.replaceWith(box.firstChild);
    return box.firstChild;
  }
  /* 選的字變成連結；游標在連結裡、url 給空字串就是拿掉連結 */
  function link(el, url) {
    const sel = getSelection();
    if (!sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    const a = closestIn(el, r.commonAncestorContainer, (n) => n.tagName === "A");
    if (a) { if (!url) { unwrap(a); tidy(el); } else { a.dataset.href = url; a.setAttribute("href", url); } return true; }
    if (!url || r.collapsed || !isUrl(url)) return false;
    const frag = r.extractContents();
    frag.querySelectorAll && frag.querySelectorAll("a").forEach(unwrapFrag);
    const w = document.createElement("a");
    w.className = "rt-a"; w.dataset.href = url; w.setAttribute("href", url);
    w.append(frag);
    r.insertNode(w);
    tidy(el);
    return true;
  }
  const linkAt = (el) => { const sel = getSelection(); return sel.rangeCount ? closestIn(el, sel.getRangeAt(0).startContainer, (n) => n.tagName === "A") : null; };
  /* 選起來的那一段（「@找的字」）換成一個連結；游標放在連結後面，接著打的字不會跑進連結裡 */
  function insertLink(el, label, url) {
    const sel = getSelection();
    if (!sel.rangeCount || !label || !isUrl(url)) return false;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return false;
    r.deleteContents();
    const a = document.createElement("a");
    a.className = "rt-a"; a.dataset.href = url; a.setAttribute("href", url);
    a.textContent = label;
    r.insertNode(a);
    const after = document.createTextNode(ZW);
    a.after(after);
    const r2 = document.createRange();
    r2.setStart(after, 1); r2.collapse(true);
    sel.removeAllRanges(); sel.addRange(r2);
    return true;
  }

  /* ---------- 打完一對記號就變成那個樣子 ---------- */
  const AUTO = [
    [/\*\*([^*\n]*[^*\s\n])\*\*$/, "b"],
    [/(?:^|[^*\\])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*$/, "i"],
    [/~~([^~\n]+)~~$/, "s"],
    [/\+\+([^+\n]+)\+\+$/, "u"],
    [/==([^=\n]+)==$/, "hl"],
    [/\x60([^\x60\n]+)\x60$/, "code"],
    [/(?:^|[^\\$])\$([^$\s\n](?:[^$\n]*[^$\s\n])?)\$$/, "tex"],
  ];
  function autoformat(el) {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const node = sel.anchorNode, off = sel.anchorOffset;
    if (!node || node.nodeType !== 3 || !el.contains(node) || closestIn(el, node, (n) => n.tagName === "CODE")) return false;
    const before = node.nodeValue.slice(0, off);
    for (const [re, k] of AUTO) {
      const m = re.exec(before);
      if (!m) continue;
      const body = m[1], delim = k === "b" || k === "s" || k === "u" || k === "hl" ? 2 : 1;
      const startAt = m.index + (m[0].length - (body.length + delim * 2));  // 跳過前面那個用來判斷的字（不是記號的一部分）
      const tail = node.nodeValue.slice(off);
      node.nodeValue = before.slice(0, startAt);
      let w;
      if (k === "tex") { const box = document.createElement("span"); box.innerHTML = texHtml(body); w = box.firstChild; }
      else { w = document.createElement(TAG[k]); w.textContent = body; }
      const after = document.createTextNode(ZW + tail);
      node.after(w, after);
      const r = document.createRange();
      r.setStart(after, 1); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      return true;
    }
    return false;
  }

  /* ---------- 貼上 ---------- */
  /* 別的地方複製來的 HTML（網頁、Word、Google 文件）→ Markdown：標題、清單、粗斜體、連結、表格、程式碼都留著 */
  function fromHtml(htmlText) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(htmlText || ""), "text/html"); } catch (e) { return ""; }
    const blocks = [];
    const inl = (n) => {
      const rs = [];
      (function walk(p, marks, ln) {
        for (const c of Array.from(p.childNodes)) {
          if (c.nodeType === 3) { const t = c.nodeValue.replace(/\s+/g, " "); if (t) rs.push({ t, m: marks, link: ln }); continue; }
          if (c.nodeType !== 1 || /^(SCRIPT|STYLE|META|LINK|TITLE)$/.test(c.tagName) || /^O:/.test(c.tagName)) continue;
          if (c.tagName === "BR") { rs.push({ br: 1 }); continue; }
          if (c.tagName === "IMG") continue;
          let m = marks;
          const add = (k) => { if (!m.includes(k)) m = m.concat(k); };
          const tag = c.tagName;
          if (tag === "B" || tag === "STRONG") { if (!/^(normal|[1-5]00)$/.test((c.style && c.style.fontWeight) || "")) add("b"); }
          else if (tag === "I" || tag === "EM") add("i");
          else if (tag === "U" || tag === "INS") add("u");
          else if (tag === "S" || tag === "STRIKE" || tag === "DEL") add("s");
          else if (tag === "MARK") add("hl");
          else if (tag === "CODE" || tag === "KBD" || tag === "SAMP") add("code");
          else if (tag === "SPAN" || tag === "FONT") m = styleMarks(c, m);
          const href = tag === "A" ? (c.getAttribute("href") || "") : "";
          walk(c, m, href && /^https?:\/\//.test(href) ? href : ln);
        }
      })(n, [], null);
      // 前後的空白、連著的空白收掉
      const out = [];
      for (const r of rs) { if (r.t != null && out.length && out[out.length - 1].t != null && /\s$/.test(out[out.length - 1].t)) r.t = r.t.replace(/^\s+/, ""); if (r.t !== "") out.push(r); }
      if (out.length && out[0].t != null) out[0].t = out[0].t.replace(/^\s+/, "");
      if (out.length && out[out.length - 1].t != null) out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, "");
      return emit(out.filter((r) => r.t !== ""));
    };
    const cell = (td) => inl(td).replace(/\n/g, " ").replace(/\|/g, "\\|");
    (function walk(p, depth) {
      for (const c of Array.from(p.childNodes)) {
        if (c.nodeType === 3) { const t = c.nodeValue.trim(); if (t) blocks.push(escText(t.replace(/\s+/g, " "), true)); continue; }
        if (c.nodeType !== 1) continue;
        const tag = c.tagName;
        if (/^(SCRIPT|STYLE|META|LINK|TITLE|HEAD)$/.test(tag)) continue;
        if (/^H[1-6]$/.test(tag)) { const t = inl(c); if (t) blocks.push("#".repeat(Math.min(3, +tag[1])) + " " + t.replace(/\n/g, " ")); continue; }
        if (tag === "P") { const t = inl(c); if (t) blocks.push(t); continue; }
        if (tag === "UL" || tag === "OL") { blocks.push(list(c, depth || 0).join("\n")); continue; }
        if (tag === "BLOCKQUOTE") { const t = inl(c); if (t) blocks.push(t.split("\n").map((l) => "> " + l).join("\n")); continue; }
        if (tag === "PRE") { blocks.push("\x60\x60\x60\n" + c.textContent.replace(/\n$/, "") + "\n\x60\x60\x60"); continue; }
        if (tag === "HR") { blocks.push("---"); continue; }
        if (tag === "TABLE") {
          const rows = Array.from(c.querySelectorAll("tr")).map((tr) => Array.from(tr.children).filter((x) => /^T[DH]$/.test(x.tagName)).map(cell));
          const w = Math.max(0, ...rows.map((r) => r.length));
          if (w) {
            const pad = (r) => r.concat(Array(w - r.length).fill(""));
            blocks.push(["| " + pad(rows[0]).join(" | ") + " |", "| " + Array(w).fill("---").join(" | ") + " |"].concat(rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |")).join("\n"));
          }
          continue;
        }
        if (/^(DIV|SECTION|ARTICLE|MAIN|BODY|HEADER|FOOTER|ASIDE|NAV|FIGURE|CENTER)$/.test(tag)) {
          // 裡面有區塊（段落、清單）就往下走；只有字的 div（Google 文件、Notion 常這樣）就是一段
          if (c.querySelector("p, div, h1, h2, h3, h4, h5, h6, ul, ol, table, pre, blockquote, hr")) walk(c, depth);
          else { const t = inl(c); if (t) blocks.push(t); }
          continue;
        }
        const t = inl(c);
        if (t) blocks.push(t);
      }
    })(doc.body || doc, 0);
    function list(ul, depth) {
      const out = [], ordered = ul.tagName === "OL";
      for (const li of Array.from(ul.children)) {
        if (li.tagName !== "LI") continue;
        const own = li.cloneNode(true);
        own.querySelectorAll("ul, ol").forEach((x) => x.remove());
        const box = own.querySelector('input[type="checkbox"]');
        const todo = box ? (box.checked ? "[x] " : "[ ] ") : "";
        if (box) box.remove();
        out.push("  ".repeat(depth) + (ordered ? "1. " : "- ") + todo + inl(own).replace(/\n/g, " "));
        for (const sub of Array.from(li.children)) if (sub.tagName === "UL" || sub.tagName === "OL") out.push(...list(sub, Math.min(4, depth + 1)));
      }
      return out;
    }
    return blocks.filter((b) => b.trim()).join("\n\n");
  }

  /* 純文字：從 PDF、網頁複製來的常有斷行、斷字、中文字之間多的空白；• ・ 1、 開頭的變成清單；Tab 分開的變成表格 */
  function cleanPaste(t) {
    let s = String(t || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
    const lines = s.split("\n");
    // 每一行都用 Tab 分成好幾格：表格
    if (lines.filter((l) => l.trim()).length >= 2 && lines.filter((l) => l.trim()).every((l) => l.includes("\t"))) {
      const rows = lines.filter((l) => l.trim()).map((l) => l.split("\t").map((x) => x.trim().replace(/\|/g, "\\|")));
      const w = Math.max(...rows.map((r) => r.length));
      const pad = (r) => r.concat(Array(w - r.length).fill(""));
      return ["| " + pad(rows[0]).join(" | ") + " |", "| " + Array(w).fill("---").join(" | ") + " |"].concat(rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |")).join("\n");
    }
    const CJK = "\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff";
    s = s.replace(new RegExp("([" + CJK + "]) (?=[" + CJK + "])", "g"), "$1");                // 中文字之間多的空白
    s = s.replace(/^[ \t]*[•・●▪◦‣∙][ \t]*/gm, "- ").replace(/^[ \t]*[–—−][ \t]+/gm, "- ");      // 各種圓點 → 清單
    s = s.replace(/^[ \t]*(\d{1,3})[、．][ \t]*/gm, "$1. ").replace(/^[ \t]*[①②③④⑤⑥⑦⑧⑨⑩][ \t]*/gm, "1. ");
    // 斷行：上一行沒有句尾標點、夠長，下一行接著是小寫、中文或數字 → 接起來（行尾的連字號拿掉）
    const out = [];
    for (const line of s.split("\n")) {
      const prev = out[out.length - 1];
      const join = prev != null && prev.trim() && line.trim() && !/^\s*([-*+>#]|\d+[.)]\s|\|)/.test(line) && !/^\s*([-*+>#]|\d+[.)]\s|\|)/.test(prev) &&
        prev.trim().length >= 25 && !/[.!?:;。！？：；」』）)\]]\s*$/.test(prev) && new RegExp("^\\s*[a-z0-9(" + CJK + "]").test(line);
      if (join) {
        if (/[A-Za-z]-$/.test(prev)) out[out.length - 1] = prev.replace(/-$/, "") + line.trim();
        else out[out.length - 1] = prev.replace(/\s+$/, "") + (new RegExp("[" + CJK + "]$").test(prev) && new RegExp("^\\s*[" + CJK + "]").test(line) ? "" : " ") + line.trim();
      } else out.push(line);
    }
    return out.join("\n");
  }

  /* Markdown 裡看得到的有幾格（併段時游標要放在接縫上）；兩段 Markdown 接起來（樣式在接縫上合併，不會變成 **a****b**） */
  const lenOf = (md) => runsOfTree(parse(md)).reduce((n, r) => n + (r.t != null ? r.t.length : 1), 0);
  const join = (a, b) => emit(runsOfTree(parse(a)).concat(runsOfTree(parse(b))));
  /* Markdown 從第 k 格開始的那一段（拿掉開頭的記號字、轉成清單時用） */
  function dropMd(md, k) {
    const out = [];
    let pos = 0;
    for (const r of runsOfTree(parse(md))) {
      const len = r.t != null ? r.t.length : 1;
      if (pos + len > k) out.push(r.t != null && pos < k ? Object.assign({}, r, { t: r.t.slice(k - pos) }) : r);
      pos += len;
    }
    return emit(out);
  }
  const plainOf = (md) => runsOfTree(parse(md)).map((r) => (r.t != null ? r.t : r.br ? "\n" : "\uFFFC")).join("");

  PR.rich = { parse, runsOfTree, emit, lenOf, join, dropMd, plainOf, html, texHtml, runs, md, length, caret, setCaret, slice, text, onFirstLine, onLastLine, endsWithEmptyLine, toggle, active, insertTex, setTex, link, linkAt, insertLink, autoformat, tidy, fromHtml, cleanPaste, isAtom, ZW };
})(window.PR);
