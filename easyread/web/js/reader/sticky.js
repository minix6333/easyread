/* PDF 上的便利貼：筆記和提問在標記旁邊的一張小卡片裡寫、看（卡片本身是 margin.js 的 cardHtml）。
   - 打開：選字按「筆記／問 AI」、框選一塊（region.js）、點標記末端的小圓點、點筆記的標記。
   - 收起：Esc、點別的地方（自動存）。原文上只留標記和一顆小圓點，不佔版面。
   - 新開的先是草稿：寫了字才存，空著收起就什麼都不留。
   - 提問：Enter 送出，回答直接流進這張卡片（ask.js）。
   - 選字翻譯：譯文出現在同一種小框裡，可以複製、存成筆記。
   小框放在那一頁裡面（跟著頁面捲動、縮放），一次只開一張。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let cur = null;  // { id, page, draft, edit, tr }；tr：選字翻譯 { sel, text, model, error, streaming, ctrl }
  let box = null;

  const saved = (id) => { const n = (S.reader.notes || {})[id]; return n && !n.deleted ? n : null; };
  const noteOf = () => (cur ? saved(cur.id) || cur.draft : null);
  PR.stickyNote = () => (cur ? cur.id : null);
  PR.stickyDraft = () => (cur && cur.draft ? cur.draft : null);
  const entryOf = (page) => (PR.pageNodes ? PR.pageNodes() : [])[page - 1];
  const act = (a, icon, title) => '<button data-a="' + a + '" title="' + PR.esc(title) + '">' + PR.icon(icon, "sm") + "</button>";

  /* ---------- 位置：貼著標記，下面放不下就放上面 ---------- */
  function anchorBox(n) {
    if (n.region) return n.region;
    const rs = n.rects || [];
    if (!rs.length) return [0.1, 0.08, 0.5, 0.1];
    return [Math.min(...rs.map((r) => r[0])), rs[0][1], Math.max(...rs.map((r) => r[2])), rs[rs.length - 1][3]];
  }
  const TR_SIZE = "easyread-tr-size";  // 選字翻譯小框上次拉成多大
  function place() {
    const n = noteOf(), entry = cur && entryOf(cur.page);
    if (!n || !entry || !box) return;
    const node = entry.node, W = node.clientWidth, H = node.clientHeight;
    const [x0, y0, , y1] = anchorBox(n);
    const sc = PR.$(".pv-scroll").getBoundingClientRect(), pr = node.getBoundingClientRect();
    const ui = cur.tr ? (PR.ls.get(TR_SIZE, null) || {}) : (n.ui || {});
    const card = box.firstElementChild;
    if (card && ui.h) card.style.height = ui.h + "px";
    const w = ui.w ? Math.max(220, Math.min(ui.w, Math.min(W, sc.width) - 16)) : Math.min(n.kind === "question" || cur.tr ? 380 : 340, Math.max(220, Math.min(W, sc.width) - 16));
    box.style.width = w + "px";
    if (card) card.style.width = w + "px";
    if (!cur.tr && ui.x != null && ui.y != null) {  // 拖過：放回上次的位置
      box.style.bottom = "auto";
      box.style.left = Math.round(Math.max(-w + 60, Math.min(W + 280 - 60, ui.x * W))) + "px";
      box.style.top = Math.round(Math.max(0, ui.y * H)) + "px";
      return;
    }
    // 橫向：對齊標記左緣，但整張要落在看得到的範圍裡
    const left = Math.max(sc.left - pr.left + 8, Math.min(sc.right - pr.left - w - 8, Math.max(8, x0 * W)));
    box.style.left = Math.round(left) + "px";
    const below = y1 * H + 8, room = sc.bottom - pr.top - below, h = box.offsetHeight;
    const above = y0 * H - 8 - (sc.top - pr.top);
    if (room < Math.min(h, 220) + 12 && above > room) { box.style.top = "auto"; box.style.bottom = Math.round(H - y0 * H + 8) + "px"; }  // 放上面：往上長
    else { box.style.bottom = "auto"; box.style.top = Math.round(below) + "px"; }
  }

  /* ---------- 畫 ---------- */
  function render() {
    if (!cur) return;
    if (cur.tr) return renderTr();
    const n = noteOf(), entry = entryOf(cur.page);
    if (!n || !entry) { PR.closeSticky({ discard: true }); return; }
    if (!box) { box = document.createElement("div"); box.className = "pv-sticky"; }
    if (box.parentNode !== entry.node) entry.node.append(box);
    box.innerHTML = PR.cardHtml({ src: "mine", data: n, anchor: PR.blockById[n.anchor] ? n.anchor : "page:" + n.page }, cur.edit ? n.id : null);
    PR.prepCard(box.firstChild);
    place();
  }
  PR.renderSticky = () => { if (cur && !cur.tr && !cur.edit) render(); else if (cur && cur.edit) place(); };
  /* 整張要看得到：超出去就把頁面捲一點 */
  function reveal() {
    if (!box) return;
    const r = box.getBoundingClientRect(), sc = PR.$(".pv-scroll").getBoundingClientRect();
    if (r.bottom > sc.bottom - 8 || r.top < sc.top + 4) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function focus() {
    const ta = box && box.querySelector("textarea");
    if (!ta) return;
    PR.autosize(ta);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    reveal();
  }
  /* 筆記裡的圖片載入後高度才定下來 */
  document.addEventListener("load", (e) => { if (box && e.target && e.target.tagName === "IMG" && box.contains(e.target)) { place(); reveal(); } }, true);

  /* ---------- 拖位置、拉大小：抓標題列拖；右下角拉大小（CSS resize）。放開時記在筆記裡（ui），下次打開還在那裡 ---------- */
  function rememberUi(patch) {
    if (!cur) return;
    if (cur.tr) { const old = PR.ls.get(TR_SIZE, null) || {}; if (patch.w || patch.h) PR.ls.set(TR_SIZE, { w: patch.w || old.w, h: patch.h || old.h }); return; }
    const n = saved(cur.id);
    if (n) PR.saveNote(Object.assign({}, n, { ui: Object.assign({}, n.ui, patch) }), { ui: true });
    else if (cur.draft) cur.draft.ui = Object.assign({}, cur.draft.ui, patch);
  }
  document.addEventListener("mousedown", (e) => {
    const hd = box && e.target.closest && e.target.closest(".pv-sticky .card > .hd");
    if (!hd || e.button !== 0 || e.target.closest("button, input, textarea, a")) return;
    e.preventDefault();
    const entry = entryOf(cur.page), node = entry && entry.node;
    if (!node) return;
    const x0 = e.clientX, y0 = e.clientY, left0 = box.offsetLeft, top0 = box.offsetTop;
    let moved = false;
    box.classList.add("dragging");
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      const W = node.clientWidth || 1, H = node.clientHeight || 1, w = box.offsetWidth || 300;
      box.style.bottom = "auto";
      box.style.left = Math.round(Math.max(-w + 60, Math.min(W + 280 - 60, left0 + dx))) + "px";  // 可以拖到頁邊的邊註欄上，但不能整張拖出去
      box.style.top = Math.round(Math.max(0, Math.min(H - 40, top0 + dy))) + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      box.classList.remove("dragging");
      if (!moved) return;
      const W = node.clientWidth || 1, H = node.clientHeight || 1;
      rememberUi({ x: Math.round((box.offsetLeft / W) * 10000) / 10000, y: Math.round((box.offsetTop / H) * 10000) / 10000 });
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  /* 拉了大小（瀏覽器的 resize 把手改的是卡片的 inline 寬高）：放開滑鼠時記下來 */
  document.addEventListener("mouseup", () => {
    const card = box && box.firstElementChild;
    if (!card || !card.style.width && !card.style.height) return;
    const w = Math.round(parseFloat(card.style.width) || 0), h = Math.round(parseFloat(card.style.height) || 0);
    const old = cur && (cur.tr ? (PR.ls.get(TR_SIZE, null) || {}) : ((saved(cur.id) || cur.draft || {}).ui || {}));
    if ((w && w !== (old.w || 0) && w !== Math.round(parseFloat(box.style.width) || 0)) || (h && h !== (old.h || 0))) {
      box.style.width = w + "px";
      rememberUi({ w: w || old.w, h: h || old.h });
    }
  });

  PR.openSticky = function (id, opts) {
    opts = opts || {};
    if (cur && cur.id === id && !opts.draft) {
      if (opts.edit && !cur.edit) { cur.edit = true; PR.editingNote = id; render(); focus(); }
      return;
    }
    PR.closeSticky();
    const n = opts.draft || saved(id);
    if (!n || !n.page || !entryOf(n.page)) return;
    if (PR.pdfPage && PR.pdfPage() !== n.page && !opts.draft) PR.openPage(n.page);  // 從筆記面板點過來：先翻到那一頁
    const empty = !(n.body || "").trim();
    cur = { id, page: n.page, draft: opts.draft || null, edit: !!(opts.edit || opts.draft || empty) };
    if (cur.edit) PR.editingNote = id;
    render();
    PR.renderPdfMarks(n.page);
    if (cur.edit) { focus(); if (PR.chatModel) PR.chatModel.load().then(() => PR.emit("chat-model")); }
    else setTimeout(reveal, 60);
  };

  /* 存：草稿寫了字才存成筆記；finishing 是收起時（空的問題／框選／新開的會刪掉，見 PR.finishNote） */
  function save(value, finishing) {
    if (!cur || cur.tr) return;
    const body = (value || "").trim();
    const n = saved(cur.id);
    if (!n) {
      if (!body || !cur.draft) return;
      PR.saveNote(Object.assign({}, cur.draft, { body }));
      cur.draft = null;
      return;
    }
    if (finishing) PR.finishNote(n, value || "");
    else if (body && body !== (n.body || "")) PR.saveNote(Object.assign({}, n, { body, kind: n.kind === "highlight" ? "note" : n.kind }));
  }
  const autosave = PR.debounce(() => { const ta = cur && cur.edit && box && box.querySelector("textarea"); if (ta) save(ta.value, false); }, 600);

  PR.closeSticky = function (opts) {
    if (!cur) return;
    const c = cur;
    autosave.cancel();
    if (c.tr) { if (c.tr.ctrl) c.tr.ctrl.abort(); }
    else if (!(opts && opts.discard)) {
      const ta = c.edit && box && box.querySelector("textarea");
      if (ta) save(ta.value, true);
    }
    cur = null;
    if (PR.editingNote === c.id) PR.editingNote = null;
    if (box) { box.remove(); box = null; }
    PR.renderPdfMarks(c.page);
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel();
  };

  /* 編輯時換「筆記／提問」或顏色 */
  PR.stickyPatch = function (patch) {
    if (!cur || cur.tr) return;
    const ta = box && box.querySelector("textarea");
    const body = ta ? ta.value.trim() : null;
    const n = saved(cur.id);
    if (n) PR.saveNote(Object.assign({}, n, body != null ? { body } : {}, patch));
    else if (cur.draft) Object.assign(cur.draft, body != null ? { body } : {}, patch);
    if (patch.kind && noteOf() && noteOf().region) PR.ls.set("easyread-region-kind", patch.kind);  // 框選後預設開哪一種：記上次用的
    render(); focus();
    PR.renderPdfMarks(cur.page);
  };

  /* 送出問題：存成提問、收起編輯，回答流進這張卡片 */
  PR.stickySend = function (text, mode) {
    if (!cur || cur.tr) return;
    const ta = box && box.querySelector("textarea");
    const body = (text || (ta ? ta.value : "")).trim();
    const n = noteOf();
    if (!body || !n) return;
    autosave.cancel();
    PR.saveNote(Object.assign({}, n, { body, kind: "question", mode: mode || undefined }));
    cur.draft = null; cur.edit = false;
    if (PR.editingNote === cur.id) PR.editingNote = null;
    render();
    PR.renderPdfMarks(cur.page);
    PR.askInline(cur.id);
  };

  /* ---------- 選字翻譯 ---------- */
  function renderTr() {
    const t = cur.tr, entry = entryOf(cur.page);
    if (!entry) return;
    if (!box) { box = document.createElement("div"); box.className = "pv-sticky"; }
    if (box.parentNode !== entry.node) entry.node.append(box);
    const q = t.sel.quote || "";
    box.innerHTML = '<div class="card tr"><div class="hd"><span class="ic">' + PR.icon("en", "sm") + '</span><span class="lbl">' + PR.t("翻譯") + '</span><span class="meta on">' + PR.esc(t.model || "") + "</span>" +
      (t.streaming ? '<span class="spin"></span>' : "") + '<span class="grow"></span><span class="acts on">' +
      (t.streaming ? act("trstop", "stop", PR.t("停止")) : (t.text ? act("trcopy", "copy", PR.t("复制")) + act("trsave", "note", PR.t("存成筆記")) : "") + act("trredo", "redo", PR.t("重譯"))) +
      act("trclose", "x", PR.t("关闭")) + "</span></div>" +
      '<div class="quote" lang="en">' + PR.esc(q.length > 160 ? q.slice(0, 160) + "…" : q) + "</div>" +
      '<div class="body">' + (t.error ? '<p class="err">' + PR.esc(t.error) + "</p>" : t.text ? PR.mdBlocks(t.text) : '<p class="thinking"><i></i><i></i><i></i></p>') + "</div></div>";
    place();
  }
  const paintTr = PR.throttle(() => {
    const b = cur && cur.tr && box && box.querySelector(".body");
    if (b && cur.tr.text) b.innerHTML = PR.mdBlocks(cur.tr.text);
    const m = cur && cur.tr && box && box.querySelector(".meta");
    if (m && cur.tr.model) m.textContent = cur.tr.model;
  }, 60);
  async function runTr() {
    const mine = cur, t = cur.tr;
    Object.assign(t, { text: "", error: "", streaming: true, ctrl: new AbortController() });
    renderTr();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/quick", {
        method: "POST", signal: t.ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode: "translate", text: t.sel.quote }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.model) { t.model = ev.model; paintTr(); }
          if (ev.t) { t.text += ev.t; paintTr(); }
          if (ev.error) t.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") t.error = PR.t("沒能翻譯：{msg}", { msg: e.message });
    }
    t.streaming = false; t.ctrl = null;
    if (cur === mine) renderTr();
  }
  /* 選字工具列一出現就叫伺服器把翻譯用的模型行程拉起來（claude_live），按「翻譯」時少等一秒；一分鐘內只叫一次 */
  let warmAt = 0;
  PR.warmQuick = function () {
    if (Date.now() - warmAt < 60000 || !PR.canChat || !PR.canChat()) return;
    warmAt = Date.now();
    PR.api("/api/p/" + PR.pid + "/quick", { method: "POST", body: { mode: "warm" } }).catch(() => {});
  };
  /* sel：PR.pdfSelection() 的結果（頁碼、字元範圍、框、原話） */
  PR.translateSelection = function (sel) {
    if (!sel || !sel.page || !(sel.quote || "").trim()) return;
    PR.closeSticky();
    const id = PR.uid("n");
    // 翻譯時原文上先畫一道點線，看得出譯的是哪一段；不存
    cur = { id, page: sel.page, tr: { sel }, draft: { id, side: "pdf", page: sel.page, range: sel.range, rects: sel.rects, quote: sel.quote, anchor: sel.anchor || null, kind: "question", temp: true } };
    PR.renderPdfMarks(sel.page);
    runTr();
  };
  function trClick(a) {
    const t = cur.tr;
    if (a === "trstop") { if (t.ctrl) t.ctrl.abort(); }
    else if (a === "trclose") PR.closeSticky();
    else if (a === "trredo") runTr();
    else if (a === "trcopy") navigator.clipboard.writeText(t.text).then(() => PR.toast(PR.t("已复制")));
    else if (a === "trsave") {
      const d = cur.draft, page = cur.page;
      const note = { id: d.id, side: "pdf", page, range: d.range, rects: d.rects, quote: d.quote, anchor: d.anchor, kind: "note", color: "blue", body: t.text.trim(), created: PR.nowIso() };
      cur.draft = null;
      PR.closeSticky();
      PR.saveNote(note);
      PR.renderPdfMarks(page);
      PR.toast(PR.t("已存成筆記"), { label: PR.t("撤销"), fn: () => { PR.commit({ op: "note_del", id: note.id }); PR.renderPdfMarks(page); } }, 3200);
    }
  }

  /* ---------- 事件 ---------- */
  document.addEventListener("input", (e) => {
    if (!box || !box.contains(e.target) || !e.target.matches("textarea")) return;
    PR.autosize(e.target);
    autosave();
  });
  document.addEventListener("keydown", (e) => {
    if (!cur) return;
    const inTa = box && box.contains(e.target) && e.target.matches("textarea");
    if (inTa && !cur.tr) {
      const n = noteOf();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(e.metaKey || e.ctrlKey) && n && n.kind === "question" && box.querySelector('[data-a="send"]')) {
        e.preventDefault(); e.stopPropagation(); PR.stickySend(); return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); PR.closeSticky(); return; }
    }
    if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); PR.closeSticky(); }
  }, true);
  /* 點別的地方：收起（小圓點、選字工具列、選單不算） */
  document.addEventListener("mousedown", (e) => {
    if (!cur || !e.target.closest) return;
    if (e.target.closest(".pv-sticky, .pv-badge, #ctxmenu, #selbar, #popover, .confirm, #toast, .dialog-backdrop")) return;
    PR.closeSticky();
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".pv-badge[data-note]");
    if (b) {
      e.stopPropagation(); e.preventDefault();
      if (cur && cur.id === b.dataset.note) PR.closeSticky(); else PR.openSticky(b.dataset.note);
      return;
    }
    const a = cur && cur.tr && box && box.contains(e.target) && e.target.closest("[data-a]");
    if (a) { e.stopPropagation(); trClick(a.dataset.a); }
  }, true);
  /* 快速問題的小按鈕（解釋／舉例…）：填進去直接送 */
  document.addEventListener("click", (e) => {
    const q = e.target.closest && e.target.closest(".card [data-q]");
    if (!q) return;
    const card = q.closest(".card");
    if (card.closest(".pv-sticky")) PR.stickySend(q.dataset.q, q.dataset.mode);
    else PR.sendQuestion(card.dataset.note, q.dataset.q, !!card.closest("#notespanel"), q.dataset.mode);
  });
  PR.on("remote", () => { if (cur && !cur.tr) { if (!noteOf()) PR.closeSticky({ discard: true }); else if (!cur.edit) render(); } });
  PR.on("md-preview", (ta) => { if (cur && box && box.contains(ta)) place(); });
  window.addEventListener("resize", PR.debounce(() => { if (cur) place(); }, 120));
})(window.PR);
