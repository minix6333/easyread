/* 框選：像截圖那樣在 PDF 上拖一個框，對那一塊問 AI 或寫筆記。
   選不到字的地方（圖、表、公式、掃描的投影片）靠它：按右下角的框選鈕（或快捷鍵），游標變成十字，
   拖完跳出便利貼——打字問問題（那一塊的圖會跟問題一起送給模型），或切到「筆記」寫筆記。
   框選一次就離開框選模式；Esc 取消。 */
(function (PR) {
  "use strict";
  const body = document.body;
  let on = false, drag = null, lastDrag = 0;

  PR.regionMode = () => on;
  PR.toggleRegion = function (force) {
    const next = force != null ? !!force : !on;
    if (next === on) return;
    if (next && !(PR.pdfMain && PR.pdfMain())) return;
    on = next;
    body.classList.toggle("region-mode", on);
    PR.syncFabs && PR.syncFabs();
    if (!on) return;
    PR.closeSticky && PR.closeSticky();
    PR.hidePopover && PR.hidePopover();
    const sel = window.getSelection();
    sel && sel.removeAllRanges();
    PR.toast(PR.t("拖曳框選　Esc 取消"), null, 2400);
  };

  const clamp = (v) => Math.max(0, Math.min(1, v));
  function boxOf(d, e) {
    const x = clamp((e.clientX - d.r.left) / d.r.width), y = clamp((e.clientY - d.r.top) / d.r.height);
    return [Math.min(d.x, x), Math.min(d.y, y), Math.max(d.x, x), Math.max(d.y, y)];
  }
  function update(e) {
    const [x0, y0, x1, y1] = boxOf(drag, e);
    Object.assign(drag.rub.style, { left: x0 * 100 + "%", top: y0 * 100 + "%", width: (x1 - x0) * 100 + "%", height: (y1 - y0) * 100 + "%" });
  }
  const scroller = PR.$(".pv-scroll");
  scroller.addEventListener("mousedown", (e) => {
    if (!on || e.button !== 0) return;
    const page = e.target.closest(".pv-page");
    if (!page) return;
    e.preventDefault();
    const r = page.getBoundingClientRect();
    const rub = document.createElement("div");
    rub.className = "pv-rubber";
    page.append(rub);
    drag = { page, r, rub, x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    update(e);
  });
  document.addEventListener("mousemove", (e) => { if (drag) update(e); });
  document.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    lastDrag = Date.now();
    const [x0, y0, x1, y1] = boxOf(d, e);
    d.rub.remove();
    PR.toggleRegion(false);
    if ((x1 - x0) * d.r.width < 12 || (y1 - y0) * d.r.height < 12) return;  // 只是點了一下
    const page = +d.page.dataset.n;
    const canAsk = PR.canChat && PR.canChat() && PR.feature("chat");
    const kind = canAsk ? PR.ls.get("easyread-region-kind", "question") : "note";
    PR.startNote({ side: "pdf", page, region: [x0, y0, x1, y1].map((v) => +v.toFixed(4)), kind: kind === "note" ? "note" : "question",
      anchor: (PR.blockAt && PR.blockAt((x0 + x1) / 2, (y0 + y1) / 2, page)) || null });
  });
  /* 拖完那一下的 click 不要再被當成「點段落」「點標記」 */
  document.addEventListener("click", (e) => {
    if (Date.now() - lastDrag < 350 && e.target.closest && e.target.closest("#pageview .pv-page")) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!on || e.key !== "Escape") return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (drag) { drag.rub.remove(); drag = null; }
    PR.toggleRegion(false);
  }, true);
})(window.PR);
