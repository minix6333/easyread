/* 阅读页快捷键的执行。键位、总开关和功能开关在 common/features.js，改键在“设置 → 快捷键”。
   选中文字后的 1–4 划线、N 笔记、Q 提问，和 Esc 关闭，只受总开关控制。 */
(function (PR) {
  "use strict";
  /* 固定的常用快捷鍵（不能改鍵），列在「說明」裡 */
  PR.shortcutRows = function () {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || ""), M = mac ? "⌘" : "Ctrl+", S = mac ? "⇧" : "Shift+";
    const rows = [[M + "F", PR.t("在 PDF 裡找字")], [M + "Z　" + M + S + "Z", PR.t("復原／重做（畫線、筆記）")], [M + "C", PR.t("複製選的字（斷行會接好）")],
      [M + "+　" + M + "-　" + M + "0", PR.t("縮放 PDF")], [M + "S", PR.t("馬上存檔（平常自動存）")], ["N　Q　T", PR.t("選字後：筆記／問 AI／翻譯")],
      [M + "B　" + M + "I", PR.t("寫筆記時：粗體／斜體")], [M + "E　" + M + S + "E", PR.t("寫筆記時：變成公式／獨立一行的公式")], [M + S + ".　" + M + S + ",", PR.t("寫筆記時：放大（標題）／縮小")],
      [M + "V", PR.t("寫筆記、問 AI 時：貼上圖片")]];
    return '<div class="keyrows wide">' + rows.map(([k, l]) => "<kbd>" + k + "</kbd><span>" + l + "</span>").join("") + "</div>";
  };

  PR.runAction = function (id) {
    // PDF 優先、譯文收著：沒有「當前段」，N 寫這一頁的筆記、Q 問 AI、J/K 翻頁；改譯文之類的不適用
    if (PR.pdfMain && PR.pdfMain() && !(PR.articleOpen && PR.articleOpen())) {
      const p = { note: () => PR.focusPageNote(), question: () => PR.toggleChat(true), next: () => PR.pageStep(1), prev: () => PR.pageStep(-1) }[id];
      if (p) { p(); return true; }
      if (["en", "edit", "redo", "page", "copy", "mode"].includes(id)) return false;
    }
    const g = {
      mode: () => PR.setPref("mode", PR.prefs.mode === "bi" ? "zh" : "bi"),
      toc: () => PR.toggleDrawer(null, "toc"),
      fontUp: () => PR.bumpFont(1), fontDown: () => PR.bumpFont(-1), fontReset: () => PR.resetType(),
      pages: () => PR.togglePages(), notes: () => PR.toggleNotesPanel(),
      chat: () => { const b = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock(); PR.blockById[b] ? PR.chatAsk({ anchor: b }) : PR.toggleChat(); },
      pagePrev: () => PR.pageStep(-1), pageNext: () => PR.pageStep(1),
      layout: () => PR.setLayout && PR.setLayout(PR.pdfMain && PR.pdfMain() ? "article" : "pdf"),
      region: () => PR.toggleRegion && PR.toggleRegion(),
    }[id];
    if (g) { g(); return true; }
    return PR.blockAction(id);
  };
})(window.PR);
