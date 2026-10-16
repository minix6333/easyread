/* 右側面板的「資訊」分頁：這份文件是什麼（標題、作者、來源、日期、頁數）、讀到哪、畫了幾處、幾個常用操作。
   像 Craft 檢閱器的「資訊」：上面是屬性，下面一排一排的操作。面板開關和別的分頁共用 PR.openSide（pageview.js）、分頁列在 inspector.js。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const panel = PR.$("#infopanel");
  if (!panel) return;
  const open = () => PR.side === "info";
  const meta = () => (S.paper && S.paper.meta) || {};
  const item = () => S.item || {};
  const STATUS = [["unread", PR.t("未读"), "unread"], ["reading", PR.t("在读"), "reading"], ["done", PR.t("已读"), "check2"]];  // 閱讀狀態：三顆圖示（虛線圈、圈中一點、打勾）

  function counts() {
    const c = { highlight: 0, note: 0, question: 0, ai: 0 };
    for (const n of Object.values((S.reader || {}).notes || {})) {
      if (!n || n.deleted) continue;
      const k = n.kind === "question" ? "question" : n.kind === "highlight" && !n.body ? "highlight" : "note";
      c[k]++;
    }
    c.ai = ((S.discussion || {}).entries || []).length;
    return c;
  }
  // 一列：圖示＋值（欄位名稱在滑鼠提示裡，畫面上不寫「來源」「日期」這些字）
  const row = (icon, label, value) => (value ? '<div class="in-row" title="' + PR.esc(label) + '">' + PR.icon(icon, "sm") + "<b>" + value + "</b></div>" : "");
  // 操作是一排圖示鈕（開原 PDF、複製引用、匯出筆記），字在滑鼠提示裡
  const act = (icon, label, attrs) => "<" + (attrs.href ? "a" : "button") + ' class="in-act" title="' + PR.esc(label) + '" aria-label="' + PR.esc(label) + '"' + Object.entries(attrs).map(([k, v]) => " " + k + '="' + PR.esc(v) + '"').join("") + ">" + PR.icon(icon, "sm") + "</" + (attrs.href ? "a" : "button") + ">";

  function render() {
    const m = meta(), it = item(), n = (m.pages || []).length || m.page_count || 0;
    const tr = S.paper.translation || {}, done = (tr.done_pages || []).length;
    const page = PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : (S.reader.progress || {}).page || 0;
    const zh = m.title_zh || "", en = m.title_en || "";
    const src = m.venue || m.arxiv || "", c = counts(), pdf = PR.pdfUrl ? PR.pdfUrl(1) : "";
    const abs = m.abstract_zh || m.abstract_en || "";
    const starred = !!it.starred, status = it.status || "unread";
    panel.innerHTML = '<div class="in-body">' +
      '<div class="in-head"><h2>' + PR.esc(zh || en || m.short_zh || "") + "</h2>" + (zh && en ? '<p class="in-en">' + PR.esc(en) + "</p>" : "") +
      (m.authors ? '<p class="by">' + PR.esc(m.authors) + (m.affiliation ? " · " + PR.esc(m.affiliation) : "") + "</p>" : "") + "</div>" +
      (PR.store.mode === "server" ? '<div class="in-status"><div class="seg">' + STATUS.map(([k, l, ic]) => '<button data-in-status="' + k + '" title="' + PR.esc(l) + '" aria-label="' + PR.esc(l) + '"' + (k === status ? ' class="on"' : "") + ">" + PR.icon(PR.hasIcon(ic) ? ic : "check", "sm") + "</button>").join("") + "</div>" +
        '<button class="btn icon in-star' + (starred ? " on" : "") + '" data-in="star" title="' + (starred ? PR.t("取消星标") : PR.t("加星标")) + '">' + PR.icon("star", "sm") + "</button></div>" : "") +
      '<div class="in-rows">' +
      row("link", PR.t("來源"), src ? (m.url ? '<a href="' + PR.esc(m.url) + '" target="_blank" rel="noopener">' + PR.esc(src) + "</a>" : PR.esc(src)) : "") +
      row("clock", PR.t("日期"), PR.esc(m.date || m.year || "")) +
      row("page", PR.t("頁數"), n ? PR.t("{n} 页", { n }) + (m.kind && m.kind !== "paper" ? " · " + PR.esc(PR.kindName(m.kind)) : "") : "") +
      row("book", PR.t("譯文"), n ? (done >= n ? PR.t("都譯好了") : done ? PR.t("已译 {done} / {n} 页", { done, n }) : PR.t("還沒有")) : "") +
      row("plus", PR.t("加入"), it.added ? PR.esc(PR.relTime(it.added)) : "") +
      "</div>" +
      (n && page ? '<div class="in-prog" title="' + PR.t("第 {p} / {n} 页", { p: page, n }) + '"><i style="width:' + Math.round((Math.min(n, page) / n) * 100) + '%"></i></div><p class="in-note">' + PR.t("第 {p} / {n} 页", { p: page, n }) + "</p>" : "") +
      '<div class="in-chips">' +
      [["highlight", PR.t("畫線"), "highlighter"], ["note", PR.t("筆記"), "sticky"], ["question", PR.t("提問"), "help"], ["ai", "AI", "sparkle"]].map(([k, l, ic]) =>
        '<button data-in="notes" title="' + PR.esc(l) + '" aria-label="' + PR.esc(l) + '"' + (c[k] ? "" : ' class="zero"') + ">" + PR.icon(PR.hasIcon(ic) ? ic : "note", "sm") + "<b>" + c[k] + "</b></button>").join("") + "</div>" +
      '<div class="in-acts">' +
      (pdf ? act("pdf", PR.t("打开原 PDF"), { href: pdf, target: "_blank", rel: "noopener" }) : "") +
      (PR.cite ? act("copy", PR.t("复制引用"), { "data-in": "cite" }) : "") +
      act("download", PR.t("导出笔记…"), { "data-in": "export" }) +
      "</div>" +
      (abs ? '<h4 class="in-h">' + PR.t("摘要") + '</h4><p class="in-abs" data-in="abs">' + PR.esc(abs) + "</p>" : "") +
      "</div>";
  }

  async function patch(fields) {
    Object.assign(S.item || (S.item = {}), fields);  // 先改畫面，再存
    render();
    try { await PR.api("/api/p/" + PR.pid + "/item", { method: "POST", body: fields }); }
    catch (e) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) })); }
  }
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => PR.toast(PR.t("已复制") + what, null, 1400));
  panel.addEventListener("click", (e) => {
    const st = e.target.closest("[data-in-status]");
    if (st) return patch({ status: st.dataset.inStatus });
    const b = e.target.closest("[data-in]");
    if (!b) return;
    const a = b.dataset.in, m = meta();
    if (a === "star") patch({ starred: !item().starred });
    else if (a === "notes") PR.toggleNotesPanel(true);
    else if (a === "export") PR.openExport();
    else if (a === "abs") b.classList.toggle("open");
    else if (a === "cite") PR.menu(b, [
      { label: "GB/T 7714", icon: "copy", fn: () => copy(PR.cite(m, "gb"), " GB/T 7714") },
      { label: "APA", icon: "copy", fn: () => copy(PR.cite(m, "apa"), " APA") },
      { label: "BibTeX", icon: "copy", fn: () => copy(PR.cite(m, "bibtex"), " BibTeX") },
    ]);
  });

  PR.toggleInfo = function (force) {
    const want = force != null ? !!force : !open();
    if (want) render();
    PR.openSide(want ? "info" : null);
  };
  const refresh = PR.debounce(() => { if (open()) render(); }, 150);
  PR.on("reader", (op) => { if (!(op && op.op === "progress")) refresh(); });
  PR.on("remote", refresh);
  const sc = PR.$(".pv-scroll");
  if (sc) sc.addEventListener("scroll", PR.throttle(() => {  // 進度那一條跟著翻頁走（只換那兩個地方，不整個重畫）
    if (!open() || !(PR.pdfMain && PR.pdfMain())) return;
    const n = (meta().pages || []).length, p = PR.pdfPage ? PR.pdfPage() : 0, bar = PR.$(".in-prog i", panel), note = PR.$(".in-prog + .in-note", panel);
    if (n && p && bar) { bar.style.width = Math.round((p / n) * 100) + "%"; if (note) note.textContent = PR.t("第 {p} / {n} 页", { p, n }); }
  }, 300), { passive: true });
})(window.PR);
