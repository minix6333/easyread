/* 把聊天裡的回答加進筆記，而且分類放：論文筆記（筆記面板的「總結」）裡每個分類是一個「## 分類」小節，
   加進去的內容接在那一節的最後；沒有那一節就在最後新開一節。分類有預設的幾個（基礎觀念、定義、公式與推導…），
   筆記裡自己寫的 ## 小標題也算分類，所以要怎麼分由讀者決定。也可以加到正在看的那一頁的筆記。
   加進去之前先改寫成筆記的樣子（PR.asNote → notehelp.py 的 asnote）：主題是小標題、重點先講、條列，
   沒有「好問題」「希望有幫助」「你問的」這種回答的口吻。AI 用不了時只做簡單的清理（PR.noteFromAnswer）。
   外部工具欄的 AI 的回答（dock-ai.js）用 PR.addAnswerAsNote 存進這一頁的筆記；提問紀錄「改成筆記」用 PR.qaToNote。
   PR.noteInsert / PR.noteSnippet / PR.noteCategories / PR.noteFromAnswer / PR.noteTopic 是純函式（tests/test_noteadd.cjs）。 */
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

  /* 一條頁邊筆記的出處卡：「> [!ref 筆記id p頁碼] 原話（或筆記的第一行）」——總結裡只有一行、收著，點展開看內容，點箭頭跳回文件裡那個位置 */
  PR.noteRefLine = function (n) {
    const page = (n.side === "pdf" && n.page) || (PR.blockById[n.anchor] || {}).page || 0;
    const label = String(n.quote || PR.plain((n.body || "").split("\n")[0]) || PR.t("筆記")).replace(/\s+/g, " ").trim();
    return "> [!ref " + n.id + (page ? " p" + page : "") + "] " + (label.length > 80 ? label.slice(0, 80) + "…" : label);
  };
  /* ---------- 回答改寫成筆記 ---------- */
  const OPEN = /^\s*(?:好(?:的|問題)|當然|沒問題|是的|這是(?:一個)?(?:很)?好(?:的)?問題|簡單(?:來|地)?說|我們(?:來|先)|讓我(?:們)?(?:來)?|以下(?:是|為)|下面(?:是|我))[^\n]*\n+/;  // i18n-ok 比對回答的開場白
  const CLOSE = /^(?:希望(?:這|以上|對你|能)|如果(?:你|您)?(?:還|想|需要|有)|有(?:需要|任何問題|其他問題)|需要的話|歡迎(?:再|繼續)|祝你|還有(?:什麼|其他)(?:問題|想)|要不要我)/;  // i18n-ok 比對回答的結語、追問
  /* 問題 → 筆記的主題：去掉問號和「是什麼」「為什麼」這類問法 */
  PR.noteTopic = (q) => String(q || "").replace(/\s+/g, " ").replace(/^「[^」]*」\s*[—-]\s*/, "").replace(/^[「『"]|[」』"]$/g, "")  // i18n-ok 標點
    .replace(/[？?。.!！]+$/, "").replace(/(?:到底)?(?:是什麼|是甚麼|是啥|為什麼|為何|怎麼(?:做|算|來的|用)?|如何|嗎|呢|吧)$/, "").trim().slice(0, 40);  // i18n-ok 比對問法
  /* 沒有 AI 時的簡單版本：拿掉開場白和結語、標題降級，主題放在最前面 */
  PR.noteFromAnswer = function (item) {
    const lines = String(item.body || "").trim().replace(OPEN, "").split("\n");
    while (lines.length && (!lines[lines.length - 1].trim() || CLOSE.test(lines[lines.length - 1].trim().replace(/^[*_>\-\s]+/, "")))) lines.pop();
    const body = lines.join("\n").trim().replace(/^#{1,3}\s+/gm, "#### ");
    const topic = PR.noteTopic(item.title);
    return (topic ? "### " + topic + "\n\n" : "") + body;
  };
  const tidyNote = (md) => {  // 模型偶爾包在 ``` 裡、或加一句開場白、結語：拿掉
    let s = String(md || "").replace(/^\s*(?:以下是|這是|改好的|整理好的)[^\n]*[:：]\s*\n/, "");  // i18n-ok 比對開場白
    const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);
    if (m) s = m[1];
    const lines = s.trim().split("\n");
    while (lines.length && (!lines[lines.length - 1].trim() || CLOSE.test(lines[lines.length - 1].trim()))) lines.pop();
    return lines.join("\n").trim().replace(/^#{1,2}\s+/gm, "### ");  // 不會變成筆記裡的分類（## 分類）
  };
  const withPage = (md, page) => (page ? md.replace(/^(###\s+[^\n]*?)\s*$/m, (m0, h) => h + PR.t("（第 {page} 頁）", { page })) : md);
  /* item：{title（問題）, body（回答）, page}。回傳 { md, ai }（ai：是不是 AI 改寫的） */
  PR.asNote = async function (item) {
    if (!(PR.canChat && PR.canChat()) || PR.store.mode !== "server") return { md: PR.noteFromAnswer(item), ai: false };
    try {
      if (PR.chatModel) await PR.chatModel.load();
      const res = await fetch("/api/p/" + PR.pid + "/notehelp", { method: "POST", headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode: "asnote", question: item.title || "", answer: item.body || "", page: item.page || 0, model: PR.chatModel ? PR.chatModel.id() : "" }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      let out = "";
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.t) out += ev.t;
      }
      out = tidyNote(out);
      if (!out) throw new Error("empty");
      return { md: out, ai: true };
    } catch (e) {
      return { md: PR.noteFromAnswer(item), ai: false, error: e.message };
    }
  };
  const working = (what) => PR.toast('<span class="spin"></span>' + what, null, 90000);
  /* 外部工具欄的 AI 的回答 → 這一頁的筆記（本頁筆記，接在最後）。item：{title, body, page, by} */
  PR.addAnswerAsNote = async function (item) {
    const page = item.page || (PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : (PR.blockById[PR.readingBlock && PR.readingBlock()] || {}).page || 0);
    if (!page) { PR.toast(PR.t("找不到要存到哪一頁")); return false; }
    working(PR.t("正在把 {by} 的回答整理成筆記…", { by: PR.esc(item.by || "AI") }));
    const r = await PR.asNote(Object.assign({}, item, { page: 0 }));
    const pn = (S.reader.page_notes || {})[page] || {}, was = pn.body || "";
    const body = (was.trim() ? was.replace(/\s+$/, "") + "\n\n" : "") + r.md;
    PR.commit(Object.assign({ op: "page_note", page, body }, pn.star ? { star: true } : {}));
    afterChange();
    PR.toast(r.ai ? PR.t("已整理成筆記，存在第 {page} 頁", { page }) : PR.t("已存到第 {page} 頁的筆記（AI 沒能整理，先照原樣）", { page }), [
      { label: PR.t("看看"), fn: () => { if (PR.goToPage) PR.goToPage(page); PR.toggleNotesPanel(true, "page"); } },
      { label: PR.t("撤销"), fn: () => { PR.commit(Object.assign({ op: "page_note", page, body: was }, pn.star ? { star: true } : {})); afterChange(); } }], 6000);
    return true;
  };
  /* 提問紀錄「改成筆記」：問題和 AI 的回答合成一張筆記（筆記的寫法），原本的提問收起來（撤銷可以換回來） */
  PR.qaToNote = async function (nid) {
    const n = (S.reader.notes || {})[nid];
    if (!n) return;
    const answer = PR.repliesTo(nid).map((r) => String(r.body || "").trim()).filter(Boolean).join("\n\n");
    working(PR.t("正在把這則提問整理成筆記…"));
    const r = await PR.asNote({ title: n.body, body: answer, page: 0 });
    const now = PR.nowIso();  // 和其他筆記同一種寫法（伺服器照字串比先後）
    const note = Object.assign({}, n, { id: PR.uid("n"), kind: "note", body: r.md, created: now, updated: now });
    delete note.deleted;
    PR.saveNote(note);
    PR.saveNote(Object.assign({}, n, { deleted: true }));
    const redraw = () => { if (PR.renderMargin) PR.renderMargin(); if (PR.applyMarks) PR.applyMarks(); afterChange(); };
    redraw();
    PR.toast(r.ai ? PR.t("已改成筆記") : PR.t("已改成筆記（AI 沒能整理，先照原樣）"), { label: PR.t("撤销"), fn: () => { PR.saveNote(Object.assign({}, note, { deleted: true })); PR.saveNote(Object.assign({}, n, { deleted: false })); redraw(); } }, 5000);
  };
  function afterChange() {
    if (PR.notesPanelOpen && PR.notesPanelOpen() && PR.renderNotesPanel) PR.renderNotesPanel();
  }
  /* item：{title, body, page}。at：選單出現在哪個按鈕旁 */
  PR.noteAddMenu = function (at, item) {
    const page = item.page || (PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : 0);
    const put = async (category) => {
      working(PR.t("正在把回答整理成筆記…"));
      const r = await PR.asNote(item);
      const was = (S.reader.paper_note || {}).body || "";  // 整理完才讀：等的時候可能又改過
      PR.commit({ op: "paper_note", body: PR.noteInsert(was, category, withPage(r.md, page)) });
      afterChange();
      PR.toast(r.ai ? PR.t("已整理成筆記，加到「{c}」", { c: PR.esc(category) }) : PR.t("已加到筆記的「{c}」（AI 沒能整理，先照原樣）", { c: PR.esc(category) }),
        { label: PR.t("撤销"), fn: () => { PR.commit({ op: "paper_note", body: was }); afterChange(); } }, 5000);
    };
    const items = PR.noteCategories((S.reader.paper_note || {}).body).map((c) => ({ label: c, icon: "tag", fn: () => put(c) }));
    items.push({ label: PR.t("新分類…"), icon: "plus", fn: async () => {
      const name = await PR.promptText({ title: PR.t("新分類"), value: "", ok: PR.t("加入"), at });
      if (name && name.trim()) put(name.trim().replace(/^#+\s*/, ""));
    } });
    if (page) {
      items.push("-", { label: PR.t("本頁筆記（第 {page} 頁）", { page }), icon: "notebook", fn: async () => {
        working(PR.t("正在把回答整理成筆記…"));
        const r = await PR.asNote(Object.assign({}, item, { page: 0 }));
        const pn = (S.reader.page_notes || {})[page] || {}, was = pn.body || "";
        const body = (was.trim() ? was.replace(/\s+$/, "") + "\n\n" : "") + r.md;
        PR.commit(Object.assign({ op: "page_note", page, body }, pn.star ? { star: true } : {}));
        afterChange();
        PR.toast(r.ai ? PR.t("已整理成筆記，存在第 {page} 頁", { page }) : PR.t("已存到第 {page} 頁的筆記（AI 沒能整理，先照原樣）", { page }),
          { label: PR.t("撤销"), fn: () => { PR.commit(Object.assign({ op: "page_note", page, body: was }, pn.star ? { star: true } : {})); afterChange(); } }, 5000);
      } });
    }
    PR.menu(at, items);
  };
  /* 把頁邊的一條筆記加進總結：選分類，放一張出處卡（收起來的）；已經放過就只是提示 */
  PR.noteRefMenu = function (at, nid) {
    const n = (S.reader.notes || {})[nid];
    if (!n) return;
    const line = PR.noteRefLine(n);
    const put = (category) => {
      const was = (S.reader.paper_note || {}).body || "";
      if (was.includes("[!ref " + nid + " ") || was.includes("[!ref " + nid + "]")) return PR.toast(PR.t("總結裡已經有這一條了"), null, 2000);
      const body = PR.noteInsert(was, category, line);
      PR.commit({ op: "paper_note", body });
      const ed = PR.notesEditor && PR.notesEditor("paper");
      if (ed) ed.setValue(body);
      afterChange();
      PR.toast(PR.t("已加到總結的「{c}」", { c: PR.esc(category) }), { label: PR.t("撤销"), fn: () => { PR.commit({ op: "paper_note", body: was }); if (ed) ed.setValue(was); afterChange(); } }, 5000);
    };
    const items = PR.noteCategories((S.reader.paper_note || {}).body).map((c) => ({ label: c, icon: "tag", fn: () => put(c) }));
    items.push({ label: PR.t("新分類…"), icon: "plus", fn: async () => {
      const name = await PR.promptText({ title: PR.t("新分類"), value: "", ok: PR.t("加入"), at });
      if (name && name.trim()) put(name.trim().replace(/^#+\s*/, ""));
    } });
    PR.menu(at, items);
  };
})(window.PR);
