/* 导出笔记：勾选要哪些（我的笔记、划线、我的问题、AI 的回答和解释、论文笔记、问 AI 的对话），导出 Markdown。
   也可以「存成獨立筆記」：同一份內容變成文獻庫裡的一份筆記（notes.py），連回這篇文件，之後在筆記頁繼續整理。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const KINDS = [
    ["paper", PR.t("论文笔记（整篇的感悟）")], ["note", PR.t("我的笔记")], ["highlight", PR.t("我的划线")], ["question", PR.t("我的问题")],
    ["ai", PR.t("AI 的回答和解释（页边）")], ["chat", PR.t("问 AI 的对话记录")], ["quote", PR.t("每条附上原文引用")],
  ];

  function counts() {
    const notes = PR.myNotes();
    return {
      paper: (S.reader.paper_note || {}).body ? 1 : 0,
      note: notes.filter((n) => n.kind === "note" || (n.kind !== "question" && n.kind !== "highlight")).length,
      highlight: notes.filter((n) => n.kind === "highlight").length,
      question: notes.filter((n) => n.kind === "question").length,
      ai: (S.discussion.entries || []).length,
    };
  }

  PR.openExport = function () {
    const c = counts();
    const saved = PR.ls.get("easyread-export", { paper: true, note: true, highlight: true, question: true, ai: true, chat: false, quote: true });
    const dlg = PR.$("#readerDlg");
    dlg.querySelector(".dialog").innerHTML = "<h2>" + PR.t("导出笔记") + "</h2><div class=\"exp-opts\">" +
      KINDS.map(([k, l]) => '<label><input type="checkbox" data-exp="' + k + '"' + (saved[k] ? " checked" : "") + ">" + l +
        (c[k] != null ? '<span class="n">' + PR.t("{n} 条", { n: c[k] }) + "</span>" : "") + "</label>").join("") +
      '</div><p class="hint">' + PR.t("导出成 Markdown，按原文章节顺序排，可以直接放进 Obsidian、Notion。") + "</p>" +
      '<div class="actions"><button class="btn" data-exp-close>' + PR.t("取消") + "</button>" +
      (PR.store.mode === "server" ? '<span class="grow"></span><button class="btn" data-exp-go="note">' + PR.icon(PR.hasIcon("notes") ? "notes" : "notebook", "sm") + PR.t("存成獨立筆記") + "</button>" : "") +
      '<button class="btn primary" data-exp-go="file">' + PR.t("导出") + "</button></div>";
    dlg.classList.add("open");
  };

  PR.$("#readerDlg").addEventListener("click", async (e) => {
    const dlg = PR.$("#readerDlg");
    if (e.target.closest("[data-exp-close]")) return dlg.classList.remove("open");
    const go = e.target.closest("[data-exp-go]");
    if (!go) return;
    const pick = {};
    PR.$$("[data-exp]", dlg).forEach((i) => (pick[i.dataset.exp] = i.checked));
    PR.ls.set("easyread-export", pick);
    let chat = [];
    if (pick.chat) {
      let data = S.chat || {};
      if (PR.store.mode === "server") {
        try { data = await PR.api("/api/p/" + PR.pid + "/chat"); }
        catch (err) { PR.toast(PR.t("读不到对话记录：{msg}", { msg: PR.esc(err.message) })); return; }
      }
      chat = data.threads ? data.threads.flatMap((t) => t.messages || []) : data.messages || [];
    }
    const text = PR.notesMarkdown(pick, chat);
    if ((go.dataset || {}).expGo === "note") {  // 存成獨立筆記：第一行的大標題拿來當筆記的標題，其餘是正文
      const m = S.paper.meta || {}, title = (m.short_zh || m.title_zh || m.title_en || PR.t("论文")) + " " + PR.t("筆記");
      try {
        const n = await PR.api("/api/notes", { method: "POST", body: { title, body: text.replace(/^# [^\n]*\n+/, ""), papers: [PR.pid] } });
        dlg.classList.remove("open");
        if (PR.notesChanged) PR.notesChanged();
        PR.toast(PR.t("已存成獨立筆記"), { label: PR.t("打開"), fn: () => PR.navigate("/note/" + n.id) }, 7000);
      } catch (err) { PR.toast(PR.t("沒建成：{msg}", { msg: PR.esc(err.message) })); }
      return;
    }
    const stem = ((S.paper.meta || {}).short_zh || (S.paper.meta || {}).title_zh || PR.t("论文")).replace(/[\\/:*?"<>|]/g, "");
    const a = PR.el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })), download: stem + PR.t("-笔记.md") });
    document.body.appendChild(a); a.click(); a.remove();
    dlg.classList.remove("open");
  });
})(window.PR);
