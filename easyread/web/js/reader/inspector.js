/* 右側面板的分頁列（像 Craft 的檢閱器：插入／格式／樣式／資訊）：原頁（文章優先時才有）、筆記、問 AI、資訊，
   開著面板時出現在面板最上面；頂欄只留一顆「右側面板」按鈕，開的是最近用的那一個。 */
(function (PR) {
  "use strict";
  const body = document.body;
  const strip = PR.el("div", { id: "inspTabs", role: "tablist" });
  body.append(strip);
  const pdf = () => !!(PR.pdfMain && PR.pdfMain());
  function paint() {
    // PDF 優先時「譯文」不是側面板（它開在 PDF 和面板中間，頂欄那顆書本鈕在管）：分頁只有筆記、問 AI；文章優先時多一個「原頁」
    // 分頁是一排圖示（字在滑鼠提示裡）：筆記、問 AI、資訊；文章優先時多一個原頁
    const tabs = [
      ["pages", PR.t("原頁"), body.classList.contains("pv-open"), !pdf() && (PR.feature ? PR.feature("pages") !== false : true), "pdf"],
      ["notes", PR.t("筆記"), body.classList.contains("np-open"), true, PR.hasIcon("notepen") ? "notepen" : "note"],
      ["chat", PR.t("問 AI"), body.classList.contains("ch-open"), PR.feature ? PR.feature("chat") !== false : true, "sparkle"],
      ["info", PR.t("資訊"), body.classList.contains("in-open"), !!PR.toggleInfo, "info"],
    ];
    strip.innerHTML = tabs.filter((t) => t[3]).map(([k, label, on, , icon]) => '<button role="tab" data-insp="' + k + '" title="' + PR.esc(label) + '" aria-label="' + PR.esc(label) + '"' + (on ? ' class="on" aria-selected="true"' : "") + ">" + PR.icon(icon, "sm") + "</button>").join("") +
      '<span class="grow"></span><button class="btn icon insp-x" data-insp="close" title="' + PR.t("關閉") + '">' + PR.icon("x", "sm") + "</button>";
    const b = PR.$('[data-act="insp"]');
    if (b) b.classList.toggle("on", !!PR.side);
    const ai = PR.$(".pv-ai");
    if (ai) ai.hidden = !!(PR.feature && PR.feature("chat") === false);
  }
  strip.addEventListener("click", (e) => {
    const b = e.target.closest("[data-insp]");
    if (!b) return;
    const k = b.dataset.insp;
    if (k === "close") PR.toggleInspector(false);
    else if (k === PR.side) return;  // 點正在看的那一頁：不動（不是把面板關掉）
    else if (k === "pages") PR.togglePages(true);
    else if (k === "notes") PR.toggleNotesPanel(true);
    else if (k === "chat") PR.toggleChat(true);
    else if (k === "info") PR.toggleInfo(true);
  });
  PR.lastSide = PR.ls.get("easyread-insp-last", "chat");
  PR.toggleInspector = function (force) {
    const open = force != null ? force : !PR.side;
    if (!open) {
      if (PR.side === "notes") PR.toggleNotesPanel(false);
      else if (PR.side === "chat") PR.toggleChat(false);
      else if (PR.side === "pages") PR.togglePages(false);
      else if (PR.side === "info") PR.toggleInfo(false);
      return;
    }
    const k = PR.lastSide === "notes" ? "notes" : PR.lastSide === "info" && PR.toggleInfo ? "info" : PR.lastSide === "pages" && !pdf() ? "pages" : "chat";
    if (k === "notes") PR.toggleNotesPanel(true); else if (k === "pages") PR.togglePages(true); else if (k === "info") PR.toggleInfo(true); else PR.toggleChat(true);
  };
  /* 「一整欄」模式：視窗夠寬（≥1180）內容本來就會讓位；PDF 優先時 PDF 那一格也會縮（>760 就行）。
     其他情況面板是蓋在內容上的（craft.css 的 body:not(.insp-col)）。 */
  function colMode() {
    const col = innerWidth >= 1180 || (pdf() && innerWidth > 760);
    if (body.classList.contains("insp-col") !== col) body.classList.toggle("insp-col", col);
  }
  new MutationObserver(() => {
    if (PR.side && PR.side !== PR.lastSide) { PR.lastSide = PR.side; PR.ls.set("easyread-insp-last", PR.side); }
    colMode();
    paint();
  }).observe(body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", colMode);
  colMode();
  /* PDF 那一格很窄時（分割視窗、旁邊又開著面板）：底部的頁碼膠囊和「問 AI」會擠在一起，讓 CSS 知道要收（craft.css 的 body.pv-narrow／pv-tiny） */
  const pvEl = PR.$("#pageview");
  if (pvEl && window.ResizeObserver) {
    new ResizeObserver(() => {
      const w = pdf() ? pvEl.clientWidth : 0;
      const narrow = w > 0 && w < 560, tiny = w > 0 && w < 400;
      if (body.classList.contains("pv-narrow") !== narrow) body.classList.toggle("pv-narrow", narrow);
      if (body.classList.contains("pv-tiny") !== tiny) body.classList.toggle("pv-tiny", tiny);
    }).observe(pvEl);
  }
  const btn = PR.$('[data-act="insp"]');
  if (btn) { btn.innerHTML = PR.icon("panelright"); btn.title = PR.t("右側面板：原頁、筆記、問 AI"); }
  paint();
})(window.PR);
