/* 右側面板的分頁列（像 Craft 的檢閱器：插入／格式／樣式／資訊）：原頁（PDF 優先時是「譯文」）、筆記、問 AI 三個分頁，
   開著面板時出現在面板最上面；頂欄只留一顆「右側面板」按鈕，開的是最近用的那一個。 */
(function (PR) {
  "use strict";
  const body = document.body;
  const strip = PR.el("div", { id: "inspTabs", role: "tablist" });
  body.append(strip);
  const pdf = () => !!(PR.pdfMain && PR.pdfMain());
  function paint() {
    const tabs = [
      ["pages", pdf() ? PR.t("譯文") : PR.t("原頁"), pdf() ? body.classList.contains("art-open") : body.classList.contains("pv-open"), PR.feature ? PR.feature("pages") !== false : true],
      ["notes", PR.t("筆記"), body.classList.contains("np-open"), true],
      ["chat", PR.t("問 AI"), body.classList.contains("ch-open"), PR.feature ? PR.feature("chat") !== false : true],
    ];
    strip.innerHTML = tabs.filter((t) => t[3]).map(([k, label, on]) => '<button role="tab" data-insp="' + k + '"' + (on ? ' class="on" aria-selected="true"' : "") + ">" + label + "</button>").join("") +
      '<span class="grow"></span><button class="btn icon insp-x" data-insp="close" title="' + PR.t("關閉") + '">' + PR.icon("x", "sm") + "</button>";
    const b = PR.$('[data-act="insp"]');
    if (b) b.classList.toggle("on", !!PR.side);
  }
  strip.addEventListener("click", (e) => {
    const b = e.target.closest("[data-insp]");
    if (!b) return;
    const k = b.dataset.insp;
    if (k === "close") PR.toggleInspector(false);
    else if (k === "pages") PR.togglePages();
    else if (k === "notes") PR.toggleNotesPanel(PR.side !== "notes");
    else if (k === "chat") PR.toggleChat(PR.side !== "chat");
  });
  PR.lastSide = PR.ls.get("easyread-insp-last", "chat");
  PR.toggleInspector = function (force) {
    const open = force != null ? force : !PR.side;
    if (!open) {
      if (PR.side === "notes") PR.toggleNotesPanel(false);
      else if (PR.side === "chat") PR.toggleChat(false);
      else if (PR.side === "pages") PR.togglePages(false);
      return;
    }
    const k = PR.lastSide === "notes" ? "notes" : PR.lastSide === "pages" && !pdf() ? "pages" : "chat";
    if (k === "notes") PR.toggleNotesPanel(true); else if (k === "pages") PR.togglePages(true); else PR.toggleChat(true);
  };
  new MutationObserver(() => {
    if (PR.side && PR.side !== PR.lastSide) { PR.lastSide = PR.side; PR.ls.set("easyread-insp-last", PR.side); }
    paint();
  }).observe(body, { attributes: true, attributeFilter: ["class"] });
  const btn = PR.$('[data-act="insp"]');
  if (btn) { btn.innerHTML = PR.icon("panelright"); btn.title = PR.t("右側面板：原頁、筆記、問 AI"); }
  paint();
})(window.PR);
