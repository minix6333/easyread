/* 摘錄到獨立筆記：選了字 → 工具列上的筆記本（或按 E）→ 挑一份筆記（上次用的、開著的、最近改過的排前面）或新建一份。
   加進去的是一塊引文，下面一行出處——是連結：點了回到這份文件的那一頁，PDF 上選的還會把那句的開頭找出來標著。
   - 那份筆記正開著（另一個分頁、並排的那一格）：請它的編輯器自己接在最後，畫面上馬上看得到；
     不走伺服器——不然它下一次自動存檔會把伺服器上剛加的那段蓋掉。
   - 沒開著：請伺服器接在檔案最後（POST /api/notes/<id>/append）。
   也可以把選的字直接拖進並排開著的筆記：拖的時候帶著同一段 Markdown（application/x-foli-excerpt），
   筆記那邊放在哪一塊旁邊就插在哪裡（common/blocks.js 的 drop）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const TYPE = "application/x-foli-excerpt";
  const LAST = "easyread-excerpt-note";
  const docTitle = () => { const m = (S.paper && S.paper.meta) || {}; return m.short_zh || m.title_zh || m.title_en || PR.t("论文"); };
  const pageOf = (sel) => sel.page || (S.layout[sel.anchor] || {}).page || (PR.blockById[sel.anchor] || {}).page || 0;
  const shell = () => (PR.framed && window.parent.easyreadShell) || null;

  /* 選的字 → 一塊 Markdown：引文＋出處 */
  PR.excerptMd = function (sel) {
    const quote = String((sel && sel.quote) || "").replace(/\s+/g, " ").trim().replace(/\$/g, "\\$");
    if (!quote) return "";
    const page = pageOf(sel);
    let find = "";
    if (sel.side === "pdf") {  // PDF 上選的：跳回來時把開頭那幾個字找出來標著。太短的、帶連字號的不帶（行尾斷字接起來的寫法兩邊不一定一樣，免得找不到）
      const head = String(sel.quote || "").split(/\n/)[0].trim().slice(0, 48).replace(/\s+\S*$/, "");
      if (head.length >= 8 && !/[-\u00ad]/.test(head)) find = head;
    }
    const enc = (s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const url = "/read/" + PR.pid + (page ? "#page=" + page + (find ? "&find=" + enc(find) : "") : "");
    return "> " + quote + "\n>\n> —— [" + docTitle().replace(/[\[\]]/g, "") + (page ? PR.t("，第 {page} 頁", { page }) : "") + "](" + url + ")";
  };

  async function addTo(note, md) {
    const w = shell() ? shell().frameOf("/note/" + note.id) : null;
    try {
      const live = !!(w && w.PR && w.PR.note && w.PR.note.append && w.PR.note.append(md));
      if (live) {  // 開著的那一份：順便把這份文件記進它的「關聯的文件」
        const n = w.PR.note.st.note, have = (n && n.papers) || [];
        if (n && !have.includes(PR.pid)) w.PR.note.patch({ papers: have.concat(PR.pid) });
      } else await PR.api("/api/notes/" + note.id + "/append", { method: "POST", body: { md, paper: PR.pid } });
      PR.ls.set(LAST, note.id);
      PR.toast(PR.t("已加到「{t}」", { t: PR.esc(note.title || PR.t("未命名筆記")) }), live ? null : { label: PR.t("打開"), fn: () => PR.navigate("/note/" + note.id) }, 3600);
      if (!live && PR.notesChanged) PR.notesChanged();
    } catch (e) { PR.toast(PR.t("沒加成：{msg}", { msg: PR.esc(e.message) })); }
  }
  async function create(md) {
    try {
      const n = await PR.api("/api/notes", { method: "POST", body: { title: PR.t("{t} 的摘錄", { t: docTitle() }), body: md + "\n", papers: [PR.pid] } });
      PR.ls.set(LAST, n.id);
      if (PR.notesChanged) PR.notesChanged();
      PR.toast(PR.t("已建一份筆記，摘錄放進去了"), { label: PR.t("打開"), fn: () => PR.navigate("/note/" + n.id) }, 5200);
    } catch (e) { PR.toast(PR.t("沒建成：{msg}", { msg: PR.esc(e.message) })); }
  }

  /* 挑要加到哪一份：at 是選單出現的地方（選的字底下） */
  PR.excerptMenu = async function (sel, at) {
    const md = PR.excerptMd(sel);
    if (!md) return;
    let notes = [];
    try { notes = (await PR.api("/api/notes")).items || []; } catch (e) { /* 取不到清單：至少還能建新的 */ }
    const open = new Set(shell() ? shell().tabs().filter((t) => t.kind === "note").map((t) => t.doc) : []);
    const last = PR.ls.get(LAST, "");
    const rank = (n) => (open.has(n.id) ? 2 : 0) + (n.id === last ? 1 : 0);
    notes.sort((a, b) => rank(b) - rank(a) || String(b.updated).localeCompare(String(a.updated)));
    const icon = (n) => (n.icon && PR.hasIcon("l-" + n.icon) ? "l-" + n.icon : PR.hasIcon("notes") ? "notes" : "notebook");
    PR.menu(at, [{ head: PR.t("加到筆記") }, { label: PR.t("新筆記"), icon: "plus", fn: () => create(md) }].concat(
      notes.length ? ["-"] : [],
      notes.slice(0, 8).map((n) => ({ label: n.title || PR.t("未命名筆記"), icon: icon(n), checked: open.has(n.id), fn: () => addTo(n, md) }))));
  };

  /* 拖：選著字開始拖的時候，把摘錄的 Markdown 一起帶上（文字本身瀏覽器會自己帶，拖到問 AI 的輸入框那條路照舊） */
  document.addEventListener("dragstart", (e) => {
    if (PR.store.mode !== "server" || !e.dataTransfer || !PR.readSelection) return;
    const sel = PR.readSelection();
    const md = sel ? PR.excerptMd(sel) : "";
    if (md) { try { e.dataTransfer.setData(TYPE, md); } catch (err) { /* 有些環境不給設 */ } }
  });
})(window.PR);
