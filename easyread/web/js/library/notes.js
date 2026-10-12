/* 文獻庫裡的獨立筆記（資料在 notes.py）：側欄「筆記」那一段、主畫面的筆記卡片（「全部筆記」，或點了某個分類時那個分類裡的筆記）、
   每一份筆記的選單（改名、圖示與顏色、收藏、移到分類、複製一份、刪除）。刪除是進回收站，馬上出一顆「復原」。
   L.notes 是清單（/api/notes 的 items），L.catStyle 是分類的圖示顏色（同一個回應的 folders，跟著文獻庫走）。
   筆記可以拖到側欄的分類上（放進去）；在分類裡按「＋」建的筆記直接放在那個分類。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  L.notes = L.notes || [];
  L.catStyle = L.catStyle || {};
  const ui = { open: false };
  const byId = (id) => L.notes.find((n) => n.id === id);
  const titleOf = (n) => n.title || PR.t("未命名筆記");
  const has = (n) => PR.hasIcon(n);

  let lastKey = "", noteSeq = 0, noteDone = 0;
  L.loadNotes = async function (force) {
    try {
      const seq = ++noteSeq, d = await PR.api("/api/notes");
      if (seq < noteDone) return;  // 比已經拿到的那一份舊：丟掉（不然剛建的筆記會從清單上消失一下）
      noteDone = seq;
      const key = JSON.stringify([d.items, d.folders]);
      L.notes = d.items || [];
      L.catStyle = d.folders || {};
      if (L.tellDocs) L.tellDocs("note", L.notes.map((n) => n.id));  // 外殼的分頁跟著對（library/app.js）
      if (key === lastKey && !force) return;  // 文獻庫每 15 秒輪詢一次：筆記沒變就不重畫（重畫會把正在滑過、正在拖的卡片換掉）
      lastKey = key;
      L.render();
    } catch (e) { /* 取不到就留著上一次的 */ }
  };
  L.catIcon = (name, cls) => PR.tintIcon((L.catStyle[name] || {}).icon, (L.catStyle[name] || {}).color, "folder", cls);
  L.setCatStyle = async function (name, style) {
    L.catStyle[name] = Object.assign({ icon: "", color: "" }, L.catStyle[name], style);
    L.render();
    try { const r = await PR.api("/api/notes-folder", { method: "POST", body: Object.assign({ name }, style) }); L.catStyle = r.folders || {}; } catch (e) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) })); L.loadNotes(true); }
  };

  /* ---------- 改一份筆記的欄位：先改畫面再存 ---------- */
  async function save(id, fields) {
    const n = byId(id);
    if (n) { Object.assign(n, fields); L.render(); }
    try { await PR.api("/api/notes/" + encodeURIComponent(id), { method: "POST", body: fields }); }
    catch (e) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) })); L.loadNotes(true); }  // 沒存成：畫面退回伺服器上的樣子
  }
  L.noteSave = save;
  async function create(extra) {
    try {
      const n = await PR.api("/api/notes", { method: "POST", body: Object.assign({}, extra || {}) });
      L.notes.unshift(Object.assign({ preview: "", chars: 0, cover: "" }, n));
      L.render();
      if (PR.navigate) PR.navigate("/note/" + n.id); else location.href = "/note/" + n.id;
    } catch (err) { PR.toast(PR.t("沒建成：{msg}", { msg: PR.esc(err.message) })); }
  }
  L.newNote = () => create(L.tag ? { folder: L.tag } : null);
  async function duplicate(id) {
    try {
      const n = await PR.api("/api/notes/" + encodeURIComponent(id) + "/duplicate", { method: "POST", body: {} });
      await L.loadNotes();
      PR.toast(PR.t("已複製一份"), { label: PR.t("打開"), fn: () => PR.navigate("/note/" + n.id) }, 5000);
    } catch (e) { PR.toast(PR.t("沒複製成：{msg}", { msg: PR.esc(e.message) })); }
  }
  function undoToast(name, title) {
    PR.toast(PR.t("已把「{t}」移到回收站", { t: PR.esc(title) }), { label: PR.t("復原"), fn: async () => {
      try { await PR.api("/api/trash", { method: "POST", body: { action: "restore", name } }); await L.load(); }
      catch (e) { PR.toast(PR.esc(e.message)); }
    } }, 8000);
  }
  async function remove(id) {
    const n = byId(id);
    if (!n) return;
    const leave = L.fadeOut('[data-note="' + id + '"]');
    try {
      const r = await PR.api("/api/notes/" + encodeURIComponent(id) + "/delete", { method: "POST", body: {} });
      await leave;
      L.notes = L.notes.filter((x) => x.id !== id);
      L.trashCount = (L.trashCount || 0) + 1;
      L.render();
      if (L.docsGone) L.docsGone([id]);  // 它開著的分頁一起關掉
      if (r.trash) undoToast(r.trash, titleOf(n));
    } catch (e) { PR.$$(".leaving").forEach((el) => el.classList.remove("leaving")); PR.toast(PR.t("刪除失敗：{msg}", { msg: PR.esc(e.message) })); }
  }
  /* 筆記頁自己刪掉的（note/panels.js 記在 sessionStorage）：回到文獻庫時補一顆「復原」 */
  function checkTrashed() {
    try {
      const raw = sessionStorage.getItem("easyread-note-trashed");
      if (!raw) return;
      sessionStorage.removeItem("easyread-note-trashed");
      const d = JSON.parse(raw);
      if (d && d.name && Date.now() - d.t < 60000) undoToast(d.name, d.title || PR.t("未命名筆記"));
    } catch (e) { /* 沒有就算了 */ }
  }
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.easyread || e.data.type !== "notes-changed") return;
    L.load().then(checkTrashed).catch(() => {});
  });
  window.addEventListener("pageshow", () => setTimeout(checkTrashed, 300));

  /* ---------- 選單 ---------- */
  function folderItems(n) {
    const cur = n.folder || "";
    return [{ label: PR.t("未分類"), icon: has("inbox") ? "inbox" : "folder", checked: !cur, fn: () => save(n.id, { folder: "" }) }].concat(
      L.cats().length ? ["-"] : [],
      L.cats().map((c) => ({ label: c, icon: (L.catStyle[c] || {}).icon && has("l-" + L.catStyle[c].icon) ? "l-" + L.catStyle[c].icon : "folder", checked: c === cur, fn: () => save(n.id, { folder: c }) })));
  }
  function noteMenu(id, at) {
    const n = byId(id);
    if (!n) return;
    PR.menu(at, [
      { label: PR.t("打開"), icon: has("notes") ? "notes" : "notebook", fn: () => PR.navigate("/note/" + id) },
      { label: PR.t("快速查看"), icon: "eye", fn: () => PR.quickLook && PR.quickLook.open("note", id) },
      "-",
      { label: PR.t("重新命名"), icon: has("rename") ? "rename" : "edit", fn: async () => {
        const t = await PR.promptText({ title: PR.t("重新命名"), value: n.title || "", placeholder: PR.t("未命名筆記"), ok: PR.t("好"), max: 200, at });
        if (t != null && t !== n.title) save(id, { title: t });
      } },
      { label: PR.t("圖示與顏色…"), icon: has("palette") ? "palette" : "accent", fn: () => setTimeout(() => PR.pickIcon(at, { icon: n.icon, color: n.color, onChange: (v) => save(id, v) }), 0) },
      { label: n.star ? PR.t("取消收藏") : PR.t("收藏"), icon: "star", fn: () => save(id, { star: !n.star }) },
      { label: PR.t("移到分類"), icon: has("movefolder") ? "movefolder" : "folder", sub: folderItems(n) },
      { label: PR.t("複製一份"), icon: has("duplicate") ? "duplicate" : "copy", fn: () => duplicate(id) },
      "-",
      { label: PR.t("刪除"), icon: "trash", danger: true, fn: () => remove(id) },
    ]);
  }
  L.noteMenu = noteMenu;

  /* ---------- 側欄「筆記」那一段 ---------- */
  const more = '<span class="more" data-more title="' + PR.t("更多") + '">' + PR.icon("more", "sm") + "</span>";
  function sideRow(n) {
    return '<a class="srow note" href="/note/' + PR.esc(n.id) + '" data-note="' + PR.esc(n.id) + '" draggable="true" title="' + PR.esc(n.preview || "") + '">' + PR.tintIcon(n.icon, n.color, has("notes") ? "notes" : "notebook") +
      '<span class="t">' + PR.esc(titleOf(n)) + "</span>" + (n.star ? '<span class="st">' + PR.icon("star", "sm") + "</span>" : "") + more + "</a>";
  }
  L.sideNotesHtml = function () {
    const notes = L.notes.slice().sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || String(b.updated).localeCompare(String(a.updated)));
    const SHORT = 6, shown = notes.slice(0, ui.open ? 40 : SHORT);
    return "<h3>" + PR.t("筆記") + '<button class="h-add" data-newnote title="' + PR.t("新筆記") + '">' + PR.icon("plus", "sm") + '</button></h3><div class="sgroup" data-notes-zone>' +
      '<div class="srow' + (L.view === "notes" && !L.tag ? " on" : "") + '" data-view="notes">' + PR.icon(has("notes") ? "notes" : "notebook", "sm") + '<span class="t">' + PR.t("全部筆記") + '</span><span class="n">' + L.notes.length + "</span></div>" +
      shown.map(sideRow).join("") +
      (notes.length > SHORT ? '<button class="srow toggle-more" data-notes-more>' + (ui.open ? PR.t("收起") : PR.t("展开更多（{n}）", { n: Math.min(notes.length, 40) - SHORT })) + "</button>" : "") + "</div>";
  };

  /* ---------- 主畫面的筆記卡片 ---------- */
  function cardHtml(n) {
    const cover = n.cover ? '<div class="nc-cover" style="background-image:url(&quot;/n/' + PR.esc(n.id) + "/" + PR.esc(n.cover) + '&quot;)"></div>' : "";
    return '<a class="ncard' + (n.cover ? " has-cover" : "") + '" href="/note/' + PR.esc(n.id) + '" data-note="' + PR.esc(n.id) + '" draggable="true"' + (n.color ? ' data-c="' + PR.esc(n.color) + '"' : "") + ">" +
      '<div class="nc-page"><div class="nc-t">' + PR.tintIcon(n.icon, n.color, has("notes") ? "notes" : "notebook", "nc-ic") + "<span>" + PR.esc(titleOf(n)) + "</span></div>" + cover +
      (n.preview ? '<div class="nc-pv">' + PR.esc(n.preview) + "</div>" : cover ? "" : '<div class="nc-pv empty">' + PR.t("空白的筆記") + "</div>") + "</div>" +
      '<div class="nc-foot">' + (n.star ? '<span class="st">' + PR.icon("star", "sm") + "</span>" : "") + '<span class="nc-time" title="' + PR.esc(n.updated || "") + '">' + PR.esc(PR.relTime(n.updated)) + "</span>" +
      (n.folder && L.tag !== n.folder ? '<span class="chip cat">' + L.catIcon(n.folder) + PR.esc(n.folder) + "</span>" : "") + '<span class="grow"></span>' + more + "</div></a>";
  }
  /* 現在這個畫面該列出哪些筆記（照搜尋字、排序）：「全部筆記」是全部；點了分類是那個分類裡的；其他畫面不列 */
  L.notesShown = function () {
    if (L.view !== "notes" && !L.tag) return [];
    const q = L.q.trim().toLowerCase();
    let list = L.notes.filter((n) => (L.tag ? n.folder === L.tag : true));
    if (q) list = list.filter((n) => [n.title, n.preview, n.folder].join(" ").toLowerCase().includes(q));
    const key = L.sort === "title" ? (n) => titleOf(n) : L.sort === "added" || L.sort === "year" ? (n) => n.created : (n) => n.updated;
    list.sort((a, b) => (L.sort === "title" ? String(key(a)).localeCompare(String(key(b)), "zh") : (b.star ? 1 : 0) - (a.star ? 1 : 0) || String(key(b)).localeCompare(String(key(a)))));
    return list;
  };
  L.noteCardsHtml = function (list, withNew) {
    return (withNew ? '<button class="ncard new" data-newnote><span class="nc-plus">' + PR.icon("plus") + "</span><span>" + PR.t("新筆記") + "</span></button>" : "") + list.map(cardHtml).join("");
  };

  /* ---------- 事件 ---------- */
  document.addEventListener("click", (e) => {
    if (e.target.closest("#side [data-notes-more]")) { ui.open = !ui.open; return PR.renderSide(); }
    const add = e.target.closest("[data-newnote]");
    if (add) { e.preventDefault(); return L.newNote(); }
    const m = e.target.closest("[data-note] [data-more]");
    if (m) { e.preventDefault(); e.stopPropagation(); return noteMenu(m.closest("[data-note]").dataset.note, m); }
  }, true);
  document.addEventListener("contextmenu", (e) => {
    const row = e.target.closest && e.target.closest("[data-note]");
    if (!row || !row.closest("#side, #list")) return;
    e.preventDefault();
    noteMenu(row.dataset.note, { x: e.clientX, y: e.clientY });
  });
  /* 拖筆記到側欄的分類上：放進那個分類（拖到「全部筆記」＝拿出分類） */
  let dragNote = null;
  document.addEventListener("dragstart", (e) => {
    const r = e.target.closest && e.target.closest("[data-note]");
    if (!r) return;
    dragNote = r.dataset.note;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", location.origin + "/note/" + dragNote); } catch (err) { /* 有些環境不給設 */ }
    PR.$("#side").classList.add("dragging");
  });
  document.addEventListener("dragend", () => { if (!dragNote) return; dragNote = null; PR.$("#side").classList.remove("dragging"); PR.$$(".srow.drop", PR.$("#side")).forEach((x) => x.classList.remove("drop")); });
  const target = (e) => dragNote && e.target.closest && e.target.closest('#side .srow[data-cat], #side .srow[data-view="notes"]');
  document.addEventListener("dragover", (e) => {
    if (!dragNote) return;
    const row = target(e);
    PR.$$(".srow.drop", PR.$("#side")).forEach((x) => x !== row && x.classList.remove("drop"));
    if (!row) return;
    e.preventDefault(); row.classList.add("drop");
  });
  document.addEventListener("drop", (e) => {
    const row = target(e), id = dragNote;
    if (!row || !id) return;
    e.preventDefault(); e.stopPropagation();
    row.classList.remove("drop");
    const to = row.dataset.cat || "", n = byId(id);
    if (!n || (n.folder || "") === to) return;
    save(id, { folder: to });
    PR.toast(to ? PR.t("已放进“{name}”", { name: PR.esc(to) }) : PR.t("已移出分類"));
  }, true);
})(window.PR);
