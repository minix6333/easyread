/* 筆記頁的面板（照 Craft）：左邊的目錄、右邊的「插入／格式／樣式／資訊」、右上角「⋯」的文件操作。
   資料和存檔在 note/app.js（PR.note）；區塊的動作都是叫編輯器（PR.note.ed 的 convert／inline／indent／insertBlock）。
   - 目錄：標題一行一個，點了捲過去；捲動時亮出現在讀到哪一節。
   - 插入：一格一格的區塊（和「/」選單同一份清單），點了加在游標那一塊下面。
   - 格式：把現在這一塊（或選起來的幾塊）換成別種、選起來的字加粗體之類、清單縮排。現在是哪一種會亮著。
   - 樣式：這份筆記的圖示和顏色、字型、寬頁。
   - 資訊：建立／更新時間、放在哪個分類、字數統計、關聯的論文、文件操作（收藏、複製一份、匯出、刪除）。
   面板開著哪一頁、目錄開不開記在本機（easyread-note-ui）。面板上的鈕按下去不搶焦點（mousedown 擋掉），正在打字的那一塊才不會被收起來。 */
(function (PR) {
  "use strict";
  const N = PR.note, $ = PR.$;
  if (!N) return;
  /* 兩欄開不開：視窗夠寬時照上次的（記在本機）；視窗窄時兩欄是蓋在紙上面的，一開始都收著、一次只開一欄、點紙就收起來，而且不改寬視窗記的狀態 */
  const narrow = matchMedia("(max-width: 1020px)");
  const saved = Object.assign({ outline: false, insp: "", last: "format" }, PR.ls.get("easyread-note-ui", {}) || {});
  if (!["", "insert", "format", "style", "info"].includes(saved.insp)) saved.insp = "";
  const ui = narrow.matches ? { outline: false, insp: "", last: saved.last } : Object.assign({}, saved);
  const saveUi = () => { if (narrow.matches) { saved.last = ui.last || saved.last; } else Object.assign(saved, ui); PR.ls.set("easyread-note-ui", saved); };
  const note = () => N.st.note;
  const has = (n) => PR.hasIcon(n);
  const ic = (n, alt) => PR.icon(has(n) ? n : alt || n, "sm");
  let cats = [], catStyle = {};  // 有哪些分類（文獻庫側欄設定的＋別的筆記用到的）、它們的圖示顏色（存在文獻庫，/api/notes 的 folders）
  const others = { papers: null };  // 關聯的論文叫什麼名字

  $("#outlineBtn").innerHTML = ic("outline", "list");
  $("#inspBtn").innerHTML = PR.icon("panelright", "sm");

  /* ---------- 目錄 ---------- */
  function paintOutline() {
    const el = $("#noteOutline");
    document.body.classList.toggle("ol-open", !!ui.outline);
    $("#outlineBtn").classList.toggle("on", !!ui.outline);
    if (!ui.outline || !N.ed) return;
    const items = N.ed.outline();
    const key = items.map((h) => h.id + h.level + h.text).join("|");
    if (el.dataset.key === key && el.firstChild) return markCurrent();
    el.dataset.key = key;
    el.innerHTML = '<div class="no-head">' + PR.t("目錄") + "</div>" + (items.length
      ? '<nav class="no-list">' + items.map((h) => '<button type="button" class="no-i l' + h.level + '" data-id="' + h.id + '" title="' + PR.esc(h.text) + '">' + PR.esc(h.text || PR.t("（沒有字的標題）")) + "</button>").join("") + "</nav>"
      : '<p class="hint no-empty">' + PR.t("加了標題就會列在這裡") + "</p>");
    markCurrent();
  }
  function markCurrent() {
    if (!ui.outline || !N.ed) return;
    const rows = PR.$$("#noteOutline .no-i");
    let cur = null;
    for (const r of rows) { const b = N.ed.elOf(r.dataset.id); if (b && b.getBoundingClientRect().top <= 130) cur = r; }
    rows.forEach((r) => r.classList.toggle("on", r === cur));
  }
  $("#noteOutline").addEventListener("click", (e) => { const b = e.target.closest(".no-i"); if (b && N.ed) N.ed.reveal(b.dataset.id); });
  $("#outlineBtn").addEventListener("click", () => {
    ui.outline = !ui.outline;
    if (ui.outline && narrow.matches && ui.insp) { ui.insp = ""; $("#noteInsp").innerHTML = ""; paintInsp(); }
    saveUi(); $("#noteOutline").dataset.key = ""; paintOutline();
  });
  let scrollQueued = false;
  addEventListener("scroll", () => { if (scrollQueued) return; scrollQueued = true; requestAnimationFrame(() => { scrollQueued = false; markCurrent(); }); }, { passive: true });

  /* ---------- 右邊的面板 ---------- */
  const TABS = () => [["insert", PR.t("插入")], ["format", PR.t("格式")], ["style", PR.t("樣式")], ["info", PR.t("資訊")]];
  const sec = (label) => '<div class="ni-sec">' + PR.esc(label) + "</div>";
  function insertHtml() {
    const groups = PR.blockGroups();
    let last = "", h = "";
    for (const it of PR.blockKinds()) {
      if (it.g !== last) { h += (last ? "</div>" : "") + sec(groups[it.g] || "") + '<div class="ni-tiles">'; last = it.g; }
      h += '<button type="button" class="ni-tile" data-ins="' + it.k + '"><span class="ni-tic">' + ic(it.icon[0], it.icon[1]) + "</span><span>" + PR.esc(it.label) + "</span></button>";
    }
    return h + "</div>";
  }
  function formatHtml() {
    const cur = N.ed ? N.ed.current() : { kind: "", count: 0 };
    const none = cur.count ? "" : " disabled";
    const t = (k, label) => '<button type="button" class="ni-tbtn' + (cur.kind === k ? " on" : "") + '" data-fmt="' + k + '"' + none + ">" + PR.esc(label) + "</button>";
    const b = (attr, k, icon, alt, title, on) => '<button type="button" class="ni-ibtn' + (on ? " on" : "") + '" ' + attr + '="' + k + '" title="' + PR.esc(title) + '"' + none + ">" + ic(icon, alt) + "</button>";
    const edit = cur.editing ? "" : " disabled";
    const inl = (k, icon, title) => '<button type="button" class="ni-ibtn" data-inl="' + PR.esc(k) + '" title="' + PR.esc(PR.kbd(title)) + '"' + edit + ">" + PR.icon(icon, "sm") + "</button>";
    return sec(PR.t("主標題")) + '<div class="ni-row3">' + t("h1", PR.t("大標題")) + t("h2", PR.t("副標題")) + t("h3", PR.t("標題")) + "</div>" +
      sec(PR.t("內容")) + '<div class="ni-row3">' + t("p", PR.t("內文")) + t("quote", PR.t("引用")) + t("code", PR.t("程式碼")) + "</div>" +
      sec(PR.t("文字")) + '<div class="ni-icons">' + inl("**", "bold", PR.t("粗體（⌘B）")) + inl("*", "italic", PR.t("斜體（⌘I）")) + inl("++", "underline", PR.t("底線（⌘U）")) + inl("~~", "strike", PR.t("刪除線（⌘⇧-）")) +
      inl("\x60", "code", PR.t("程式碼（⌘⇧C）")) + inl("==", "marker", PR.t("螢光（⌘⇧B）")) + inl("$", "sigma", PR.t("公式（⌘⇧E）")) + inl("link", "link", PR.t("連結（⌘K）")) + "</div>" +
      sec(PR.t("清單")) + '<div class="ni-icons">' + b("data-fmt", "todo", "todo", "check", PR.t("待辦"), cur.kind === "todo") + b("data-fmt", "toggle", "caret", "chevron", PR.t("收合"), cur.kind === "toggle") +
      b("data-fmt", "bullet", "bullets", "log", PR.t("項目清單"), cur.kind === "bullet") + b("data-fmt", "number", "numbers", "list", PR.t("編號清單"), cur.kind === "number") + '<i class="ni-gap"></i>' +
      '<button type="button" class="ni-ibtn" data-ind="-1" title="' + PR.kbd(PR.t("減少縮排（⇧Tab）")) + '"' + (cur.list ? "" : " disabled") + ">" + ic("outdent", "back") + "</button>" +
      '<button type="button" class="ni-ibtn" data-ind="1" title="' + PR.t("增加縮排（Tab）") + '"' + (cur.list ? "" : " disabled") + ">" + ic("indent", "next") + "</button></div>" +
      sec(PR.t("裝飾")) + '<div class="ni-row3 deco">' + ["note", "tip", "warn"].map((k) => '<button type="button" class="ni-tbtn k-' + k + (cur.kind === k ? " on" : "") + '" data-fmt="' + k + '"' + none + ">" +
        PR.esc({ note: PR.t("說明框"), tip: PR.t("訣竅框"), warn: PR.t("警示框") }[k]) + "</button>").join("") + "</div>";
  }
  const FONTS = () => [["", "Aa", PR.t("系統")], ["serif", "Ss", PR.t("襯線")], ["mono", "00", PR.t("等寬")], ["round", "Rr", PR.t("圓體")]];
  function styleHtml() {
    const n = note();
    return sec(PR.t("圖示")) + '<div class="ni-iconrow"><button type="button" class="ni-bigicon" data-style="icon" title="' + PR.t("圖示與顏色") + '">' + PR.tintIcon(n.icon, n.color, "notes") + "</button>" +
      '<div class="ni-dots">' + PR.TINTS.map(([c, name]) => '<button type="button" data-tint="' + c + '" class="' + (c ? "" : "none") + ((n.color || "") === c ? " on" : "") + '" title="' + PR.esc(name) + '"' + (c ? ' data-c="' + c + '"' : "") + "></button>").join("") + "</div></div>" +
      sec(PR.t("字型")) + '<div class="ni-fonts">' + FONTS().map(([k, sample, label]) => '<button type="button" data-font="' + k + '" class="f-' + (k || "sys") + ((n.font || "") === k ? " on" : "") + '"><b>' + sample + "</b><span>" + PR.esc(label) + "</span></button>").join("") + "</div>" +
      sec(PR.t("版面")) + '<label class="ni-switch"><span>' + PR.t("寬頁") + '</span><input type="checkbox" data-style="wide"' + (n.wide ? " checked" : "") + '><i></i></label>';
  }
  const fullTime = (iso) => { try { return new Date(iso).toLocaleString(PR.lang === "en" ? "en" : "zh-TW", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return iso || ""; } };
  function folderLabel() { const n = note(); return n.folder ? PR.tintIcon((catStyle[n.folder] || {}).icon, (catStyle[n.folder] || {}).color, "folder") + "<span>" + PR.esc(n.folder) + "</span>" : PR.icon("folder", "sm") + "<span>" + PR.t("未分類") + "</span>"; }
  function infoHtml() {
    const n = note(), s = N.ed ? N.ed.stats() : { words: 0, blocks: 0, todo: 0, done: 0, headings: 0 };
    const kv = (icon, k, v, title) => '<div class="ni-kv"' + (title ? ' title="' + PR.esc(title) + '"' : "") + ">" + ic(icon[0], icon[1]) + "<span>" + PR.esc(k) + "</span><b>" + v + "</b></div>";
    const act = (a, icon, alt, label, cls) => '<button type="button" class="ni-act' + (cls ? " " + cls : "") + '" data-act="' + a + '">' + ic(icon, alt) + "<span>" + PR.esc(label) + "</span></button>";
    const papers = (n.papers || []).map((pid) => '<a class="ni-paper" href="/read/' + PR.esc(pid) + '">' + PR.icon("pdf", "sm") + "<span>" + PR.esc((others.papers || {})[pid] || pid) + "</span></a>").join("");
    return sec(PR.t("屬性")) + kv(["calendar", "clock"], PR.t("建立時間"), PR.esc(PR.relTime(n.created)), fullTime(n.created)) + kv(["history", "clock"], PR.t("已更新"), PR.esc(PR.relTime(n.updated)), fullTime(n.updated)) +
      '<button type="button" class="ni-kv as-btn" data-act="folder">' + ic("folderopen", "folder") + "<span>" + PR.t("分類") + '</span><b class="ni-folder">' + folderLabel() + "</b></button>" +
      sec(PR.t("統計")) + '<div class="ni-stats"><div><b>' + s.words + "</b><span>" + PR.t("字") + "</span></div><div><b>" + s.blocks + "</b><span>" + PR.t("區塊") + "</span></div><div><b>" +
      (s.todo ? s.done + "/" + s.todo : "0") + "</b><span>" + PR.t("待辦") + "</span></div><div><b>" + Math.max(1, Math.round(s.words / 350)) + "</b><span>" + PR.t("分鐘讀完") + "</span></div></div>" +
      (papers ? sec(PR.t("關聯的文件")) + '<div class="ni-papers">' + papers + "</div>" : "") +
      sec(PR.t("操作")) + '<div class="ni-acts">' + act("star", "star", "star", n.star ? PR.t("取消收藏") : PR.t("收藏")) + act("duplicate", "duplicate", "copy", PR.t("複製一份")) +
      act("export", "exportfile", "download", PR.t("匯出 Markdown")) + act("copymd", "copy", "copy", PR.t("複製成 Markdown")) + act("delete", "trash", "trash", PR.t("刪除"), "danger") + "</div>";
  }
  function paintInsp() {
    const el = $("#noteInsp");
    document.body.classList.toggle("in-open", !!ui.insp);
    $("#inspBtn").classList.toggle("on", !!ui.insp);
    if (!ui.insp) { el.innerHTML = ""; return; }
    if (!N.ed) return;
    const keep = el.querySelector(".ni-body") ? el.querySelector(".ni-body").scrollTop : 0;
    const tabs = el.querySelector(".ni-tabs");
    const body = ({ insert: insertHtml, format: formatHtml, style: styleHtml, info: infoHtml })[ui.insp]();
    if (tabs) {  // 分頁列留著（滑塊才滑得過去），只換下面的內容
      tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.niTab === ui.insp));
      const bd = el.querySelector(".ni-body"); bd.dataset.tab = ui.insp; bd.innerHTML = body; bd.scrollTop = keep;
      return;
    }
    el.innerHTML = '<div class="ni-top"><div class="seg ni-tabs" id="niTabs">' + TABS().map(([k, l]) => '<button type="button" data-ni-tab="' + k + '" class="' + (ui.insp === k ? "on" : "") + '">' + l + "</button>").join("") +
      '</div></div><div class="ni-body" data-tab="' + ui.insp + '">' + body + "</div>";
  }
  function setInsp(tab) {
    const was = ui.insp;
    ui.insp = tab;
    if (tab && narrow.matches && ui.outline) { ui.outline = false; paintOutline(); }
    saveUi();
    if (!!was !== !!tab || !tab) $("#noteInsp").innerHTML = "";
    paintInsp();
  }
  narrow.addEventListener("change", () => {  // 視窗拉過寬窄的分界：窄了就都收起來，寬了回到上次的樣子
    Object.assign(ui, narrow.matches ? { outline: false, insp: "" } : { outline: saved.outline, insp: saved.insp });
    $("#noteInsp").innerHTML = ""; $("#noteOutline").dataset.key = "";
    paintOutline(); paintInsp();
  });
  $("#noteMain").addEventListener("mousedown", () => {
    if (!narrow.matches || (!ui.outline && !ui.insp)) return;
    ui.outline = false; ui.insp = "";
    $("#noteInsp").innerHTML = "";
    paintOutline(); paintInsp();
  });
  $("#inspBtn").addEventListener("click", () => setInsp(ui.insp ? "" : ui.last || "format"));
  const insp = $("#noteInsp");
  insp.addEventListener("mousedown", (e) => { if (!e.target.closest("input, a")) e.preventDefault(); });
  insp.addEventListener("click", (e) => {
    const b = e.target.closest("button, a, input");
    if (!b || !N.ed) return;
    if (b.dataset.niTab) { ui.last = b.dataset.niTab; ui.insp = b.dataset.niTab; saveUi(); return paintInsp(); }
    if (b.dataset.ins) return N.ed.insertBlock(b.dataset.ins);
    if (b.dataset.fmt) return N.ed.convert(N.ed.current().kind === b.dataset.fmt ? "p" : b.dataset.fmt);  // 已經是這一種：再按一次變回內文
    if (b.dataset.inl) return void N.ed.inline(b.dataset.inl);
    if (b.dataset.ind) return N.ed.indent(+b.dataset.ind);
    if (b.dataset.tint !== undefined) { N.patch({ color: b.dataset.tint }); return paintInsp(); }
    if (b.dataset.font !== undefined) { N.patch({ font: b.dataset.font }); return paintInsp(); }
    if (b.dataset.style === "icon") return PR.pickIcon(b, { icon: note().icon, color: note().color, onChange: (v) => { N.patch(v); paintInsp(); } });
    if (b.dataset.style === "wide") { N.patch({ wide: b.checked }); return; }
    if (b.dataset.act) return act(b.dataset.act, b);
  });

  /* 標題下面那一行：放在哪個分類、關聯到哪幾份文件（都沒有就整行不出現） */
  function paintMeta() {
    const n = note(), cs = catStyle[n.folder] || {};
    $("#noteMeta").innerHTML = (n.folder ? '<button type="button" class="note-chip" data-act="folder">' + PR.tintIcon(cs.icon, cs.color, "folder") + "<span>" + PR.esc(n.folder) + "</span></button>" : "") +
      (n.papers || []).map((pid) => '<a class="note-chip" href="/read/' + PR.esc(pid) + '">' + PR.icon("pdf", "sm") + "<span>" + PR.esc((others.papers || {})[pid] || PR.t("關聯的文件")) + "</span></a>").join("");
  }
  $("#noteMeta").addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) act(b.dataset.act, b); });

  /* ---------- 文件操作（面板的「操作」和右上角「⋯」共用） ---------- */
  const markdown = () => "# " + (note().title || PR.t("未命名筆記")) + "\n\n" + N.ed.getValue() + "\n";
  function folderMenu(at) {
    const cur = note().folder || "";
    const items = cats.map((c) => ({ label: c, icon: (catStyle[c] || {}).icon && has("l-" + catStyle[c].icon) ? "l-" + catStyle[c].icon : "folder", checked: c === cur, fn: () => { N.patch({ folder: c }); paintInsp(); } }));
    PR.menu(at, [{ label: PR.t("未分類"), icon: has("inbox") ? "inbox" : "folder", checked: !cur, fn: () => { N.patch({ folder: "" }); paintInsp(); } }].concat(items.length ? ["-"] : [], items, ["-",
      { label: PR.t("新分類…"), icon: has("folderplus") ? "folderplus" : "plus", fn: async () => {
        const name = await PR.promptText({ title: PR.t("新分類"), placeholder: PR.t("分類的名字"), ok: PR.t("建立"), max: 30, at });
        if (!name) return;
        if (!cats.includes(name)) cats.push(name);
        N.patch({ folder: name.slice(0, 30) }); paintInsp();
      } }]));
  }
  async function act(a, at) {
    const n = note();
    if (a === "star") { N.patch({ star: !n.star }); return paintInsp(); }
    if (a === "folder") return folderMenu(at);
    if (a === "rename") { const t = $("#noteTitle"); t.focus(); t.select(); return; }
    if (a === "icon") return PR.pickIcon($("#noteIcon"), { icon: n.icon, color: n.color, onChange: (v) => { N.patch(v); paintInsp(); } });
    if (a === "wide") { N.patch({ wide: !n.wide }); return paintInsp(); }
    if (a === "copymd") return navigator.clipboard.writeText(markdown()).then(() => PR.toast(PR.t("已複製"), null, 1200));
    if (a === "export") {
      const link = PR.el("a", { href: URL.createObjectURL(new Blob([markdown()], { type: "text/markdown;charset=utf-8" })), download: (n.title || PR.t("未命名筆記")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) + ".md" });
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      return;
    }
    if (a === "print") return window.print();
    if (a === "duplicate") {
      N.flushNow();
      try {
        const copy = await PR.api(N.url + "/duplicate", { method: "POST", body: {} });
        if (PR.notesChanged) PR.notesChanged();
        PR.navigate("/note/" + copy.id);
      } catch (e) { PR.toast(PR.t("沒複製成：{msg}", { msg: PR.esc(e.message) })); }
      return;
    }
    if (a === "delete") {  // 進回收站，不用再問一次（文獻庫那邊會出「復原」，回收站裡也拿得回來）
      N.flushNow();
      try {
        const r = await PR.api(N.url + "/delete", { method: "POST", body: {} });
        try { sessionStorage.setItem("easyread-note-trashed", JSON.stringify({ name: r.trash, title: n.title || PR.t("未命名筆記"), t: Date.now() })); } catch (e) { /* 沒有就沒有「復原」的提示，回收站裡還是拿得回來 */ }
        window.removeEventListener("pagehide", N.flushNow);  // 已經刪了，別在離開時又存一次（會存不進去、報錯）
        if (PR.notesChanged) PR.notesChanged(true); else location.href = "/library";
      } catch (e) { PR.toast(PR.t("刪除失敗：{msg}", { msg: PR.esc(e.message) })); }
    }
  }
  $("#noteMore").addEventListener("click", (e) => {
    const n = note(), at = e.currentTarget;
    if (!n) return;
    PR.menu(at, [
      { label: PR.t("重新命名"), icon: has("rename") ? "rename" : "edit", fn: () => act("rename") },
      { label: PR.t("圖示與顏色…"), icon: has("palette") ? "palette" : "accent", fn: () => act("icon") },
      { label: n.star ? PR.t("取消收藏") : PR.t("收藏"), icon: "star", fn: () => act("star") },
      { label: PR.t("移到分類"), icon: has("movefolder") ? "movefolder" : "folder", fn: () => setTimeout(() => folderMenu(at), 0) },
      "-",
      PR.noteFind ? { label: PR.t("在這份筆記裡找"), icon: "search", kbd: "⌘F", fn: () => setTimeout(() => PR.noteFind(), 0) } : null,
      { label: PR.t("寬頁"), icon: has("wide") ? "wide" : "panel", checked: !!n.wide, fn: () => act("wide") },
      { label: PR.t("目錄"), icon: has("outline") ? "outline" : "list", checked: !!ui.outline, fn: () => $("#outlineBtn").click() },
      "-",
      { label: PR.t("複製一份"), icon: has("duplicate") ? "duplicate" : "copy", fn: () => act("duplicate") },
      { label: PR.t("複製成 Markdown"), icon: "copy", fn: () => act("copymd") },
      { label: PR.t("匯出 Markdown"), icon: has("exportfile") ? "exportfile" : "download", fn: () => act("export") },
      "-",
      { label: PR.t("刪除"), icon: "trash", danger: true, fn: () => act("delete") },
    ]);
  });

  /* ---------- 接上編輯器 ---------- */
  N.ready.then(async (ok) => {
    if (!ok) return;
    paintOutline();
    paintInsp();
    paintMeta();
    let raf = 0;
    const soon = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; paintOutline(); if (ui.insp === "format" || ui.insp === "info") paintInsp(); }); };
    N.ed.on("state", soon);
    N.ed.on("change", soon);
    N.on("note", () => { paintMeta(); if (ui.insp === "style" || ui.insp === "info") paintInsp(); });
    N.on("saved", () => { if (ui.insp === "info") paintInsp(); });
    // 有哪些分類：文獻庫側欄記的那些，加上別的筆記已經用到的；關聯的論文叫什麼名字
    try {
      const [p, list] = await Promise.all([PR.loadPrefs().catch(() => ({})), PR.api("/api/notes").catch(() => ({ items: [], folders: {} }))]);
      const lib = (p && p.library) || {};
      catStyle = list.folders || {};
      cats = Array.from(new Set((lib.cats || []).concat((list.items || []).map((x) => x.folder).filter(Boolean), note().folder || []))).filter(Boolean);
      if ((note().papers || []).length) {
        const d = await PR.api("/api/library").catch(() => ({ items: [] }));
        others.papers = {};
        (d.items || []).forEach((it) => { others.papers[it.id] = PR.titles ? PR.titles(it).main : it.title_zh || it.title_en || it.id; });
      }
      paintMeta();
      if (ui.insp === "info") paintInsp();
    } catch (e) { /* 拿不到就只有「未分類」和「新分類」 */ }
  });
})(window.PR);
