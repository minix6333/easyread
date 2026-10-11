/* 液態玻璃（vendor/liquid-glass.js 的接法）：浮在內容上面的東西——頂欄的控制項、浮動工具列、選單、提示——
   邊緣把底下的內容折射一點點、中間保持清楚（Chromium 才有折射；Safari／Firefox 退回毛玻璃）。
   材質的樣子（色、亮邊、影）在 css/glass.css 的 --lg-* 變數；這裡只管光學。
   用法：元素加 data-glass（空＝一般、"soft"＝小控制項、"strong"＝大浮層），或 PR.glass(el, opts)。
   後來才長出來的元素（選單、工具列）由 MutationObserver 接手；減少透明度→不折射、只上實色（.lg-flat）。 */
(function (PR) {
  "use strict";
  const reduceT = matchMedia("(prefers-reduced-transparency: reduce)");
  // 小控制項：折射淺一點、底下糊一點，字才讀得清；大浮層：折射明顯、邊比較厚
  const PRESET = {
    soft: { scale: -46, chroma: 3, border: 0.1, mapBlur: 9, blur: 10 },
    "": { scale: -72, chroma: 4, border: 0.08, mapBlur: 12, blur: 10 },
    strong: { scale: -104, chroma: 6, border: 0.07, mapBlur: 14, blur: 12 },
  };
  // 哪些東西是玻璃（JS 畫出來的也算）：選擇器 → 預設
  const AUTO = [
    [".topbar > .btn.icon, .topbar > .brand-back, .topbar > .save-state, .topbar > .job-state, .topbar > .search, .topbar > .seg, .topbar > .pv-head, .topbar > .btn.accent, .topbar > .btn.line, #tabs .btn.icon", "soft"],
    [".pv-fabs .fab, .askline, .jump-back, #findbar", "soft"],
    [".menu, .popover, .bk-menu, .ch-list, .ch-menu, .ch-docpop, #toast, .ch-aside, .ch-compose, .nai-box, .sync-pop, #dockDrop", "strong"],
  ];
  const live = new WeakMap();

  function apply(el, kind, opts) {
    if (!el || live.has(el)) return live.get(el);
    el.classList.add("lg");
    if (kind) el.dataset.glass = kind;
    if (reduceT.matches || typeof liquidGlass !== "function") { el.classList.add("lg-flat"); return null; }
    const o = Object.assign({ saturate: 1.5, fallbackBlur: 24 }, PRESET[kind || ""] || PRESET[""], opts || {});
    try {
      const g = liquidGlass(el, o);
      live.set(el, g);
      if (!g.supported) el.classList.add("lg-frost");
      return g;
    } catch (e) { el.classList.add("lg-flat"); return null; }
  }
  PR.glass = (el, opts) => apply(el, (el && el.dataset.glass) || (opts && opts.kind) || "", opts);
  PR.glassRefresh = (el) => { const g = live.get(el); if (g) g.refresh(); };

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
