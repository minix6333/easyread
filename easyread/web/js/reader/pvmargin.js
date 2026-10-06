/* PDF 頁右邊的邊註欄：這一頁的筆記、提問（含 AI 的回答）排成卡片貼在標記旁邊。
   - 連到標記的那條細線平常不畫（閱讀時不干擾）：點了卡片或頁上的標記才畫出那一條，點別處就收掉。
   - 欄寬可以拉：抓頁面和卡片之間那一道拖（雙擊回預設），卡片裡的字跟著重排；記在閱讀設定裡（marginW）。
   - 寬度夠（頁面至少還剩 640px）就自動出現，放不下設定的寬度就自己縮；閱讀設定的「邊註」選「收起」就不顯示。
   - 卡片可以抓標題列上下拖：拖到哪就記在筆記裡（ui.my），下次還在那裡；拖到另一張卡片上放開＝建立關聯。
   - 卡片左下角可以拉大小（ui.mw / ui.mh）：往左拉變寬（蓋到頁面上），往下拉變高；拉過高度的卡片內容在裡面捲、不再收起。雙擊角落回預設。
   - 關聯（links）：卡片上的「關聯」按鈕進入選取模式，點另一張卡片或標記就連起來；卡片底下有一排小標籤，點了跳過去。
   - 卡片是 margin.js 的 cardHtml（和筆記面板、便利貼同一張），點內容就地編輯。
   測試：tests/test_pvmargin.cjs（疊放、關聯、排序的純函式）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const GAP = 8;          // 卡片之間至少留多少
  const COL = 280;        // 預設欄寬（含間距），對應 CSS --pv-margin-w
  const COL_MIN = 220, COL_MAX = 560;
  const MIN_PAGE = 640;   // 自動模式：頁面至少要剩這麼寬才擺邊註（再窄字就太小了，退回小圓點＋便利貼）
  let linkFrom = null;    // 選取模式：正在替哪條筆記找關聯對象
  let drag = null;
  let active = null;      // 點到的那條筆記：只有它的連線畫出來
  let sizing = null;      // 正在拖欄寬時的寬度（放開才存進設定）

  const note = (id) => ((S.reader || {}).notes || {})[id];
  const nodes = () => (PR.pageNodes ? PR.pageNodes() : []);
  const scroller = () => PR.$(".pv-scroll");
  const yOf = (n) => (n.region ? n.region[1] : n.rects && n.rects[0] ? n.rects[0][1] : 0);
  const badgeAt = (n) => (n.region ? [n.region[2], n.region[1]] : n.rects && n.rects.length ? [n.rects[n.rects.length - 1][2], n.rects[n.rects.length - 1][1]] : [1, yOf(n)]);
  /* 這一頁要擺進邊註欄的：畫在 PDF 上、有內容的（純畫線沒寫字的不占位，標記本身就在頁上） */
  const notesOn = (page) => PR.myNotes().filter((n) => n.side === "pdf" && n.page === page && (n.rects || n.region) &&
    (n.kind !== "highlight" || (n.body || "").trim() || PR.repliesTo(n.id).length));

  /* 疊放（純函式，給測試）：items = [{id, y, pin, h}]，y 是錨點位置、pin 是手動拖到的位置（沒有就 null）、h 是高度。
     想放的位置是 pin 或 y；按它排，放不下就往下順延，回傳 {id: top} */
  PR.pvMarginStack = function (items, gap) {
    const g = gap == null ? GAP : gap;
    const sorted = items.map((it) => ({ it, want: it.pin != null ? it.pin : it.y })).sort((a, b) => a.want - b.want);
    const out = {};
    let bottom = -Infinity;
    for (const { it, want } of sorted) {
      const top = Math.max(want, bottom + g);
      out[it.id] = top;
      bottom = top + (it.h || 0);
    }
    return out;
  };

  /* 關聯：兩邊都記（links 裡放對方的 id），讓任一邊的卡片都看得到 */
  PR.linkNotes = function (a, b) {
    const na = note(a), nb = note(b);
    if (!na || !nb || a === b || na.deleted || nb.deleted) return false;
    const add = (n, id) => { const links = (n.links || []).filter((x) => x !== id); links.push(id); PR.saveNote(Object.assign({}, n, { links })); };
    if (!(na.links || []).includes(b)) add(na, b);
    if (!(nb.links || []).includes(a)) add(nb, a);
    PR.toast(PR.t("已建立關聯"), null, 1200);
    repaintAll();
    return true;
  };
  PR.unlinkNotes = function (a, b) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const n = note(x);
      if (n && (n.links || []).includes(y)) PR.saveNote(Object.assign({}, n, { links: n.links.filter((id) => id !== y) }));
    }
    PR.toast(PR.t("已取消關聯"), null, 1200);
    repaintAll();
  };
  /* 進入選取模式：下一次點到的卡片或標記就是關聯對象 */
  PR.linkFrom = function (id) {
    if (!note(id)) return;
    linkFrom = id;
    document.body.classList.add("link-mode");
    PR.toast(PR.t("點另一張筆記或標記，和這條建立關聯（Esc 取消）"), { label: PR.t("取消"), fn: endLink }, 6000);
  };
  function endLink() { linkFrom = null; document.body.classList.remove("link-mode"); }
  /* 跳到某條筆記：PDF 上的翻頁並打開便利貼；譯文段落的捲到那一段 */
  PR.goToNote = function (id) {
    const n = note(id);
    if (!n) return;
    if (n.side === "pdf" && n.page) {
      PR.goToPage(n.page);
      setTimeout(() => PR.openSticky && PR.openSticky(id), 140);
    } else if (n.anchor) { PR.goToAnchor(n.anchor); PR.flashCard && setTimeout(() => PR.flashCard(id), 400); }
  };
  function repaintAll() {
    PR.renderMargin && PR.renderMargin();
    PR.applyMarks && PR.applyMarks();
    PR.renderSticky && PR.renderSticky();
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel();
  }

  /* ---------- 欄要不要出現、多寬 ---------- */
  /* 純函式（給測試）：想要的欄寬 want、捲動區可用寬 avail、縮放 zoom → 實際欄寬；放不下就 20px 一級往下縮，縮到最窄還不行回 0（不擺）。
     頁面寬 = min(剩下的寬, 920) × 縮放（見 pdfview.css） */
  PR.pvMarginFit = function (want, avail, zoom) {
    const ok = (c) => { const page = Math.min(avail - c, 920) * zoom; return page >= MIN_PAGE && page + c <= avail; };
    for (let c = Math.max(COL_MIN, Math.min(COL_MAX, Math.round(want) || COL)); c >= COL_MIN; c -= 20) if (ok(c)) return c;
    return ok(COL_MIN) ? COL_MIN : 0;
  };
  function colWidth() {
    if ((PR.prefs || {}).margin === false || !(PR.pdfMain && PR.pdfMain())) return 0;
    const sc = scroller();
    if (!sc) return 0;
    return PR.pvMarginFit(sizing || Number((PR.prefs || {}).marginW) || COL, sc.clientWidth - 48, Number((PR.prefs || {}).pdfZoom) || 1);
  }
  const wanted = () => colWidth() > 0;
  PR.pvMarginOn = () => !!(scroller() && scroller().classList.contains("has-margin"));

  function colOf(entry) {
    let col = entry.node.querySelector(":scope > .pv-margin");
    if (!col) { col = PR.el("div", { class: "pv-margin" }); entry.node.append(col); }
    return col;
  }
  /* 只有點到的那條（和正在編輯的那條）畫連線、卡片亮一圈、頁上的標記亮起來 */
  const sel = (id) => '[data-note="' + String(id).replace(/["\\]/g, "\\$&") + '"]';
  const shown = (id) => id === active || id === PR.editingNote;
  function setActive(id) {
    if (active === id) return;
    const was = active;
    active = id || null;
    PR.$$(".pv-wire path.on, .pv-margin .card.on").forEach((x) => { if (!shown(x.dataset.note)) x.classList.remove("on"); });
    if (was) PR.$$(".pv-mark" + sel(was) + ", .pv-area" + sel(was) + ", .pv-badge" + sel(was)).forEach((x) => x.classList.remove("active"));
    if (!active) return;
    PR.$$(".pv-wire path" + sel(active) + ", .pv-margin .card" + sel(active)).forEach((x) => x.classList.add("on"));
    if (PR.pvMarginOn()) PR.$$(".pv-mark" + sel(active) + ", .pv-area" + sel(active) + ", .pv-badge" + sel(active)).forEach((x) => x.classList.add("active"));
  }

  /* ---------- 畫 ---------- */
  /* 同一頁內容沒變（筆記、回答、編輯狀態、頁寬都一樣）就不重畫：開關面板、改設定時會從好幾條路各叫一次 */
  function signature(page, list, editingId) {
    const edit = editingId === undefined ? PR.editingNote : editingId;
    return list.map((n) => n.id + ":" + (n.updated || "") + ":" + JSON.stringify(n.ui || 0) + ":" + PR.repliesTo(n.id).length + ":" + (PR.asking.has(n.id) ? 1 : 0) + ":" + (PR.liveAnswers[n.id] ? (PR.liveAnswers[n.id].text || "").length : 0)).join("|") +
      "#" + (edit || "") + "#" + Math.round(nodes()[page - 1].node.clientWidth);
  }
  function renderPage(entry, page, editingId) {
    const col = colOf(entry);
    const list = notesOn(page);
    if (!list.length) { col.innerHTML = ""; col.dataset.sig = ""; return; }
    const sig = signature(page, list, editingId);
    if (col.dataset.sig === sig) { layoutPage(entry); return; }
    col.dataset.sig = sig;
    col.innerHTML = list.map((n) => PR.cardHtml({ src: "mine", data: n, anchor: PR.blockById[n.anchor] ? n.anchor : "page:" + page }, editingId === undefined ? PR.editingNote : editingId)).join("") +
      '<svg class="pv-wire" aria-hidden="true"></svg><div class="pv-margin-grip" title="' + PR.t("拖動調整筆記欄寬度（雙擊回預設）") + '"></div>';
    PR.$$(":scope > .card", col).forEach((c) => {
      c.classList.add("pv-mcard");
      if (shown(c.dataset.note)) c.classList.add("on");
      PR.prepCard && PR.prepCard(c);
      c.insertAdjacentHTML("beforeend", '<i class="rz" title="' + PR.t("拖動調整這張卡片的大小（雙擊回預設）") + '"></i>');
      applySize(c, note(c.dataset.note));
    });
    layoutPage(entry);
  }
  /* 拉過大小的卡片：右緣貼齊欄位、往左變寬；有高度就在裡面捲，不再收起 */
  function applySize(c, n) {
    const ui = (n && n.ui) || {};
    c.classList.toggle("sized", !!(ui.mw || ui.mh));
    c.style.width = ui.mw ? ui.mw + "px" : "";
    c.style.height = ui.mh ? ui.mh + "px" : "";
    if (ui.mh) { PR.$$(".body.clamp", c).forEach((b) => b.classList.remove("clamp")); PR.$$(".more", c).forEach((m) => m.remove()); }
  }
  function layoutPage(entry) {
    const col = entry.node.querySelector(":scope > .pv-margin");
    if (!col || !col.firstElementChild) return;
    const W = entry.node.clientWidth || 1, H = entry.node.clientHeight || 1;
    const items = [];
    for (const c of PR.$$(":scope > .card", col)) {
      const n = note(c.dataset.note);
      if (!n) continue;
      items.push({ id: n.id, y: yOf(n) * H, pin: n.ui && n.ui.my != null ? n.ui.my * H : null, h: c.offsetHeight, c, n });
    }
    const tops = PR.pvMarginStack(items, GAP);
    let paths = "";
    for (const it of items) {
      const top = tops[it.id];
      if (!(drag && drag.id === it.id)) it.c.style.top = Math.round(top) + "px";
      const [bx, by] = badgeAt(it.n);
      // 線：從小圓點水平出頁面，垂直到卡片頂端附近，再進卡片
      paths += '<path data-note="' + PR.esc(it.id) + '" class="' + (it.n.kind === "question" ? "q" : "c-" + (it.n.color || "yellow")) + (shown(it.id) ? " on" : "") + '" d="M' + (bx * W).toFixed(1) + " " + (by * H).toFixed(1) + " H" + (W + 7) + " V" + (top + 14).toFixed(1) + " H" + (W + 16) + '"/>';
    }
    const svg = col.querySelector("svg.pv-wire");
    if (svg) {
      svg.setAttribute("viewBox", "0 0 " + (W + 16) + " " + H);
      svg.style.cssText = "left:" + (-(W + 16)) + "px;width:" + (W + 16) + "px;height:" + H + "px";
      svg.innerHTML = paths;
    }
  }
  PR.renderPvMargin = function (page, editingId) {
    const sc = scroller();
    if (!sc || !S.paper || !S.reader) return;  // 還沒載入（開頁時 applyPrefs 就會來一次）
    const w = colWidth(), on = w > 0;
    if (on) document.documentElement.style.setProperty("--pv-margin-w", w + "px");
    if (sc.classList.contains("has-margin") !== on) {
      sc.classList.toggle("has-margin", on);
      if (PR.reloadPages && nodes().length) PR.reloadPages();  // 頁面變寬變窄：換合適清晰度的圖
      if (PR.renderSticky) PR.renderSticky();
    }
    if (!on) { PR.$$(".pv-margin").forEach((c) => (c.innerHTML = "")); return; }
    nodes().forEach((entry, i) => { if (!page || page === i + 1) renderPage(entry, i + 1, editingId); });
  };
  PR.layoutPvMargin = function () { if (PR.pvMarginOn()) nodes().forEach(layoutPage); };
  /* 在邊註欄裡就地編輯這條 */
  PR.editInMargin = function (id) {
    const n = note(id);
    if (!n) return;
    PR.editingNote = id;
    PR.renderPvMargin(n.page, id);
    const ta = PR.$('.pv-margin .card[data-note="' + id + '"] textarea');
    if (ta) { PR.autosize(ta); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
  };

  /* ---------- 拖卡片：上下移動；放到另一張上＝關聯 ---------- */
  document.addEventListener("mousedown", (e) => {
    const hd = e.target.closest && e.target.closest(".pv-margin .card > .hd");
    if (!hd || e.button !== 0 || e.target.closest("button, input, textarea, a")) return;
    const card = hd.closest(".card"), col = card.closest(".pv-margin"), page = col.closest(".pv-page");
    e.preventDefault();
    drag = { id: card.dataset.note, card, col, page, y0: e.clientY, top0: parseFloat(card.style.top) || 0, moved: false, over: null };
    card.classList.add("dragging");
    document.body.classList.add("dragging-card");
    const move = (ev) => {
      const dy = ev.clientY - drag.y0;
      if (Math.abs(dy) > 3) drag.moved = true;
      card.style.top = Math.max(0, drag.top0 + dy) + "px";
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest && under.closest(".pv-margin .card[data-note], .np-list .card[data-note]");
      const over = target && target !== card ? target : null;
      if (over !== drag.over) { drag.over && drag.over.classList.remove("drop-link"); over && over.classList.add("drop-link"); drag.over = over; }
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      const d = drag; drag = null;
      card.classList.remove("dragging");
      document.body.classList.remove("dragging-card");
      if (d.over) {
        d.over.classList.remove("drop-link");
        PR.linkNotes(d.id, d.over.dataset.note);
        return;
      }
      const n = note(d.id);
      if (d.moved && n && page) {
        const my = Math.max(0, parseFloat(card.style.top) || 0) / (page.clientHeight || 1);
        PR.saveNote(Object.assign({}, n, { ui: Object.assign({}, n.ui, { my: Math.round(my * 10000) / 10000 }) }), { ui: true });
      }
      PR.layoutPvMargin();
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });

  /* ---------- 點卡片或頁上的標記：畫出它的連線；點別處收掉 ---------- */
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest || e.target.closest(".pv-margin-grip")) return;
    const t = e.target.closest(".pv-margin .card[data-note], .pv-badge[data-note], .pv-mark[data-note], .pv-area[data-note]");
    let id = t ? t.dataset.note : null;
    if (!id && PR.pvMarginOn() && PR.pdfNoteAt && e.target.closest(".pv-page")) id = PR.pdfNoteAt(e) || null;  // 標記本身不吃滑鼠事件（要能選到底下的字）
    setActive(id);
  }, true);
  PR.pvMarginActive = setActive;
  PR.pvActiveId = () => (PR.pvMarginOn() ? active : null);

  /* ---------- 拉卡片大小：抓左下角，往左變寬、往下變高 ---------- */
  document.addEventListener("mousedown", (e) => {
    const rz = e.target.closest && e.target.closest(".pv-margin .card > .rz");
    if (!rz || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const card = rz.closest(".card"), page = card.closest(".pv-page"), entry = { node: page };
    const n = note(card.dataset.note);
    if (!n) return;
    const x0 = e.clientX, y0 = e.clientY, w0 = card.offsetWidth, h0 = card.offsetHeight;
    const maxW = page.clientWidth + card.offsetWidth, maxH = Math.max(120, page.clientHeight - (parseFloat(card.style.top) || 0));
    let w = w0, h = h0, raf = 0;
    document.body.classList.add("card-sizing");
    card.classList.add("sized");
    PR.$$(".body.clamp", card).forEach((b) => b.classList.remove("clamp")); PR.$$(".more", card).forEach((m) => m.remove());
    const move = (ev) => {
      w = Math.round(Math.max(220, Math.min(maxW, w0 + (x0 - ev.clientX))));
      h = Math.round(Math.max(80, Math.min(maxH, h0 + (ev.clientY - y0))));
      card.style.width = w + "px"; card.style.height = h + "px";
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; layoutPage(entry); });
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.body.classList.remove("card-sizing");
      const cur = note(n.id);
      if (cur) PR.saveNote(Object.assign({}, cur, { ui: Object.assign({}, cur.ui, { mw: w, mh: h }) }), { ui: true });
      layoutPage(entry);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  document.addEventListener("dblclick", (e) => {
    const rz = e.target.closest && e.target.closest(".pv-margin .card > .rz");
    if (!rz) return;
    const card = rz.closest(".card"), n = note(card.dataset.note);
    if (!n || !n.ui) return;
    const ui = Object.assign({}, n.ui);
    delete ui.mw; delete ui.mh;
    PR.saveNote(Object.assign({}, n, { ui }), { ui: true });
    PR.renderPvMargin(n.page);
  });

  /* ---------- 拖欄寬 ---------- */
  document.addEventListener("mousedown", (e) => {
    const grip = e.target.closest && e.target.closest(".pv-margin-grip");
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const sc = scroller(), x0 = e.clientX, w0 = colWidth() || COL, page0 = nodes().length ? nodes()[0].node.clientWidth : 0;
    document.body.classList.add("margin-sizing");
    let raf = 0;
    const move = (ev) => {
      // 往左拖＝欄變寬；頁面跟著變窄，握把跟著頁面右緣走
      const want = Math.max(COL_MIN, Math.min(COL_MAX, w0 + (x0 - ev.clientX)));
      const fit = PR.pvMarginFit(want, sc.clientWidth - 48, Number((PR.prefs || {}).pdfZoom) || 1);
      if (!fit || fit === sizing) return;
      sizing = fit;
      document.documentElement.style.setProperty("--pv-margin-w", fit + "px");
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; PR.layoutPvMargin(); });
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.body.classList.remove("margin-sizing");
      const w = sizing;
      sizing = null;
      if (w && w !== w0) {
        PR.setPref("marginW", w, true);
        const page1 = nodes().length ? nodes()[0].node.clientWidth : 0;
        if (PR.reloadPages && Math.abs(page1 - page0) > 40) PR.reloadPages();  // 頁面寬度變了不少：換合適清晰度的圖
      }
      PR.renderPvMargin();
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  document.addEventListener("dblclick", (e) => {
    if (!e.target.closest || !e.target.closest(".pv-margin-grip")) return;
    PR.setPref("marginW", 0, true);  // 0＝照預設
    PR.renderPvMargin();
  });

  /* ---------- 選取模式：點到卡片或標記就連起來（先攔下來，不讓它打開便利貼） ---------- */
  window.addEventListener && window.addEventListener("click", (e) => {
    if (!linkFrom) return;
    const t = e.target.closest && e.target.closest(".card[data-note], .pv-badge[data-note], .pv-mark[data-note], .pv-area[data-note], mark[data-note]");
    const id = t && t.dataset.note;
    e.preventDefault(); e.stopPropagation();
    if (id && id !== linkFrom) PR.linkNotes(linkFrom, id);
    else if (!id) PR.toast(PR.t("已取消"), null, 900);
    endLink();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && linkFrom) { endLink(); PR.toast(PR.t("已取消"), null, 900); } }, true);

  /* ---------- 什麼時候重畫 ---------- */
  const soon = PR.debounce ? PR.debounce(() => PR.renderPvMargin(), 80) : () => PR.renderPvMargin();
  if (PR.on) {
    PR.on("pages-built", () => setTimeout(() => PR.renderPvMargin(), 0));
    PR.on("remote", (changed) => { if (!changed || changed.includes("reader") || changed.includes("discussion")) soon(); });
    PR.on("rendered", soon);  // ui-changed 由 pdfmode 的 applyLayout 帶到這裡，不另外接
  }
  window.addEventListener && window.addEventListener("resize", PR.debounce ? PR.debounce(() => PR.renderPvMargin(), 150) : () => PR.renderPvMargin());
  /* 卡片裡的圖片載入後高度才定下來 */
  document.addEventListener("load", (e) => { if (e.target && e.target.tagName === "IMG" && e.target.closest && e.target.closest(".pv-margin")) PR.layoutPvMargin(); }, true);
})(window.PR);
