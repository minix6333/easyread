/* 複習卡（閱讀頁）：筆記面板的「卡片」分頁。這份文件的卡片清單、到期幾張、開始複習（common/review.js）、
   請 AI 從整份出卡（預讀筆記＋自己劃線、寫筆記的地方）、自己寫一張。
   從劃線／筆記出卡：卡片的選單「做成複習卡」→ AI 出一兩張 → 在這裡勾要的。AI 出的都先放在「草稿」，勾了才存。
   資料：GET/POST /api/p/<id>/cards、POST /api/p/<id>/cards/draft（cards.py）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const st = { cards: null, drafts: [], drafting: null, adding: null, editing: null, ctrl: null };
  const api = (body) => PR.api("/api/p/" + PR.pid + "/cards", { method: "POST", body }).then((d) => { st.cards = d.cards || []; return st.cards; });
  const load = () => (st.cards ? Promise.resolve(st.cards) : PR.api("/api/p/" + PR.pid + "/cards").then((d) => (st.cards = d.cards || []), () => (st.cards = [])));
  const repaint = () => { if (PR.notesPanelOpen && PR.notesPanelOpen() && PR.notesTab && PR.notesTab() === "cards") PR.renderNotesPanel(null); else if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel(); };
  const due = () => (st.cards || []).filter((c) => PR.srs.isDue(c.srs));
  const curPage = () => (PR.pdfPage ? PR.pdfPage() : 1);
  const docTitle = () => { const m = (S.paper && S.paper.meta) || {}; return m.title_en || m.title_zh || ""; };
  const md = (s) => (PR.md ? PR.md(s || "", { cite: false, xref: false }) : PR.esc(s || ""));

  PR.cardsPanel = {
    count: () => (st.cards ? due().length : 0),
    reload() { st.cards = null; repaint(); },  // 別處加了卡（術語表的「做成複習卡」）：下次畫的時候重新取
    html() {
      if (!st.cards) { load().then(repaint); return '<p class="hint" style="padding:16px">' + PR.t("加载中…") + "</p>"; }
      const d = due().length, can = PR.canChat && PR.canChat();
      const tools = '<div class="cd-tools">' +
        (d ? '<button class="btn sm accent" data-cd="review">' + PR.icon("l-brain", "sm") + PR.t("複習 {n} 張", { n: d }) + "</button>" : '<span class="cd-none">' + PR.esc(st.cards.length ? PR.t("今天沒有到期的卡") : "") + "</span>") +
        '<span class="grow"></span>' +
        (can ? '<button class="btn icon" data-cd="ai" title="' + PR.t("請 AI 從整份出卡（優先考你劃線、寫筆記的地方）") + '"' + (st.drafting ? " disabled" : "") + ">" + PR.icon("sparkle", "sm") + "</button>" : "") +
        '<button class="btn icon" data-cd="add" title="' + PR.t("自己寫一張") + '">' + PR.icon("plus", "sm") + "</button></div>";
      return '<div class="np-cards">' + tools + draftsHtml() + (st.adding ? formHtml(st.adding, "new") : "") + listHtml() + "</div>";
    },
    mounted(el) {
      const ta = el.querySelector(".cd-form textarea");
      if (ta && !ta.value) ta.focus();
      PR.$$(".cd-form textarea", el).forEach(PR.autosize);
    },
  };
  function draftsHtml() {
    if (st.drafting) return '<div class="cd-drafts"><div class="cd-dh"><span class="spin"></span>' + PR.esc(st.drafting === "doc" ? PR.t("AI 正在讀整份出卡…") : PR.t("AI 正在出卡…")) +
      '<span class="grow"></span><button class="btn sm line" data-cd="stop">' + PR.t("停止") + "</button></div></div>";
    if (!st.drafts.length) return "";
    const n = st.drafts.filter((x) => x.keep).length;
    return '<div class="cd-drafts"><div class="cd-dh">' + PR.icon("sparkle", "sm") + "<b>" + PR.esc(PR.t("AI 出了 {n} 張，勾你要的", { n: st.drafts.length })) + "</b></div>" +
      st.drafts.map((x, i) => '<label class="cd-draft"><input type="checkbox" data-cdk="' + i + '"' + (x.keep ? " checked" : "") + '><span class="cd-qa"><span class="cd-q">' + md(x.q) + '</span><span class="cd-a">' + md(x.a) + "</span>" +
        (x.page ? '<span class="cd-meta">p.' + x.page + "</span>" : "") + "</span></label>").join("") +
      '<div class="cd-df"><button class="btn sm line" data-cd="drop">' + PR.t("都不要") + '</button><span class="grow"></span><button class="btn sm accent" data-cd="keep"' + (n ? "" : " disabled") + ">" +
      PR.t("加入 {n} 張", { n }) + "</button></div></div>";
  }
  function formHtml(c, key) {
    return '<div class="cd-form" data-cdf="' + PR.esc(key) + '"><textarea data-cdq rows="2" placeholder="' + PR.t("問題") + '">' + PR.esc(c.q || "") + "</textarea>" +
      '<textarea data-cda rows="2" placeholder="' + PR.t("答案") + '">' + PR.esc(c.a || "") + "</textarea>" +
      '<div class="cd-ff"><span class="cd-meta">' + (c.page ? "p." + c.page : "") + '</span><span class="grow"></span><button class="btn sm line" data-cd="cancel">' + PR.t("取消") + '</button><button class="btn sm accent" data-cd="save">' + PR.t("存") + "</button></div></div>";
  }
  function listHtml() {
    if (!st.cards.length && !st.drafts.length && !st.adding && !st.drafting) {
      return '<div class="cd-empty">' + PR.icon("l-brain", "sm") + "<p>" + PR.esc(PR.t("把要記住的變成問答卡，到期了再拿出來考自己。")) + "</p></div>";
    }
    const now = Date.now();
    return '<div class="cd-list">' + st.cards.slice().sort((a, b) => (a.page || 0) - (b.page || 0) || String(a.created).localeCompare(String(b.created))).map((c) => {
      if (st.editing === c.id) return formHtml(c, c.id);
      const isDue = PR.srs.isDue(c.srs, now);
      return '<div class="cd-card' + (isDue ? " due" : "") + '" data-cid="' + PR.esc(c.id) + '"><div class="cd-q">' + md(c.q) + '</div><div class="cd-a">' + md(c.a) + "</div>" +
        '<div class="cd-row">' + (c.page ? '<button class="cd-pg" data-cd="go" title="' + PR.esc(PR.t("翻到第 {page} 頁", { page: c.page })) + '">p.' + c.page + "</button>" : "") +
        '<span class="cd-when">' + PR.esc(PR.srs.when(c.srs, now)) + '</span><span class="grow"></span>' +
        '<button class="cd-ib" data-cd="edit" title="' + PR.t("编辑") + '">' + PR.icon("edit", "sm") + '</button><button class="cd-ib" data-cd="del" title="' + PR.t("删除") + '">' + PR.icon("trash", "sm") + "</button></div></div>";
    }).join("") + "</div>";
  }

  /* ---------- 出卡 ---------- */
  async function draft(body, kind) {
    if (st.drafting) return;
    const ctrl = new AbortController();
    st.ctrl = ctrl; st.drafting = kind;
    repaint();
    try {
      const r = await fetch("/api/p/" + PR.pid + "/cards/draft", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      const got = (d.cards || []).map((c) => Object.assign({ keep: true }, c, body.src ? { src: body.src, quote: body.quote || c.quote } : {}));
      if (!got.length) PR.toast(PR.t("AI 沒出到卡（可能資料太少）"));
      st.drafts = st.drafts.concat(got);
    } catch (e) { if (e.name !== "AbortError") PR.toast(PR.t("沒出成：{msg}", { msg: PR.esc(e.message) })); }
    if (st.ctrl === ctrl) { st.ctrl = null; st.drafting = null; }
    repaint();
  }
  /* 卡片選單的「做成複習卡」：那一則劃線／筆記 → AI 出一兩張 */
  PR.cardsFromNote = function (n) {
    if (!n) return;
    PR.toggleNotesPanel(true, "cards");
    draft({ from: "note", page: n.page || (PR.blockById[n.anchor] || {}).page || 0, quote: n.quote || "", text: n.body || "", src: n.id }, "note");
  };

  /* ---------- 事件 ---------- */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("#notespanel [data-cd]");
    if (!b) return;
    const k = b.dataset.cd, card = b.closest("[data-cid]"), c = card && (st.cards || []).find((x) => x.id === card.dataset.cid);
    if (k === "review") {
      const list = due().map((x) => Object.assign({}, x, { pid: PR.pid, doc: docTitle() }));
      return PR.review.open(list, { title: docTitle(), onDone: () => { st.cards = null; load().then(repaint); } });
    }
    if (k === "ai") return draft({ from: "doc" }, "doc");
    if (k === "stop" && st.ctrl) return st.ctrl.abort();
    if (k === "add") { st.adding = { q: "", a: "", page: curPage() }; st.editing = null; return repaint(); }
    if (k === "cancel") { st.adding = null; st.editing = null; return repaint(); }
    if (k === "save") {
      const f = b.closest(".cd-form"), q = f.querySelector("[data-cdq]").value.trim(), a = f.querySelector("[data-cda]").value.trim();
      if (!q || !a) return PR.toast(PR.t("問題和答案都要有字"));
      try {
        if (f.dataset.cdf === "new") await api({ op: "add", cards: [{ q, a, page: st.adding && st.adding.page }] });
        else await api({ op: "update", id: f.dataset.cdf, fields: { q, a } });
        st.adding = null; st.editing = null;
      } catch (err) { PR.toast(PR.t("沒存成：{msg}", { msg: PR.esc(err.message) })); }
      return repaint();
    }
    if (k === "keep") {
      const keep = st.drafts.filter((x) => x.keep).map(({ q, a, page, quote, src }) => ({ q, a, page, quote, src }));
      try { await api({ op: "add", cards: keep }); st.drafts = []; PR.toast(PR.t("加了 {n} 張卡", { n: keep.length }), null, 1600); }
      catch (err) { PR.toast(PR.t("沒存成：{msg}", { msg: PR.esc(err.message) })); }
      return repaint();
    }
    if (k === "drop") { st.drafts = []; return repaint(); }
    if (k === "edit" && c) { st.editing = c.id; st.adding = null; return repaint(); }
    if (k === "del" && c) {
      if (!(await PR.confirm({ title: PR.t("刪掉這張卡？"), body: PR.t("複習的記錄也一起刪掉。"), ok: PR.t("删除"), danger: true, at: b }))) return;
      try { await api({ op: "delete", id: c.id }); } catch (err) { PR.toast(PR.esc(err.message)); }
      return repaint();
    }
    if (k === "go" && c && c.page) return PR.openPage(c.page);
  });
  document.addEventListener("change", (e) => {
    const box = e.target.closest && e.target.closest("#notespanel [data-cdk]");
    if (!box) return;
    const x = st.drafts[+box.dataset.cdk];
    if (x) x.keep = box.checked;
    const btn = PR.$("#notespanel [data-cd=keep]"), n = st.drafts.filter((y) => y.keep).length;
    if (btn) { btn.disabled = !n; btn.textContent = PR.t("加入 {n} 張", { n }); }
  });
  document.addEventListener("input", (e) => { if (e.target.closest && e.target.closest("#notespanel .cd-form") && e.target.tagName === "TEXTAREA") PR.autosize(e.target); });
  /* 打開文件時先取一次（筆記面板的「卡片」上要顯示到期幾張） */
  PR.on("rendered", () => { if (!st.cards && PR.store && PR.store.mode === "server") load().then(() => { if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel(); }); });
})(window.PR);
