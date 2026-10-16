/* 液態玻璃（vendor/liquid-glass.js 的接法）：浮在內容上面的東西——頂欄的控制項、浮動工具列、選單、提示——
   邊緣把底下的內容折射一點點、中間保持清楚（Chromium 才有折射；Safari／Firefox 退回毛玻璃）。
   材質的樣子（色、亮邊、影）在 css/glass.css 的 --lg-* 變數；這裡只管光學。
   用法：元素加 data-glass（空＝一般、"soft"＝小控制項、"strong"＝大浮層），或 PR.glass(el, opts)。
   後來才長出來的元素（選單、工具列）由 MutationObserver 接手；減少透明度→不折射、只上實色（.lg-flat）。
   折射的強度是設定裡的「玻璃折射」（easyread-prefs.glass，0–100，60 是預設的樣子，0 是只有毛玻璃不折射）：
   PR.setGlass(v) 立刻套到這一頁所有玻璃上，別的分頁（外殼裡的 iframe）靠 storage 事件跟上。 */
(function (PR) {
  "use strict";
  const reduceT = matchMedia("(prefers-reduced-transparency: reduce)");
  // 小控制項：折射淺一點、底下糊一點，字才讀得清；大浮層：折射明顯、邊比較厚（這是強度 60 的數字）
  const PRESET = {
    soft: { scale: -46, chroma: 3, border: 0.1, mapBlur: 9, blur: 10 },
    "": { scale: -72, chroma: 4, border: 0.08, mapBlur: 12, blur: 10 },
    strong: { scale: -104, chroma: 6, border: 0.07, mapBlur: 14, blur: 12 },
  };
  const BASE = 60;
  // 哪些東西是玻璃（JS 畫出來的也算）：選擇器 → 預設
  const AUTO = [
    [".topbar > .btn.icon, .topbar > .brand-back, .topbar > .bar-group, .topbar > .job-state, .topbar > .search, .topbar .seg, .list-head > .btn.icon", "soft"],
    ["#pageview > .pv-head, .pv-ai .fab, .askline, .jump-back, #findbar", "soft"],
    [".menu, .popover, .bk-menu, .ch-list, .ch-menu, .ch-docpop, #toast, .ch-aside, .ch-compose, .nai-box, .sync-pop, #dockDrop", "strong"],
  ];
  const live = new WeakMap();   // 元素 → 模組給的把手
  const all = new Set();        // 這一頁所有的玻璃（改強度時整批重做）

  function level() {
    const v = Number((PR.ls && PR.ls.get("easyread-prefs", {}) || {}).glass);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : BASE;
  }
  PR.glassLevel = level;

  /* 畫面正在換版面（PR.morph 的 View Transitions 正在拍新畫面，<html data-vt>）：做折射的 map（canvas → toDataURL）這時候會卡在等 GPU，
     一塊輸入框就要一百多毫秒、面板晚一拍才開始滑。先只掛上材質的 class，折射等換完再補（看不太出來：只差邊上那一圈）。 */
  const waiting = new Map();  // 元素 → [kind, opts]
  let waitT = 0;
  const busy = () => !!document.documentElement.dataset.vt;
  function later() {
    if (waitT) return;
    waitT = setTimeout(() => {
      waitT = 0;
      if (busy()) { later(); return; }
      const list = Array.from(waiting);
      waiting.clear();
      for (const [el, [kind, opts]] of list) if (el.isConnected && !live.has(el)) optics(el, kind, opts);
    }, 160);
  }
  function apply(el, kind, opts) {
    if (!el || live.has(el)) return live.get(el);
    el.classList.add("lg");
    if (kind) el.dataset.glass = kind;
    all.add(el);
    if (reduceT.matches || typeof liquidGlass !== "function") { el.classList.add("lg-flat"); return null; }
    if (busy()) { waiting.set(el, [kind, opts]); later(); return null; }
    return optics(el, kind, opts);
  }
  function optics(el, kind, opts) {
    const k = level() / BASE;
    const p = PRESET[kind || ""] || PRESET[""];
    if (k <= 0) {  // 強度 0：只有毛玻璃，不折射
      const frost = "blur(" + (p.blur + 8) + "px) saturate(1.5)";
      el.style.backdropFilter = frost; el.style.webkitBackdropFilter = frost;
      el.classList.add("lg-frost");
      const h = { supported: false, refresh() {}, destroy() { el.style.backdropFilter = ""; el.style.webkitBackdropFilter = ""; el.classList.remove("lg-frost"); } };
      live.set(el, h);
      return h;
    }
    const o = Object.assign({ saturate: 1.5, fallbackBlur: 24 }, p, { scale: Math.round(p.scale * k), chroma: +(p.chroma * k).toFixed(1) }, opts || {});
    try {
      const g = liquidGlass(el, o);
      live.set(el, g);
      if (!g.supported) el.classList.add("lg-frost");
      else bake(el, o);
      return g;
    } catch (e) { el.classList.add("lg-flat"); return null; }
  }
  /* 模組把 backdrop-filter 設成 url(#濾鏡) blur() saturate()，但 Chromium 不會把 url() 後面那兩個套上去（實測：底下的字透上來還是清清楚楚的，
     蓋在文字上的工具列、膠囊看起來很花）。所以把模糊和飽和做進模組建的那個 SVG 濾鏡裡——先模糊、再折射、最後加飽和——backdrop-filter 只留 url()。
     模組之後只會改 feImage（折射的 map），加進去的這兩個節點不受影響；destroy() 是整個濾鏡一起拿掉。 */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function bake(el, o) {
    const m = /url\(["']?#([\w-]+)["']?\)/.exec(el.style.backdropFilter || "");
    const f = m && document.getElementById(m[1]);
    if (!f || f.querySelector("feGaussianBlur")) return;
    if (o.blur > 0) {
      const b = document.createElementNS(SVG_NS, "feGaussianBlur");
      b.setAttribute("in", "SourceGraphic");
      b.setAttribute("stdDeviation", String(o.blur));
      b.setAttribute("edgeMode", "duplicate");  // 邊上的顏色往外延伸，邊緣才不會糊成半透明
      b.setAttribute("result", "soft");
      f.insertBefore(b, f.firstChild);
      f.querySelectorAll("feDisplacementMap").forEach((d) => d.setAttribute("in", "soft"));
    }
    if (o.saturate && o.saturate !== 1) {
      const c = document.createElementNS(SVG_NS, "feColorMatrix");
      c.setAttribute("type", "saturate");
      c.setAttribute("values", String(o.saturate));
      f.appendChild(c);  // 接在最後一個節點（三個色版疊回來的結果）後面
    }
    el.style.backdropFilter = "url(#" + m[1] + ")";
  }
  PR.glass = (el, opts) => apply(el, (el && el.dataset.glass) || (opts && opts.kind) || "", opts);
  PR.glassRefresh = (el) => { const g = live.get(el); if (g) g.refresh(); };

  /* 改強度：每一塊都拆掉重做（模組的濾鏡是建好就不改的） */
  let cur = level();
  function reapply() {
    cur = level();
    for (const el of Array.from(all)) {
      if (!el.isConnected) { all.delete(el); continue; }
      const g = live.get(el);
      if (g) g.destroy();
      live.delete(el);
      el.classList.remove("lg-frost", "lg-flat");
      all.delete(el);
      apply(el, el.dataset.glass || "");
    }
  }
  PR.setGlass = function (v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const p = PR.ls.get("easyread-prefs", {});
    p.glass = v;
    PR.ls.set("easyread-prefs", p);
    if (PR.prefs) PR.prefs.glass = v;
    if (PR.savePrefs) PR.savePrefs("reader", { glass: v });
    reapply();
  };
  /* 視窗透明度（設定 → 閱讀）：0–100，75 是預設；只是把 --clear 掛到 <html>，材質和畫布的透明度在 craft.css 裡照它算 */
  const clearLevel = () => { const v = Number((PR.ls && PR.ls.get("easyread-prefs", {}) || {}).clear); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 75; };
  const applyClear = () => document.documentElement.style.setProperty("--clear", String(clearLevel()));
  PR.clearLevel = clearLevel;
  PR.setClear = function (v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const p = PR.ls.get("easyread-prefs", {});
    p.clear = v;
    PR.ls.set("easyread-prefs", p);
    if (PR.prefs) PR.prefs.clear = v;
    if (PR.savePrefs) PR.savePrefs("reader", { clear: v });
    applyClear();
  };
  applyClear();
  PR.glassSync = () => { applyClear(); if (level() !== cur) reapply(); };  // 偏好從別處換了（別的分頁、伺服器存的）：跟上
  addEventListener("storage", (e) => { if (e.key === "easyread-prefs") PR.glassSync(); });

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    for (const [sel, kind] of AUTO) {
      if (root.matches(sel)) apply(root, root.dataset.glass || kind);
      root.querySelectorAll(sel).forEach((el) => apply(el, el.dataset.glass || kind));
    }
    if (root.matches("[data-glass]")) apply(root, root.dataset.glass);
    root.querySelectorAll("[data-glass]").forEach((el) => apply(el, el.dataset.glass));
  }

  function boot() {
    scan(document.body);
    // 後來畫出來的：整批看一次就好（innerHTML 一次會進來很多節點）
    let queue = [], timer = 0;
    const flush = () => { timer = 0; const q = queue; queue = []; q.forEach(scan); };
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) queue.push(n);
      if (queue.length && !timer) timer = setTimeout(flush, 16);
    }).observe(document.body, { childList: true, subtree: true });
    // 開合（opacity 0→1）時尺寸沒變、map 還在；主題換了也不用重算。視窗大小變了由模組自己的 ResizeObserver 處理。
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window.PR = window.PR || {});
