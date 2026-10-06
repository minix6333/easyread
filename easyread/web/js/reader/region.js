/* 框選：像截圖那樣在 PDF 上拖一個框，對那一塊問 AI 或寫筆記。
   選不到字的地方（圖、表、公式、掃描的投影片）靠它：按右下角的框選鈕（或快捷鍵），游標變成十字，
   拖完跳出便利貼——打字問問題（那一塊的圖會跟問題一起送給模型），或切到「筆記」寫筆記。
   可以跨頁：拖過頁的邊界到下一頁（或上一頁），框會接著畫過去——第一頁的框記在 region，其餘每頁一塊記在 spans
   （[{page, rect}]），問 AI 時每一塊都當圖附上。
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
  const r4 = (v) => +v.toFixed(4);
  /* 純函式（給測試）：從 a 拖到 b（各是 {page, x, y}，頁內座標 0–1）→ 每一頁一塊 [{page, rect}]，照頁碼排。
     同一頁就是普通的框；跨頁時第一頁從起點到頁底、中間整頁、最後一頁從頁頂到終點，左右用兩點的 x 範圍 */
  PR.regionSpans = function (a, b) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    if (a.page === b.page) return [{ page: a.page, rect: [x0, Math.min(a.y, b.y), x1, Math.max(a.y, b.y)].map(r4) }];
    const [top, bot] = a.page < b.page ? [a, b] : [b, a];
    const out = [{ page: top.page, rect: [x0, top.y, x1, 1].map(r4) }];
    for (let p = top.page + 1; p < bot.page; p++) out.push({ page: p, rect: [x0, 0, x1, 1].map(r4) });
    out.push({ page: bot.page, rect: [x0, 0, x1, bot.y].map(r4) });
    return out;
  };
  /* 滑鼠在哪一頁的哪裡：不在任何頁上時，按垂直位置算在最近的那一頁（拖過頁與頁之間的縫隙） */
  function pointAt(e) {
    const nodes = PR.pageNodes ? PR.pageNodes() : [];
    let best = null, dist = Infinity;
    for (const { node } of nodes) {
      const r = node.getBoundingClientRect();
      if (r.bottom < -400 || r.top > innerHeight + 400) continue;
      const dy = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
      if (dy < dist) { dist = dy; best = { page: +node.dataset.n, r }; }
    }
    if (!best) return null;
    return { page: best.page, x: clamp((e.clientX - best.r.left) / best.r.width), y: clamp((e.clientY - best.r.top) / best.r.height) };
  }
  function update(e) {
    const to = pointAt(e) || drag.last;
    drag.last = to;
    const spans = PR.regionSpans(drag.from, to);
    const want = new Map(spans.map((s) => [s.page, s.rect]));
    for (const [p, rub] of drag.rubs) if (!want.has(p)) { rub.remove(); drag.rubs.delete(p); }
    const nodes = PR.pageNodes ? PR.pageNodes() : [];
    for (const [p, [x0, y0, x1, y1]] of want) {
      let rub = drag.rubs.get(p);
      if (!rub) {
        const entry = nodes[p - 1];
        if (!entry) continue;
        rub = document.createElement("div");
        rub.className = "pv-rubber";
        entry.node.append(rub);
        drag.rubs.set(p, rub);
      }
      Object.assign(rub.style, { left: x0 * 100 + "%", top: y0 * 100 + "%", width: (x1 - x0) * 100 + "%", height: (y1 - y0) * 100 + "%" });
    }
    // 拖到捲動區的上下邊緣：自己捲（跨頁選時不用放開滑鼠去捲）
    const sr = scroller.getBoundingClientRect();
    if (e.clientY > sr.bottom - 28) scroller.scrollTop += 12; else if (e.clientY < sr.top + 28) scroller.scrollTop -= 12;
  }
  const scroller = PR.$(".pv-scroll");
  scroller.addEventListener("mousedown", (e) => {
    if (!on || e.button !== 0) return;
    const page = e.target.closest(".pv-page");
    if (!page) return;
    e.preventDefault();
    const r = page.getBoundingClientRect();
    const from = { page: +page.dataset.n, x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    drag = { from, last: from, rubs: new Map(), r };
    update(e);
  });
  document.addEventListener("mousemove", (e) => { if (drag) update(e); });
  const clearRubs = (d) => { for (const rub of d.rubs.values()) rub.remove(); d.rubs.clear(); };
  document.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    lastDrag = Date.now();
    const to = pointAt(e) || d.last;
    const spans = PR.regionSpans(d.from, to);
    clearRubs(d);
    PR.toggleRegion(false);
    const [fx0, fy0, fx1, fy1] = spans[0].rect;
    if (spans.length === 1 && ((fx1 - fx0) * d.r.width < 12 || (fy1 - fy0) * d.r.height < 12)) return;  // 只是點了一下
    const page = spans[0].page;
    const canAsk = PR.canChat && PR.canChat() && PR.feature("chat");
    const kind = canAsk ? PR.ls.get("easyread-region-kind", "question") : "note";
    PR.startNote(Object.assign({ side: "pdf", page, region: spans[0].rect, kind: kind === "note" ? "note" : "question",
      anchor: (PR.blockAt && PR.blockAt((fx0 + fx1) / 2, (fy0 + fy1) / 2, page)) || null }, spans.length > 1 ? { spans: spans.slice(1) } : {}));
  });
  /* 拖完那一下的 click 不要再被當成「點段落」「點標記」 */
  document.addEventListener("click", (e) => {
    if (Date.now() - lastDrag < 350 && e.target.closest && e.target.closest("#pageview .pv-page")) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!on || e.key !== "Escape") return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (drag) { clearRubs(drag); drag = null; }
    PR.toggleRegion(false);
  }, true);
})(window.PR);
