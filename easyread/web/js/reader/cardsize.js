/* 右邊欄的卡片（PDF 旁的邊註欄、文章優先的筆記欄）：拉大小、收起。兩邊共用。
   - 拉大小：滑鼠移到卡片的左緣、下緣或左下角，游標會變；整條邊都能抓，不必回到卡片最上面或最下面
     （以前只有左下角一個小握把，卡片裡的內容一捲它就跟著捲走了）。
     左緣＝只改寬度（往左變寬，蓋到正文／頁面上，高度照內容）；下緣＝只改高度（內容在卡片裡捲）；左下角＝兩個一起。
     雙擊左下角：大小回預設。
   - 收起：雙擊標題列或卡片邊緣收成一行；收起的卡片點一下展開。
   - 存在哪：我的筆記記在筆記的 ui（mw / mh / fold，跟著同步）；AI 自己寫的卡片沒有筆記可記，記在這台的瀏覽器。
   - 拖的時候一幀只改一次大小，其他卡片隔 120 毫秒才重新疊一次，長回答拉起來才不會卡。
   PR.cardEdge(rect, x, y) 是純函式（tests/test_cardsize.cjs）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const EDGE = 9;       // 離邊多近算抓到邊
  const MIN_W = 220, MIN_H = 72;
  const HOSTS = ".pv-margin, #margin";
  const KEY = () => "easyread-cardui:" + PR.pid;
  const note = (id) => ((S.reader || {}).notes || {})[id];
  let sizing = null, hot = null;

  /* 純函式：滑鼠在卡片的哪條邊上。回 ""（不在邊上）、"w"（左緣）、"s"（下緣）、"ws"（左下角） */
  PR.cardEdge = function (r, x, y, edge) {
    const e = edge == null ? EDGE : edge;
    if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return "";
    const w = x - r.left <= e, s = r.bottom - y <= e;
    if (w && s) return "ws";
    if (w && r.bottom - y <= e * 2.2) return "ws";  // 角落放寬一點，好抓
    if (s && x - r.left <= e * 2.2) return "ws";
    return w ? "w" : s ? "s" : "";
  };

  const local = () => (PR.ls ? PR.ls.get(KEY(), {}) : {}) || {};
  function uiOf(card) {
    const n = card.dataset.note && note(card.dataset.note);
    if (n) return n.ui || {};
    return local()[card.dataset.card] || {};
  }
  function saveUi(card, patch, drop) {
    const n = card.dataset.note && note(card.dataset.note);
    const ui = Object.assign({}, uiOf(card), patch);
    (drop || []).forEach((k) => delete ui[k]);
    if (n) return PR.saveNote(Object.assign({}, n, { ui }), { ui: true });
    if (!card.dataset.card || !PR.ls) return;
    const all = local();
    if (Object.keys(ui).length) all[card.dataset.card] = ui; else delete all[card.dataset.card];
    PR.ls.set(KEY(), all);
  }
  PR.cardUi = uiOf;

  /* 照記著的樣子擺：收起、寬、高。拉過高度的卡片內容在裡面捲，不再另外「展開全文」 */
  PR.applyCardUi = function (card) {
    const ui = uiOf(card);
    card.classList.toggle("fold", !!ui.fold);
    const hd = card.querySelector(":scope > .hd");
    if (hd && !hd.title) hd.title = card.closest(".pv-margin") ? PR.t("拖動移動；雙擊收起或展開") : PR.t("雙擊收起或展開");
    card.classList.toggle("sized", !!(ui.mw || ui.mh));
    card.classList.toggle("tall", !!ui.mh);
    card.classList.toggle("wide", !!ui.mw);
    card.style.width = ui.mw ? ui.mw + "px" : "";
    card.style.height = ui.mh ? ui.mh + "px" : "";
    if (ui.mh) unclamp(card);
  };
  function unclamp(card) { PR.$$(".body.clamp", card).forEach((b) => b.classList.remove("clamp")); PR.$$(".more", card).forEach((m) => m.remove()); }
  const relayout = () => { PR.layoutPvMargin && PR.layoutPvMargin(); PR.layoutMargin && PR.layoutMargin(); };
  const rerender = (card) => {
    const n = card.dataset.note && note(card.dataset.note);
    if (card.closest(".pv-margin")) PR.renderPvMargin && PR.renderPvMargin(n ? n.page : undefined);
    else PR.renderMargin && PR.renderMargin();
  };

  /* ---------- 游標：移到邊上就變 ---------- */
  function cardAt(e) {
    const c = e.target && e.target.closest && e.target.closest(".card");
    return c && c.closest(HOSTS) && !c.classList.contains("fold") && !c.classList.contains("editing") ? c : null;
  }
  let raf = 0, last = null;
  document.addEventListener("mousemove", (e) => {
    if (sizing) return;
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const c = cardAt(last);
      const edge = c ? PR.cardEdge(c.getBoundingClientRect(), last.clientX, last.clientY) : "";
      if (hot && (hot !== c || !edge)) { delete hot.dataset.edge; hot = null; }
      if (c && edge) { c.dataset.edge = edge; hot = c; }
    });
  }, { passive: true });

  /* ---------- 拉 ---------- */
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const card = cardAt(e);
    if (!card) return;
    const dir = PR.cardEdge(card.getBoundingClientRect(), e.clientX, e.clientY);
    if (!dir || (e.target.closest("button, a, input, textarea") && dir !== "ws")) return;
    e.preventDefault(); e.stopPropagation();
    const host = card.closest(HOSTS), inPv = !!card.closest(".pv-margin");
    const page = inPv ? card.closest(".pv-page") : null;
    const x0 = e.clientX, y0 = e.clientY, w0 = card.offsetWidth, h0 = card.offsetHeight;
    const colW = host.clientWidth;
    const maxW = inPv ? page.clientWidth + colW : Math.max(colW, colW + (PR.$("#paper") ? PR.$("#paper").clientWidth : 0));
    const maxH = inPv ? Math.max(160, page.clientHeight - (parseFloat(card.style.top) || 0)) : Math.max(240, innerHeight * 2);
    let w = w0, h = h0, nx = x0, ny = y0, frame = 0, stackAt = 0;
    sizing = { card, dir };
    document.body.classList.add("card-sizing", "card-sizing-" + dir);
    card.classList.add("sized");
    if (dir.includes("w")) card.classList.add("wide");
    if (dir.includes("s")) { card.classList.add("tall"); unclamp(card); }
    const paint = () => {
      frame = 0;
      if (dir.includes("w")) { w = Math.round(Math.max(MIN_W, Math.min(maxW, w0 + (x0 - nx)))); card.style.width = w + "px"; }
      if (dir.includes("s")) { h = Math.round(Math.max(MIN_H, Math.min(maxH, h0 + (ny - y0)))); card.style.height = h + "px"; }
      const now = performance.now();
      if (now - stackAt > 120) { stackAt = now; relayout(); }  // 底下的卡片跟著讓位，但不必每一幀都重疊一次
    };
    const move = (ev) => { nx = ev.clientX; ny = ev.clientY; if (!frame) frame = requestAnimationFrame(paint); };
    const up = () => {
      document.removeEventListener("mousemove", move, true); document.removeEventListener("mouseup", up, true);
      if (frame) { cancelAnimationFrame(frame); paint(); }
      document.body.classList.remove("card-sizing", "card-sizing-" + dir);
      sizing = null;
      delete card.dataset.edge;
      const moved = Math.abs(nx - x0) > 2 || Math.abs(ny - y0) > 2;
      if (moved) saveUi(card, Object.assign({}, dir.includes("w") ? { mw: w } : {}, dir.includes("s") ? { mh: h } : {}));
      else PR.applyCardUi(card);  // 只是點了一下邊：照原樣
      relayout();
    };
    document.addEventListener("mousemove", move, true); document.addEventListener("mouseup", up, true);
  }, true);

  /* ---------- 雙擊：左下角回預設大小；標題列或其他邊緣收起／展開 ---------- */
  function setFold(card, fold) {
    saveUi(card, fold ? { fold: true } : {}, fold ? [] : ["fold"]);
    rerender(card);
  }
  document.addEventListener("dblclick", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (!card || !card.closest(HOSTS) || card.classList.contains("editing")) return;
    const edge = card.classList.contains("fold") ? "" : PR.cardEdge(card.getBoundingClientRect(), e.clientX, e.clientY);
    if (edge === "ws") {
      e.preventDefault();
      saveUi(card, {}, ["mw", "mh"]);
      return rerender(card);
    }
    if (e.target.closest("button, a, textarea, input, .qchips, .links")) return;
    if (!edge && !card.classList.contains("fold") && e.target.closest(".body, .quote, .clip, .reply, .ttl, .q")) return;  // 內容上雙擊是選字
    e.preventDefault();
    if (window.getSelection) getSelection().removeAllRanges();
    setFold(card, !card.classList.contains("fold"));
  });
  document.addEventListener("click", (e) => {
    const card = e.target.closest && e.target.closest(".card.fold");
    if (!card || !card.closest(HOSTS) || e.target.closest("button, a") || document.body.classList.contains("dragging-card")) return;
    setFold(card, false);
  });
})(window.PR);
