/* 把聊天裡的回答加進筆記，而且分類放：論文筆記（筆記面板的「總結」）裡每個分類是一個「## 分類」小節，
   加進去的內容接在那一節的最後；沒有那一節就在最後新開一節。分類有預設的幾個（基礎觀念、定義、公式與推導…），
   筆記裡自己寫的 ## 小標題也算分類，所以要怎麼分由讀者決定。也可以加到正在看的那一頁的筆記。
   PR.noteInsert / PR.noteSnippet / PR.noteCategories 是純函式（tests/test_noteadd.cjs）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const DEFAULT = () => [PR.t("基礎觀念"), PR.t("定義"), PR.t("公式與推導"), PR.t("方法"), PR.t("結果"), PR.t("疑問"), PR.t("其他")];
  const isH2 = (l) => /^##\s+\S/.test(l);
  const h2Name = (l) => l.replace(/^##\s+/, "").trim();
  const headings = (body) => String(body || "").split("\n").filter(isH2).map(h2Name);

  /* 可以選的分類：筆記裡已經有的小節在前（照出現順序），再補上預設的 */
  PR.noteCategories = function (body) {
    const seen = new Set();
    return headings(body).concat(DEFAULT()).filter((c) => c && !seen.has(c) && seen.add(c));
  };

  /* 要加進去的那一段：問題當標題（粗體，附頁碼），回答跟在後面；回答裡的 #、## 標題降成 ###，才不會變成新的分類 */
  PR.noteSnippet = function (item) {
    const text = String(item.body || "").trim().replace(/^(#{1,2})\s+/gm, "### ");
    const title = String(item.title || "").replace(/\s+/g, " ").trim();
    const head = title ? "**" + (title.length > 120 ? title.slice(0, 120) + "…" : title) + "**" + (item.page ? PR.t("（第 {page} 页）", { page: item.page }) : "") : "";
    return (head ? head + "\n\n" : "") + text;
  };

  /* 純函式：把 snippet 放進 body 裡「## category」那一節的末尾；沒有那一節就在最後新開一節 */
  PR.noteInsert = function (body, category, snippet) {
    const lines = String(body || "").replace(/\s+$/, "").split("\n");
    const start = lines.findIndex((l) => isH2(l) && h2Name(l) === category);
    const piece = String(snippet || "").trim();
    if (start < 0) {
      const cur = lines.join("\n").trim();
      return (cur ? cur + "\n\n" : "") + "## " + category + "\n\n" + piece + "\n";
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (isH2(lines[i])) { end = i; break; }
    const before = lines.slice(0, end).join("\n").replace(/\s+$/, ""), after = lines.slice(end).join("\n");
    return before + "\n\n" + piece + "\n" + (after ? "\n" + after : "");
  };

  function afterChange() {
    if (PR.notesPanelOpen && PR.notesPanelOpen() && PR.renderNotesPanel) PR.renderNotesPanel();
  }
  /* item：{title, body, page}。at：選單出現在哪個按鈕旁 */
  PR.noteAddMenu = function (at, item) {
    const page = item.page || (PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : 0);
    const put = (category) => {
      const was = (S.reader.paper_note || {}).body || "";
      PR.commit({ op: "paper_note", body: PR.noteInsert(was, category, PR.noteSnippet(item)) });
      afterChange();
      PR.toast(PR.t("已加到筆記的「{c}」", { c: PR.esc(category) }), { label: PR.t("撤销"), fn: () => { PR.commit({ op: "paper_note", body: was }); afterChange(); } }, 5000);
    };
    const items = PR.noteCategories((S.reader.paper_note || {}).body).map((c) => ({ label: c, icon: "tag", fn: () => put(c) }));
    items.push({ label: PR.t("新分類…"), icon: "plus", fn: async () => {
      const name = await PR.promptText({ title: PR.t("新分類"), value: "", ok: PR.t("加入"), at });
      if (name && name.trim()) put(name.trim().replace(/^#+\s*/, ""));
    } });
    if (page) {
      items.push("-", { label: PR.t("本頁筆記（第 {page} 頁）", { page }), icon: "notebook", fn: () => {
        const pn = (S.reader.page_notes || {})[page] || {}, was = pn.body || "";
        const body = (was.trim() ? was.replace(/\s+$/, "") + "\n\n" : "") + PR.noteSnippet(Object.assign({}, item, { page: 0 }));
        PR.commit(Object.assign({ op: "page_note", page, body }, pn.star ? { star: true } : {}));
        afterChange();
        PR.toast(PR.t("已加到第 {page} 頁的筆記", { page }), { label: PR.t("撤销"), fn: () => { PR.commit(Object.assign({ op: "page_note", page, body: was }, pn.star ? { star: true } : {})); afterChange(); } }, 5000);
      } });
    }
    PR.menu(at, items);
  };
})(window.PR);
