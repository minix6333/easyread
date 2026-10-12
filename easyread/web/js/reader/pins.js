/* 釘住一塊：框選（S）之後按圖釘，那一塊——一張圖、一張表、一條公式——就浮在 PDF 這一格的角落；
   繼續往下讀的時候它一直在，讀到「如圖 3 所示」不用翻回去。可以拖位置、拉大小、點頁碼回到原處、按 × 收掉；可以釘好幾塊。
   畫的是那一頁的圖本身：一個 div 用 background 對到框的那一塊（不另外截圖、不經過伺服器、放大了也還是清楚的那張）。
   只留在這份文件這次開著的期間——它是眼前這一段要對照的東西，不是筆記。
   同一個框也可以設成這份文件在文獻庫的封面（PR.setCover，伺服器那邊是 covers.py）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const pins = [];
  let top = 7;
  const host = () => PR.$("#pageview");
  const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pageMeta = (n) => ((S.paper && S.paper.meta && S.paper.meta.pages) || [])[n - 1];
  const imgUrl = (p) => PR.imageUrl(p.img) + (PR.store.mode === "server" ? "?w=2400&v=2" : "");

  /* box：頁內座標 0–1 的 [x0, y0, x1, y1]。回傳那張卡片（已經釘了一樣的就把它拿到最上面） */
  PR.pinRegion = function (page, box) {
    const meta = pageMeta(page), h = host();
    if (!meta || !h || !box) return null;
    const same = pins.find((p) => p.page === page && p.box.every((v, i) => Math.abs(v - box[i]) < 0.004));
    if (same) { same.el.style.zIndex = String(++top); return same.el; }
    const [x0, y0, x1, y1] = box, bw = Math.max(0.02, x1 - x0), bh = Math.max(0.02, y1 - y0);
    const ratio = (bw * (meta.w || 612)) / (bh * (meta.h || 792));  // 寬 ÷ 高
    const el = PR.el("div", { class: "pin" },
      '<div class="pin-hd"><button data-pin="go" title="' + PR.esc(PR.t("回到這一頁")) + '">' + PR.icon("pin", "sm") + "<span>" + PR.esc(PR.t("第 {page} 页", { page })) + '</span></button><span class="grow"></span>' +
      '<button data-pin="x" title="' + PR.esc(PR.t("关闭")) + '">' + PR.icon("x", "sm") + '</button></div><div class="pin-img"></div><i class="pin-size"></i>');
    const img = el.querySelector(".pin-img");
    Object.assign(img.style, { aspectRatio: String(ratio), backgroundImage: "url(" + imgUrl(meta) + ")", backgroundSize: 100 / bw + "% auto",
      backgroundPosition: (bw < 1 ? (x0 / (1 - bw)) * 100 : 0) + "% " + (bh < 1 ? (y0 / (1 - bh)) * 100 : 0) + "%" });
    // 一開始的大小：這一格寬度的三分之一上下；高的東西（一整欄的表）別超過這一格高度的六成
    const W = h.clientWidth, H = h.clientHeight, HEAD = 30;
    let w = Math.max(200, Math.min(440, W * 0.36));
    if (w / ratio > H * 0.6) w = Math.max(160, H * 0.6 * ratio);
    w = Math.min(w, W - 24);
    const n = pins.length % 5;
    Object.assign(el.style, { width: Math.round(w) + "px", left: Math.round(Math.max(12, W - w - 18 - n * 16)) + "px", top: Math.round(70 + n * 16) + "px", zIndex: String(++top) });
    h.append(el);
    const pin = { page, box: box.slice(), el };
    pins.push(pin);
    // 從框的那個位置「飛」到角落：看得出釘上去的是剛才框的那一塊（動的是 transform，不到 0.3 秒；減少動態時只淡入）
    const node = ((PR.pageNodes ? PR.pageNodes() : [])[page - 1] || {}).node;
    if (el.animate) {
      const to = el.getBoundingClientRect(), pr = node ? node.getBoundingClientRect() : null;
      if (pr && !reduce()) {
        const fw = Math.max(8, bw * pr.width), fh = Math.max(8, bh * pr.height), th = Math.max(8, to.height - HEAD);
        el.style.transformOrigin = "0 0";
        el.animate([{ transform: "translate(" + (pr.left + x0 * pr.width - to.left) + "px," + (pr.top + y0 * pr.height - HEAD * (fh / th) - to.top) + "px) scale(" + fw / to.width + "," + fh / th + ")", opacity: 0.55 },
          { transform: "none", opacity: 1 }], { duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      } else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease" });
    }
    return el;
  };
  PR.pinCount = () => pins.length;
  function unpin(el) {
    const i = pins.findIndex((p) => p.el === el);
    if (i < 0) return;
    pins.splice(i, 1);
    const gone = () => el.remove();
    if (el.animate) { const a = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.97)" }], { duration: 140, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }); a.onfinish = gone; a.oncancel = gone; } else gone();
  }
  PR.unpinAll = () => pins.slice().forEach((p) => unpin(p.el));

  /* 拖位置（抓標題列）、拉大小（右下角）：手指到哪就到哪，不做緩動；放開時收回這一格的範圍裡 */
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest && e.target.closest(".pin");
    if (!el || e.button !== 0) return;
    el.style.zIndex = String(++top);
    const size = e.target.closest(".pin-size"), hd = e.target.closest(".pin-hd");
    if ((!size && !hd) || e.target.closest("[data-pin]")) return;
    e.preventDefault();
    drag = { el, size: !!size, x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth };
    el.classList.add("dragging");
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 沒有也能拖 */ }
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const h = host(), dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.size) drag.el.style.width = Math.round(Math.max(150, Math.min(h.clientWidth - drag.left - 8, drag.w + dx))) + "px";
    else Object.assign(drag.el.style, { left: Math.round(Math.max(8 - drag.w + 60, Math.min(h.clientWidth - 60, drag.left + dx))) + "px", top: Math.round(Math.max(4, Math.min(h.clientHeight - 40, drag.top + dy))) + "px" });
  });
  const drop = () => { if (drag) { drag.el.classList.remove("dragging"); drag = null; } };
  document.addEventListener("pointerup", drop);
  document.addEventListener("pointercancel", drop);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".pin [data-pin]");
    if (!b) return;
    const el = b.closest(".pin"), pin = pins.find((p) => p.el === el);
    if (b.dataset.pin === "x") unpin(el);
    else if (pin && PR.openPage) PR.openPage(pin.page, null);
  });
  PR.on("pages-built", () => { if (!pins.every((p) => pageMeta(p.page))) PR.unpinAll(); });  // 文件的頁換了（重做過）：對不上的收掉

  /* 把框的那一塊設成這份文件在文獻庫的封面（null＝恢復自動的） */
  PR.setCover = async function (page, box) {
    try {
      await PR.api("/api/p/" + PR.pid + "/item", { method: "POST", body: { cover: box ? { page, box } : null } });
      PR.toast(box ? PR.t("已設為封面（在文獻庫的卡片上）") : PR.t("封面改回自動的"), null, 2600);
    } catch (e) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) })); }
  };
})(window.PR);
