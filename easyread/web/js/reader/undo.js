/* 復原／重做（⌘Z、⌘⇧Z）：畫線、筆記、提問、框選、本頁筆記、整篇筆記的新增、修改、刪除都可以退回去。
   在輸入框裡打字時 ⌘Z 是瀏覽器自己的文字復原，這裡不插手。
   做法：每次 PR.commit 之前先記下「反操作」（這條筆記原來的樣子，或刪掉它）；
   連續改同一條筆記的內容（打字時的自動存檔）算同一步，一次退回整段。AI 的回答不在這裡面。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const undo = [], redo = [];
  const MAX = 100;
  const commit = PR.commit;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const keyOf = (op) => (op.op === "note" ? "note:" + op.note.id : op.op === "note_del" ? "note:" + op.id : op.op === "page_note" ? "page:" + op.page : op.op);
  const noteNow = (id) => { const n = ((S.reader || {}).notes || {})[id]; return n && !n.deleted ? n : null; };

  function inverse(op) {
    const R = S.reader || {};
    if (op.op === "note") { const cur = noteNow(op.note.id); return cur ? { op: "note", note: clone(cur) } : { op: "note_del", id: op.note.id }; }
    if (op.op === "note_del") { const cur = noteNow(op.id); return cur ? { op: "note", note: clone(cur) } : null; }
    if (op.op === "page_note") { const cur = (R.page_notes || {})[op.page] || {}; return Object.assign({ op: "page_note", page: op.page, body: cur.body || "" }, cur.star ? { star: true } : {}); }
    if (op.op === "paper_note") return { op: "paper_note", body: (R.paper_note || {}).body || "" };
    return null;
  }
  /* 只是內容在變（打字）：同一條、樣子沒換 */
  function textOnly(op) {
    if (op.op === "paper_note") return true;
    if (op.op === "page_note") return !!op.star === !!(((S.reader || {}).page_notes || {})[op.page] || {}).star;
    if (op.op !== "note") return false;
    const cur = noteNow(op.note.id);
    return !!cur && cur.kind === op.note.kind && cur.color === op.note.color && cur.style === op.note.style;
  }
  let replaying = false;
  PR.commit = function (op) {
    if (!replaying && op && (op.op === "note" || op.op === "note_del" || op.op === "page_note" || op.op === "paper_note")) {
      const inv = inverse(op);
      if (inv) {
        const top = undo[undo.length - 1], now = Date.now(), text = textOnly(op);
        if (top && top.key === keyOf(op) && top.merge && text && now - top.at < 30000) top.at = now;  // 併進上一步
        else {
          undo.push({ key: keyOf(op), inv, at: now, merge: text || (op.op === "note" && !noteNow(op.note.id)) });
          if (undo.length > MAX) undo.shift();
        }
        redo.length = 0;
      }
    }
    return commit.apply(this, arguments);
  };

  function apply(inv) {
    replaying = true;
    try {
      if (inv.op === "note") PR.saveNote(Object.assign({}, inv.note, { deleted: false }));
      else PR.commit(Object.assign({}, inv));
    } finally { replaying = false; }
  }
  function step(from, to, none, done) {
    const e = from.pop();
    if (!e) return PR.toast(none, null, 1200);
    const back = inverse(e.inv);  // 做這一步之前的樣子，給另一個方向用
    PR.closeSticky && PR.closeSticky({ discard: true });
    apply(e.inv);
    if (back) to.push({ key: e.key, inv: back, at: 0, merge: false });
    PR.applyMarks && PR.applyMarks();
    PR.renderMargin && PR.renderMargin();
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel(null);
    PR.toast(done, null, 1100);
  }
  PR.undo = () => step(undo, redo, PR.t("沒有可以復原的"), PR.t("已復原"));
  PR.redo = () => step(redo, undo, PR.t("沒有可以重做的"), PR.t("已重做"));

  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== "z" && k !== "y") return;
    if (e.target.closest && e.target.closest("textarea, input, [contenteditable]")) return;  // 打字時是文字的復原
    e.preventDefault();
    if (k === "y" || e.shiftKey) PR.redo(); else PR.undo();
  });
})(window.PR);
