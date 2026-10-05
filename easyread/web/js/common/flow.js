/* 筆記和 AI 回答裡的圖：```flow（或 ```mermaid）程式碼區塊畫成圖。
   語法是 Mermaid flowchart 的子集，夠畫流程圖、架構圖（subgraph 分層分組，可巢狀、可指定 direction）、關係圖：
     flowchart LR | TD
     A[方框]  B(圓角)  C([起點／終點])  D{判斷}  E[(資料)]      文字可用 "…" 包起來、<br> 換行、$TeX$
     A --> B   A -->|說明| B   A -.-> B   A ==> B   A <--> B   A --- B   可連寫、可用 & 併排
     subgraph id[標題] … end      組裡可寫 direction LR；可以用組的 id 連線
   自己排版、自己畫（節點是 HTML，所以公式照常顯示；線是 SVG），顏色全走 CSS 變數，深色模式不用另外處理。
   不引入 Mermaid 本體（3 MB，而且樣式和這裡不搭）。別的圖種（sequenceDiagram…）不認，照程式碼顯示（markup.js）。
   PR.flowParse / PR.flowLayout / PR.flowRoute 是純函式（tests/test_flow.cjs）。 */
(function (PR) {
  "use strict";
  const DIRS = { TD: "TD", TB: "TD", BT: "TD", LR: "LR", RL: "LR" };
  const ID = /^\s*([\wÀ-￿]+)/;
  // 形狀：先試帶引號的（文字裡可以有括號），再試一般的
  const SHAPES = [
    [/^\(\[\s*"([\s\S]*?)"\s*\]\)/, "pill"], [/^\[\(\s*"([\s\S]*?)"\s*\)\]/, "db"], [/^\(\(\s*"([\s\S]*?)"\s*\)\)/, "pill"],
    [/^\{\{\s*"([\s\S]*?)"\s*\}\}/, "decision"], [/^\[\s*"([\s\S]*?)"\s*\]/, "rect"], [/^\(\s*"([\s\S]*?)"\s*\)/, "round"], [/^\{\s*"([\s\S]*?)"\s*\}/, "decision"],
    [/^\(\[([\s\S]*?)\]\)/, "pill"], [/^\[\(([\s\S]*?)\)\]/, "db"], [/^\(\(([\s\S]*?)\)\)/, "pill"], [/^\[\[([\s\S]*?)\]\]/, "rect"],
    [/^\{\{([\s\S]*?)\}\}/, "decision"], [/^\[([\s\S]*?)\]/, "rect"], [/^\(([\s\S]*?)\)/, "round"], [/^\{([\s\S]*?)\}/, "decision"], [/^>([\s\S]*?)\]/, "rect"],
  ];
  const EDGE_TEXT = [  // A -- 說明 --> B 這種把說明寫在線中間的
    [/^\s*--\s+([^-][\s\S]*?)\s+--+>/, ""], [/^\s*-\.\s+([\s\S]*?)\s+\.-+>/, "dotted"], [/^\s*==\s+([\s\S]*?)\s+==+>/, "thick"],
  ];
  const EDGE = /^\s*(<)?(-\.+-|--+|==+)([>xo])?(?:\s*\|([^|]*)\|)?/;

  PR.flowParse = function (src) {
    const g = { dir: "TD", nodes: {}, groups: {}, seq: [], edges: [] };
    const stack = [];
    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const node = (id, text, shape) => {
      let n = g.nodes[id];
      if (!n) { n = g.nodes[id] = { id, text: id, shape: "rect", group: top(), plain: true }; g.seq.push({ kind: "node", id }); }
      if (text != null) { n.text = text.replace(/<br\s*\/?>/gi, "\n").trim() || id; n.shape = shape; n.plain = false; if (top() && !n.group) n.group = top(); }
      return n;
    };
    for (const raw of String(src || "").replace(/\r/g, "").split(/\n|;/)) {
      let s = raw.trim(), m;
      if (!s || s.startsWith("%%")) continue;
      if ((m = /^(?:flowchart|graph)\b\s*(\w+)?/i.exec(s))) { g.dir = DIRS[(m[1] || "TD").toUpperCase()] || "TD"; continue; }
      if ((m = /^subgraph\s+(.+)$/i.exec(s))) {
        const mm = /^([\wÀ-￿]+)\s*\[\s*"?([\s\S]*?)"?\s*\]\s*$/.exec(m[1]);
        const bare = /^[\wÀ-￿]+$/.test(m[1].trim());
        const id = mm ? mm[1] : bare ? m[1].trim() : "__g" + Object.keys(g.groups).length;
        g.groups[id] = { id, title: mm ? mm[2] : m[1].trim().replace(/^"|"$/g, ""), parent: top(), dir: null };
        g.seq.push({ kind: "group", id });
        stack.push(id);
        continue;
      }
      if (/^end\b/i.test(s)) { stack.pop(); continue; }
      if ((m = /^direction\s+(\w+)/i.exec(s))) { if (top()) g.groups[top()].dir = DIRS[m[1].toUpperCase()] || null; continue; }
      if (/^(style|classDef|class|linkStyle|click)\b/i.test(s)) continue;
      let prev = null, pending = null;
      for (let guard = 0; s && guard < 50; guard++) {
        const ids = [];
        for (;;) {
          const im = ID.exec(s);
          if (!im) break;
          s = s.slice(im[0].length);
          let text = null, shape = "rect";
          for (const [re, sh] of SHAPES) { const sm = re.exec(s); if (sm) { text = sm[1]; shape = sh; s = s.slice(sm[0].length); break; } }
          s = s.replace(/^:::[\w-]+/, "");
          ids.push(node(im[1], text, shape).id);
          if (/^\s*&/.test(s)) { s = s.replace(/^\s*&\s*/, ""); continue; }
          break;
        }
        if (!ids.length) break;
        if (prev && pending) for (const a of prev) for (const b of ids) g.edges.push(Object.assign({ from: a, to: b }, pending));
        prev = ids;
        pending = null;
        for (const [re, style] of EDGE_TEXT) { const em = re.exec(s); if (em) { pending = { label: em[1].trim(), style, arrow: true, both: false }; s = s.slice(em[0].length); break; } }
        if (!pending) {
          const em = EDGE.exec(s);
          if (!em || !em[0].trim()) break;
          pending = { label: (em[4] || "").trim().replace(/^"|"$/g, ""), style: em[2][0] === "=" ? "thick" : em[2].includes(".") ? "dotted" : "", arrow: !!em[3], both: !!em[1] };
          s = s.slice(em[0].length);
        }
      }
    }
    // 連線直接指到分組（A --> enc）：那個 id 不是節點
    for (const id of Object.keys(g.nodes)) if (g.groups[id] && g.nodes[id].plain) { delete g.nodes[id]; g.seq = g.seq.filter((x) => !(x.kind === "node" && x.id === id)); }
    return g;
  };

  const GAP_MAIN = 44, GAP_CROSS = 20, PAD = 14, TITLE = 30, LANE = 16;
  const textW = (s, wide, narrow) => Array.from(String(s || "")).reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? wide : narrow), 0);
  const parentOf = (g, id) => (g.nodes[id] ? g.nodes[id].group : g.groups[id] ? g.groups[id].parent : null) || null;
  /* 兩個東西（節點或分組）最近的共同那一層：回傳 {level, a, b}——level 是分組 id（最外層是 ""），a、b 是它們在那一層各自屬於哪一個。
     同一個、或其中一個包著另一個：null */
  function meet(g, x, y) {
    const chain = (id) => { const c = [id]; for (let p = parentOf(g, id); p; p = parentOf(g, p)) c.push(p); c.push(""); return c; };
    const cx = chain(x), cy = chain(y);
    for (let i = 1; i < cx.length; i++) {
      const j = cy.indexOf(cx[i]);
      if (j > 0) return cx[i - 1] === cy[j - 1] ? null : { level: cx[i], a: cx[i - 1], b: cy[j - 1] };
    }
    return null;
  }
  const dirOf = (g, level) => { for (let cur = level; cur; cur = g.groups[cur].parent) if (g.groups[cur].dir) return g.groups[cur].dir; return g.dir; };

  /* 排版：一層一層來（最外層，和每個分組裡面）。同一層裡把東西（節點、子分組）照連線方向分排，排內盡量對齊上下游；
     跨過好幾排的線在中間每一排留一個位置（不然線會從別的框底下穿過去）。
     sizeOf(id) → {w, h}。回傳 {w, h, nodes: {id: 框}, groups: {id: 框}, routes: {"層|a>b": [途經的點]}}（絕對座標）。 */
  PR.flowLayout = function (g, sizeOf) {
    const out = { nodes: {}, groups: {}, routes: {} };
    function level(parent, dir) {
      const td = dir !== "LR";
      const kids = [];
      for (const it of g.seq) {
        if (parentOf(g, it.id) !== parent) continue;
        if (it.kind === "node") { const s = sizeOf(it.id); kids.push({ id: it.id, w: s.w, h: s.h }); }
        else {
          const inner = level(it.id, g.groups[it.id].dir || dir);
          kids.push({ id: it.id, group: true, inner, w: Math.max(inner.w + PAD * 2, textW(g.groups[it.id].title, 12.5, 7) + 26), h: inner.h + PAD + TITLE });
        }
      }
      const index = {};
      kids.forEach((k, i) => (index[k.id] = i));
      const succ = kids.map(() => []), pred = kids.map(() => []);
      for (const e of g.edges) {
        const m = meet(g, e.from, e.to);
        if (!m || (m.level || null) !== parent || index[m.a] == null || index[m.b] == null) continue;
        const a = index[m.a], b = index[m.b];
        if (!succ[a].includes(b)) { succ[a].push(b); pred[b].push(a); }
      }
      // 分排：最長路徑；有環就把回頭的那條線當作不存在
      const n0 = kids.length;
      const layer = kids.map(() => 0), state = kids.map(() => 0);
      const back = new Set();
      const dfs = (u) => { state[u] = 1; for (const v of succ[u]) { if (state[v] === 1) back.add(u + ">" + v); else if (!state[v]) dfs(v); } state[u] = 2; };
      for (let i = 0; i < n0; i++) if (!state[i]) dfs(i);
      const order = [], seen = kids.map(() => false);
      const topo = (u) => { if (seen[u]) return; seen[u] = true; for (const v of succ[u]) if (!back.has(u + ">" + v)) topo(v); order.unshift(u); };
      for (let i = 0; i < n0; i++) topo(i);
      for (const u of order) for (const v of succ[u]) if (!back.has(u + ">" + v)) layer[v] = Math.max(layer[v], layer[u] + 1);
      // 跨排的線：中間每一排放一個不佔高度的佔位，線就從那裡過。nb[i]：和 i 連著的（不分方向，排版只看誰在上一排、誰在下一排）
      const nb = kids.map((_, i) => succ[i].concat(pred[i]));
      const routes = {};
      for (let u = 0; u < n0; u++) for (const v of succ[u]) {
        const lo = layer[u] < layer[v] ? u : v, hi = lo === u ? v : u;
        if (layer[hi] - layer[lo] < 2) continue;
        nb[u].splice(nb[u].indexOf(v), 1); nb[v].splice(nb[v].indexOf(u), 1);
        const via = [];
        let prev = lo;
        for (let L = layer[lo] + 1; L < layer[hi]; L++) {
          const d = kids.length;
          kids.push({ id: "__via" + d, via: true, w: td ? LANE : 0, h: td ? 0 : LANE });
          layer.push(L); nb.push([prev]); nb[prev].push(d);
          via.push(d); prev = d;
        }
        nb[prev].push(hi); nb[hi].push(prev);
        routes[kids[u].id + ">" + kids[v].id] = (lo === u ? via : via.slice().reverse()).map((i) => kids[i].id);
      }
      const layers = [];
      kids.forEach((_, i) => (layers[layer[i]] = layers[layer[i]] || []).push(i));
      for (let i = 0; i < layers.length; i++) layers[i] = layers[i] || [];
      const main = (k) => (td ? k.h : k.w), cross = (k) => (td ? k.w : k.h);
      const up = kids.map((_, i) => nb[i].filter((j) => layer[j] < layer[i]));
      const down = kids.map((_, i) => nb[i].filter((j) => layer[j] > layer[i]));
      // 排內順序：照上游的位置排（重心法），來回各一次
      const posIn = kids.map(() => 0);
      const reindex = () => layers.forEach((L) => L.forEach((i, p) => (posIn[i] = p)));
      reindex();
      const sortBy = (L, near) => {
        const b = {};
        layers[L].forEach((i) => (b[i] = near[i].length ? near[i].reduce((a, j) => a + posIn[j], 0) / near[i].length : posIn[i]));
        layers[L].sort((x, y) => b[x] - b[y] || x - y);
        reindex();
      };
      for (let L = 1; L < layers.length; L++) sortBy(L, up);
      for (let L = layers.length - 2; L >= 0; L--) sortBy(L, down);
      // 座標：排內先緊排，再往上下游的中心靠（擠到的往旁邊讓，整排再平均挪回來，左右才對稱）
      const start = kids.map(() => 0);
      layers.forEach((L) => { let c = 0; L.forEach((i) => { start[i] = c; c += cross(kids[i]) + GAP_CROSS; }); });
      const center = (i) => start[i] + cross(kids[i]) / 2;
      const align = (L, near) => {
        const ids = layers[L];
        if (!ids.length) return;
        let cursor = -Infinity, shift = 0;
        for (const i of ids) {
          const want = near[i].length ? near[i].reduce((a, j) => a + center(j), 0) / near[i].length - cross(kids[i]) / 2 : start[i];
          start[i] = Math.max(want, cursor);
          cursor = start[i] + cross(kids[i]) + GAP_CROSS;
          shift += start[i] - want;
        }
        shift /= ids.length;
        for (const i of ids) start[i] -= shift;
      };
      for (let pass = 0; pass < 2; pass++) {
        for (let L = 1; L < layers.length; L++) align(L, up);
        for (let L = layers.length - 2; L >= 0; L--) align(L, down);
      }
      const minC = kids.length ? Math.min(...start) : 0;
      const pos = {};
      let W = 0, H = 0, acc = 0;
      layers.forEach((L) => {
        const band = Math.max(0, ...L.map((i) => main(kids[i])));
        for (const i of L) {
          const k = kids[i], c = start[i] - minC, m = acc + (band - main(k)) / 2;
          pos[k.id] = td ? { x: c, y: m, w: k.w, h: k.h } : { x: m, y: c, w: k.w, h: k.h };
          W = Math.max(W, pos[k.id].x + k.w); H = Math.max(H, pos[k.id].y + k.h);
        }
        acc += band + GAP_MAIN;
      });
      return { w: W, h: H, pos, kids, routes };
    }
    function place(lv, ox, oy, key) {
      for (const k of lv.kids) {
        if (k.via) continue;
        const p = lv.pos[k.id], box = { x: ox + p.x, y: oy + p.y, w: p.w, h: p.h };
        if (k.group) { out.groups[k.id] = box; place(k.inner, box.x + (box.w - k.inner.w) / 2, box.y + TITLE, k.id); }
        else out.nodes[k.id] = box;
      }
      for (const [pair, ids] of Object.entries(lv.routes)) out.routes[key + "|" + pair] = ids.map((id) => ({ x: ox + lv.pos[id].x + lv.pos[id].w / 2, y: oy + lv.pos[id].y + lv.pos[id].h / 2 }));
    }
    const root = level(null, g.dir);
    place(root, 0, 0, "");
    out.w = Math.ceil(root.w); out.h = Math.ceil(root.h);
    return out;
  };
  PR.flowMeet = meet;

  /* 一條線怎麼走：照那一層的方向從框的邊緣中點出發（上下排的走上下邊，左右排的走左右邊），經過中間留的位置，平滑地彎過去 */
  PR.flowRoute = function (a, b, dir, via) {
    via = via || [];
    const td = dir !== "LR";
    const apart = td ? a.y + a.h <= b.y || b.y + b.h <= a.y : a.x + a.w <= b.x || b.x + b.w <= a.x;
    const alongY = via.length || apart ? td : !td;  // 同一排的兩個框：改走側邊
    const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const port = (r, to) => (alongY ? { x: r.x + r.w / 2, y: to.y > r.y + r.h / 2 ? r.y + r.h : r.y } : { x: to.x > r.x + r.w / 2 ? r.x + r.w : r.x, y: r.y + r.h / 2 });
    const pts = [port(a, via.length ? via[0] : mid(b))].concat(via, [port(b, via.length ? via[via.length - 1] : mid(a))]);
    const r = (v) => Math.round(v * 10) / 10;
    let d = "M" + r(pts[0].x) + " " + r(pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      d += alongY ? " C" + r(p.x) + " " + r((p.y + q.y) / 2) + " " + r(q.x) + " " + r((p.y + q.y) / 2) + " " + r(q.x) + " " + r(q.y)
        : " C" + r((p.x + q.x) / 2) + " " + r(p.y) + " " + r((p.x + q.x) / 2) + " " + r(q.y) + " " + r(q.x) + " " + r(q.y);
    }
    const k = Math.floor((pts.length - 1) / 2);
    return { d, mid: { x: (pts[k].x + pts[k + 1].x) / 2, y: (pts[k].y + pts[k + 1].y) / 2 } };
  };

  /* 同一張圖有幾種排法，挑容器放得下的：照原樣 → 主方向對調 → 全部直排（窄的筆記卡片裡，橫的一長串會改成由上到下）。
     所以卡片、便利貼、面板拉寬拉窄時，圖會跟著重排，不是只有縮小。 */
  const VARIANTS = ["", "flip", "tall"];
  function variant(g, v) {
    if (!v) return g;
    const groups = {};
    for (const [id, x] of Object.entries(g.groups)) groups[id] = v === "tall" ? Object.assign({}, x, { dir: null }) : x;
    return Object.assign({}, g, { dir: v === "tall" ? "TD" : g.dir === "LR" ? "TD" : "LR", groups });
  }
  let seq = 0;
  function build(g, L, md) {
    let h = "";
    for (const [gid, p] of Object.entries(L.groups)) {
      h += '<div class="mf-group" style="left:' + p.x + "px;top:" + p.y + "px;width:" + p.w + "px;height:" + p.h + 'px"><b>' + md(g.groups[gid].title || "") + "</b></div>";
    }
    const mk = "mfa" + ++seq;
    let paths = "", labels = "";
    for (const e of g.edges) {
      const a = L.nodes[e.from] || L.groups[e.from], b = L.nodes[e.to] || L.groups[e.to];
      const m = meet(g, e.from, e.to);
      if (!a || !b || !m) continue;
      const { d, mid } = PR.flowRoute(a, b, dirOf(g, m.level), L.routes[m.level + "|" + m.a + ">" + m.b]);
      paths += '<path d="' + d + '"' + (e.style ? ' class="' + e.style + '"' : "") + (e.arrow || e.both ? ' marker-end="url(#' + mk + ')"' : "") + (e.both ? ' marker-start="url(#' + mk + 's)"' : "") + "/>";
      if (e.label) labels += '<span class="mf-label" style="left:' + mid.x + "px;top:" + mid.y + 'px">' + md(e.label) + "</span>";
    }
    const arrow = (id, rev) => '<marker id="' + id + '" viewBox="0 0 10 10" refX="' + (rev ? 1 : 9) + '" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="' + (rev ? "M10 1.5 L1 5 L10 8.5 z" : "M0 1.5 L9 5 L0 8.5 z") + '"/></marker>';
    h += '<svg width="' + L.w + '" height="' + L.h + '"><defs>' + arrow(mk) + arrow(mk + "s", true) + "</defs>" + paths + "</svg>";
    for (const [id, p] of Object.entries(L.nodes)) {
      h += '<div class="mf-node mf-' + g.nodes[id].shape + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + p.w + "px;height:" + p.h + 'px"><span>' + md(g.nodes[id].text) + "</span></div>";
    }
    return '<div class="mf" data-w="' + L.w + '" style="width:' + L.w + "px;height:" + L.h + 'px">' + h + labels + "</div>";
  }

  const memo = new Map();  // 原始碼 → {g, sizes, layout: {排法: L}, html: {排法: HTML}, last}。回答串流時同一張圖會被重新插進頁面很多次，不能每次重量重排
  PR.flowCached = (src) => { const m = memo.get(src); return (m && m.last) || ""; };  // markup.js 直接把畫好的放進去，不會閃一下
  PR.renderFlow = function (el) {
    const src = el.dataset.flow || "";
    let m = memo.get(src);
    if (!m) {
      if (memo.size > 300) memo.clear();
      memo.set(src, (m = { g: PR.flowParse(src), sizes: null, layout: {}, html: {}, last: "" }));
    }
    const g = m.g, ids = Object.keys(g.nodes);
    if (!ids.length) { el.innerHTML = "<pre><code>" + PR.esc(src) + "</code></pre>"; return; }
    const md = (t) => (PR.md ? PR.md(t, { cite: false, xref: false }) : PR.esc(t).replace(/\n/g, "<br>"));
    let sizes = m.sizes;
    if (!sizes) {  // 量每個節點要多大（一張圖只量一次）
      const box = document.createElement("div");
      box.className = "mf";
      box.innerHTML = ids.map((id) => '<div class="mf-node mf-' + g.nodes[id].shape + '"><span>' + md(g.nodes[id].text) + "</span></div>").join("");
      el.replaceChildren(box);
      const kids = Array.from(box.children);
      sizes = {};
      if (kids.every((d) => d.offsetWidth > 0)) { ids.forEach((id, i) => (sizes[id] = { w: kids[i].offsetWidth + 1, h: kids[i].offsetHeight })); m.sizes = sizes; }
      else ids.forEach((id) => {  // 藏著的時候量不到：先估一個，不記下來
        const lines = g.nodes[id].text.split("\n");
        sizes[id] = { w: Math.min(200, Math.max(56, Math.max(...lines.map((l) => textW(l, 13, 7.2))) + 26)), h: 20 * lines.length + 16 };
      });
    }
    const avail = el.clientWidth - 20;
    let best = null;
    for (const v of VARIANTS) {
      const gv = variant(g, v);
      const L = (m.sizes && m.layout[v]) || PR.flowLayout(gv, (id) => sizes[id]);
      if (m.sizes) m.layout[v] = L;
      const scale = avail > 0 ? Math.min(1, avail / L.w) : 1;
      if (!best || scale > best.scale + 0.04) best = { v, gv, L, scale };
      if (scale >= (v ? 1 : 0.85)) break;  // 原本的排法只差一點就放得下：稍微縮一下就好，不改排法
    }
    let changed = false;
    if (el.dataset.variant !== best.v || !el.firstElementChild || !el.firstElementChild.dataset.w) {
      const html = (m.sizes && m.html[best.v]) || build(best.gv, best.L, md);
      if (m.sizes) { m.html[best.v] = html; m.last = html; }
      el.innerHTML = html;
      el.dataset.variant = best.v;
      changed = true;
    }
    fit(el);
    return changed;
  };

  /* 還是比容器寬：縮到放得下（最小 62%，再小字就看不清了，改成橫向捲動） */
  function fit(el) {
    const mf = el.firstElementChild;
    if (!mf || !mf.dataset || !mf.dataset.w) return;
    const avail = el.clientWidth - 20;
    if (avail > 0) mf.style.zoom = Math.max(0.62, Math.min(1, avail / +mf.dataset.w)).toFixed(3);
  }

  /* 頁面上哪裡多出了圖，就畫（聊天、卡片、便利貼、筆記面板都走這裡，不用每個地方各自呼叫）；容器寬度變了就重新挑排法 */
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body) {
    const seen = new WeakSet();
    const draw = (el) => { try { return PR.renderFlow(el); } catch (e) { el.innerHTML = "<pre><code>" + PR.esc(el.dataset.flow || "") + "</code></pre>"; return true; } };
    // 圖畫好、或換了排法，高度就變了：告訴外面（卡片要重新疊放、太長的要收起）
    const tell = (els) => { if (els.length && PR.emit) PR.emit("flow-drawn", els); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver((list) => tell(list.map((x) => x.target).filter((el) => el.isConnected && draw(el)))) : null;
    let queued = false;
    const run = () => {
      queued = false;
      const drawn = [];
      document.querySelectorAll(".md-flow").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const had = el.firstElementChild ? el.offsetHeight : -1;
        el.dataset.variant = "?";  // markup.js 放進來的是上次畫的那一種，這個容器不一定合適：重新挑
        draw(el);
        if (el.offsetHeight !== had) drawn.push(el);
        if (ro) ro.observe(el);
      });
      tell(drawn);
    };
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(document.body, { childList: true, subtree: true });
    run();
  }
})(window.PR);
