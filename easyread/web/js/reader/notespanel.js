/* 右侧笔记面板，三個分頁：
   - 本頁：跟著 PDF 現在這一頁走。上面是這一頁的筆記（上課邊聽邊打，自動存），下面是這一頁上的畫線、筆記、提問。
     正在打字時 PDF 翻到別頁不會把輸入框換掉，只給一顆「PDF 在第 N 頁」讓你自己切。
   - 全部：整份文件的標記按頁排好，可以搜尋、按種類和顏色篩，點一張就翻到那裡。
   - 總結：整篇的筆記（論文筆記），可以套範本、讓 AI 起草或點評。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let tab = PR.ls.get("easyread-np-tab", "page");
  if (!["page", "notes", "paper"].includes(tab)) tab = "page";
  let filter = "all", color = "", query = "";
  let editing = null;
  let pnEdit = false;   // 本頁筆記正在編輯（平常顯示排好的樣子，點一下才變成輸入框；空的直接是輸入框）
  let sumEdit = false;  // 整篇筆記同上
  let panelPage = 1, detached = false;
  const panel = () => PR.$("#notespanel");
  const pdf = () => !!(PR.pdfMain && PR.pdfMain());
  const pageCount = () => ((S.paper.meta || {}).pages || []).length;
  const curPage = () => (pdf() && PR.pdfPage ? PR.pdfPage() : (PR.blockById[PR.readingBlock()] || {}).page || 1);
  const canAsk = () => !!(PR.canChat && PR.canChat() && PR.feature("chat"));

  PR.notesPanelOpen = () => PR.side === "notes";
  PR.toggleNotesPanel = function (force, which) {
    const open = force != null ? force : PR.side !== "notes";
    if (which) { tab = which; PR.ls.set("easyread-np-tab", tab); }
    PR.openSide(open ? "notes" : null);
    if (open) { detached = false; PR.renderNotesPanel(null); }
    else { flushPageNote(); editing = null; }
  };

  /* 直接開始寫這一頁的筆記（快捷鍵 N、沒選字時） */
  PR.focusPageNote = function () {
    pnEdit = true;
    PR.toggleNotesPanel(true, "page");
    setTimeout(() => { const ta = PR.$("#notespanel .np-pnote"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 60);
  };

  function sectionOf(id) {
    let cur = null;
    for (const b of S.paper.blocks || []) {
      if (b.type === "heading" || b.type === "references") cur = b;
      if (b.id === id) break;
    }
    return cur ? (cur.num ? cur.num + " " : "") + PR.plain(PR.textFor(cur.id) || cur.zh) : PR.t("论文开头");
  }
  PR.sectionOf = sectionOf;

  /* 錨點：段落 id；畫在 PDF 上、沒對到段落的筆記用 "page:N" */
  const anchorOfNote = (n) => (n.anchor && PR.blockById[n.anchor] ? n.anchor : n.side === "pdf" && n.page ? "page:" + n.page : "head");
  const isPage = (a) => String(a).startsWith("page:");
  const boxY = (loc) => ((loc.boxes && loc.boxes.length ? loc.boxes[0] : loc.box) || [0, 0])[1];
  const pageOfAnchor = (a) => (isPage(a) ? +String(a).slice(5) : (S.layout[a] || {}).page || (PR.blockById[a] || {}).page || 0);
  const pageOfNote = (n) => (n.side === "pdf" && n.page) || pageOfAnchor(n.anchor);
  const yOfNote = (n) => (n.side === "pdf" && n.region ? n.region[1] : n.side === "pdf" && n.rects && n.rects[0] ? n.rects[0][1] : S.layout[n.anchor] ? boxY(S.layout[n.anchor]) : 0);
  const starred = (p) => !!((S.reader.page_notes || {})[p] || {}).star;
  const pageNote = (p) => (((S.reader.page_notes || {})[p] || {}).body || "").trim();

  /* 整份文件的標記，按頁、按頁上的位置排；AI 對筆記的回答嵌在筆記卡片裡，不另外算一條 */
  function allItems() {
    const notes = S.reader.notes || {};
    const out = [];
    // 排序鍵：頁上的位置；拖過順序的用記下來的 ui.order（和位置同一個尺度，0–1），插在鄰居中間
    for (const n of PR.myNotes()) out.push({ src: "mine", anchor: anchorOfNote(n), page: pageOfNote(n), y: yOfNote(n), key: n.ui && n.ui.order != null ? n.ui.order : yOfNote(n), t: n.created || "", data: n });
    for (const e of S.discussion.entries || []) {
      if (e.reply_to && notes[e.reply_to] && !notes[e.reply_to].deleted) continue;
      const a = PR.anchorOfEntry(e);
      const y = S.layout[a] ? boxY(S.layout[a]) : 0;
      out.push({ src: "agent", anchor: a, page: pageOfAnchor(a), y, key: y, t: e.at || "", data: e });
    }
    const ord = (it) => (it.anchor === "head" ? -1 : PR.order[it.anchor] ?? 1e9);
    return out.sort((a, b) => a.page - b.page || (a.key - b.key) || ord(a) - ord(b) || (a.t < b.t ? -1 : 1));
  }
  PR.notesPanelItems = allItems;
  /* 拖排順序：把 id 放到 target 的前面／後面，新的排序鍵取兩個鄰居的中間（純函式，給測試） */
  PR.reorderKey = function (items, id, targetId, after) {
    const list = items.filter((it) => it.src === "mine" && it.data.id !== id);
    const i = list.findIndex((it) => it.data.id === targetId);
    if (i < 0) return null;
    const prev = after ? list[i] : list[i - 1], next = after ? list[i + 1] : list[i];
    const samePage = (it) => it && it.page === list[i].page;
    const lo = samePage(prev) ? prev.key : null, hi = samePage(next) ? next.key : null;
    if (lo != null && hi != null) return (lo + hi) / 2;
    if (lo != null) return lo + 0.01;
    if (hi != null) return hi - 0.01;
    return list[i].key;
  };
  function matches(it) {
    const d = it.data, mine = it.src === "mine";
    const keep = {
      all: true, mine: mine && d.kind === "note", hl: mine && d.kind === "highlight", q: mine && d.kind === "question",
      agent: !mine || PR.repliesTo(d.id).length > 0, star: starred(it.page),
    }[filter];
    if (!keep) return false;
    if (color && !(mine && d.kind !== "question" && (d.quote || d.region) && (d.color || "yellow") === color)) return false;
    if (!query) return true;
    const text = [d.body, d.quote, d.title, d.q].concat(mine ? PR.repliesTo(d.id).map((r) => r.body) : []).filter(Boolean).join("\n").toLowerCase();
    return text.includes(query);
  }
  const pageLabel = (p) => (p ? PR.t("第 {page} 页", { page: p }) : PR.t("论文开头"));

  function listHtml() {
    const list = allItems().filter(matches);
    // 每一頁自己的筆記也排進來（放在那一頁的最前面），複習時一頁一頁看得到全部
    const pnPages = filter === "all" || filter === "mine" || filter === "star"
      ? Object.keys(S.reader.page_notes || {}).map(Number).filter((p) => pageNote(p) && !color && (filter !== "star" || starred(p)) && (!query || pageNote(p).toLowerCase().includes(query)))
      : [];
    const pages = Array.from(new Set(list.map((i) => i.page).concat(pnPages))).sort((a, b) => a - b);
    let h = "";
    for (const p of pages) {
      h += '<div class="np-sec" data-page="' + p + '"><span>' + PR.esc(pageLabel(p)) + "</span>" + (starred(p) ? '<span class="st">' + PR.icon("star", "sm") + "</span>" : "") + "</div>";
      if (pnPages.includes(p)) h += '<div class="card pnote" data-pnote="' + p + '"><div class="hd"><span class="ic">' + PR.icon("notebook", "sm") + '</span><span class="lbl">' + PR.t("本頁筆記") + '</span></div><div class="body">' + PR.mdBlocks(pageNote(p)) + "</div></div>";
      for (const it of list) if (it.page === p) h += PR.cardHtml(it, editing);
    }
    if (!pages.length) h = '<p class="hint np-empty">' + (filter === "all" && !query && !color ? PR.t("還沒有標記。選字可以畫線、寫筆記、問 AI；選不到字的地方用框選。") : PR.t("这个分类下没有内容。")) + "</p>";
    return h;
  }

  function pageHtml() {
    const p = panelPage, pn = (S.reader.page_notes || {})[p] || {};
    const items = allItems().filter((i) => i.page === p);
    const n = pageCount();
    return '<div class="np-page"><div class="np-phead">' +
      '<button class="btn icon sm" data-np-act="pprev" title="' + PR.t("上一頁") + '"' + (p <= 1 ? " disabled" : "") + ">" + PR.icon("back", "sm") + "</button>" +
      '<span class="np-pnum">' + PR.t("第 {p} / {n} 页", { p, n }) + "</span>" +
      '<button class="btn icon sm" data-np-act="pnext" title="' + PR.t("下一頁") + '"' + (p >= n ? " disabled" : "") + ">" + PR.icon("next", "sm") + "</button>" +
      '<span class="grow"></span><button class="np-chip" data-np-act="pgo"' + (detached ? "" : " hidden") + ">" + PR.t("PDF 在第 {n} 頁", { n: curPage() }) + "</button>" +
      '<button class="btn icon sm np-star' + (pn.star ? " on" : "") + '" data-np-act="star" title="' + PR.t("標成重點頁（之後可以只看重點頁）") + '">' + PR.icon("star", "sm") + "</button></div>" +
      (pnEdit || !(pn.body || "").trim()
        ? PR.mdEd('<textarea class="np-pnote" data-page="' + p + '" placeholder="' + PR.t("這一頁的筆記…") + '">' + PR.esc(pn.body || "") + "</textarea>")
        : '<div class="np-pview" data-np-act="pedit" title="' + PR.t("點一下編輯") + '">' + PR.mdBlocks(pn.body) + "</div>") +
      '<div class="np-ptools">' + (canAsk() ? '<button class="btn sm line" data-np-act="explain">' + PR.icon("sparkle", "sm") + PR.t("解釋這一頁") + "</button>" : "") +
      (pdf() ? '<button class="btn sm line" data-np-act="region">' + PR.icon("region", "sm") + PR.t("框選") + "</button>" : "") + "</div>" +
      '<div class="np-sub">' + PR.t("這一頁的標記") + (items.length ? " · " + items.length : "") + "</div>" +
      '<div class="np-list">' + (items.length ? items.map((it) => PR.cardHtml(it, editing)).join("") : '<p class="hint np-empty">' + PR.t("選字可以畫線、寫筆記、問 AI；選不到字的地方用框選。") + "</p>") + "</div></div>";
  }

  const TEMPLATES = {
    paper: () => ["## " + PR.t("這篇在解決什麼問題"), "", "## " + PR.t("方法的關鍵"), "", "## " + PR.t("主要結果"), "", "## " + PR.t("限制與疑問"), "", "## " + PR.t("我的想法／可以用在哪"), ""].join("\n"),
    class: () => ["## " + PR.t("這堂課的重點"), "", "## " + PR.t("還不懂的地方"), "", "## " + PR.t("要複習／要做的"), ""].join("\n"),
  };
  function paperHtml() {
    const body = (S.reader.paper_note || {}).body || "";
    return '<div class="np-paper"><div class="np-tools"><button class="btn sm line" data-np-act="template"' + (body.trim() ? " hidden" : "") + ">" + PR.icon("template", "sm") + PR.t("套用範本") + '</button><span class="grow"></span>' + PR.noteHelpButtons() + "</div>" +
      (sumEdit || !body.trim() ? PR.mdEd('<textarea id="paperNote" placeholder="' + PR.t("整篇的重點、想法、待辦…") + '">' + PR.esc(body) + "</textarea>")
        : '<div class="np-preview" data-np-act="sedit" title="' + PR.t("點一下編輯") + '">' + PR.mdBlocks(body) + "</div>") + PR.noteHelpBox() + "</div>";
  }

  function notesHtml() {
    const chips = [["all", PR.t("全部")], ["mine", PR.t("笔记")], ["hl", PR.t("划线")], ["q", PR.t("提問")], ["agent", "AI"], ["star", PR.t("重點頁")]]
      .map(([k, l]) => '<button data-nf="' + k + '" class="' + (filter === k ? "on" : "") + '">' + l + "</button>").join("");
    const dots = '<span class="dots">' + PR.HL_COLORS.map(([c, name]) => '<button data-nc="' + c + '" class="dot-' + c + (color === c ? " on" : "") + '" title="' + name + '"></button>').join("") + "</span>";
    return '<div class="np-search">' + PR.icon("search", "sm") + '<input id="npSearch" placeholder="' + PR.t("搜尋筆記…") + '" value="' + PR.esc(query) + '">' +
      (pdf() ? "" : '<button class="btn sm line" data-np-act="add">' + PR.icon("plus", "sm") + PR.t("笔记") + "</button>") + "</div>" +
      '<div class="np-filters">' + chips + '<span class="grow"></span>' + dots + '</div><div class="np-list">' + listHtml() + "</div>";
  }

  /* editId：undefined＝只是資料變了重畫（正在打字就不打斷）；null＝收起編輯重畫；id＝編輯這一條 */
  PR.renderNotesPanel = function (editId) {
    const el = panel();
    if (!el) return;
    const ae = document.activeElement;
    if (editId === undefined && ae && el.contains(ae) && ae.matches && ae.matches("textarea, input")) return;
    if (editId !== undefined) {
      editing = editId;
      if (editId && tab === "paper") tab = "notes";
      if (editId && tab === "page") { const n = (S.reader.notes || {})[editId]; if (n && pageOfNote(n) !== panelPage) tab = "notes"; }
    }
    flushPageNote();
    if (tab === "page" && !detached) panelPage = Math.max(1, Math.min(pageCount() || 1, curPage()));
    const count = allItems().length;
    const seg = [["page", PR.t("本頁")], ["notes", PR.t("全部") + (count ? ' <i class="n">' + count + "</i>" : "")], ["paper", PR.t("總結")]]
      .map(([k, l]) => '<button data-np="' + k + '" class="' + (tab === k ? "on" : "") + '">' + l + "</button>").join("");
    const keep = el.querySelector(".np-list") ? el.querySelector(".np-list").scrollTop : 0;
    el.innerHTML = '<div class="np-head"><div class="seg">' + seg + '</div><span class="grow"></span><button class="btn icon" data-np-act="md" title="' + PR.t("导出 Markdown") + '">' + PR.icon("download", "sm") +
      '</button><button class="btn icon" data-np-act="close" title="' + PR.t("关闭") + '">' + PR.icon("x", "sm") + "</button></div>" +
      (tab === "paper" ? paperHtml() : tab === "notes" ? notesHtml() : pageHtml());
    PR.$$(".card", el).forEach((c) => PR.prepCard && PR.prepCard(c));
    PR.$$(".np-list .card.mine[data-note]:not(.editing)", el).forEach((c) => { c.draggable = true; });  // 拖排順序、拖到另一張上建立關聯
    PR.$$("textarea", el).forEach(PR.autosize);
    const list = el.querySelector(".np-list");
    if (list) list.scrollTop = keep;
    const ta = editing && el.querySelector('.card[data-note="' + editing + '"] textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollIntoView({ block: "nearest" }); }
  };

  /* ---------- 本頁筆記：打字就存；換頁、重畫之前先把還沒存的寫進去 ---------- */
  let pendingPn = null, pnT = null;
  function flushPageNote() {
    clearTimeout(pnT);
    if (!pendingPn) return;
    const { page, body } = pendingPn;
    pendingPn = null;
    const cur = (S.reader.page_notes || {})[page] || {};
    if (body !== (cur.body || "")) PR.commit(Object.assign({ op: "page_note", page, body }, cur.star ? { star: true } : {}));
  }
  function setStar(page, on) {
    flushPageNote();
    const cur = (S.reader.page_notes || {})[page] || {};
    PR.commit(Object.assign({ op: "page_note", page, body: cur.body || "" }, on ? { star: true } : {}));
  }
  /* PDF 翻頁了：沒在打字就跟過去；正在打字就留在原來那一頁，只亮一顆提示 */
  const follow = PR.debounce(() => {  // 等捲動停下來再換（翻頁的動畫會經過中間幾頁）
    if (!PR.notesPanelOpen() || tab !== "page") return;
    const p = curPage(), el = panel(), ae = document.activeElement;
    if (p === panelPage) { if (detached) { detached = false; const c = el.querySelector(".np-chip"); if (c) c.hidden = true; } return; }
    if (ae && el.contains(ae) && ae.matches("textarea")) {
      detached = true;
      const c = el.querySelector(".np-chip");
      if (c) { c.hidden = false; c.textContent = PR.t("PDF 在第 {n} 頁", { n: p }); }
      return;
    }
    detached = false; pnEdit = false;
    PR.renderNotesPanel(null);
  }, 160);
  const pv = PR.$(".pv-scroll");
  if (pv) pv.addEventListener("scroll", follow, { passive: true });
  if (window.addEventListener) window.addEventListener("scroll", follow, { passive: true });

  const savePaperNote = PR.debounce(() => { const ta = PR.$("#paperNote"); if (ta) PR.commit({ op: "paper_note", body: ta.value }); }, 600);
  const saveEditing = PR.debounce(() => {
    const ta = editing && panel().querySelector('.card[data-note="' + editing + '"] textarea');
    const n = editing && (S.reader.notes || {})[editing];
    if (ta && n && ta.value.trim() !== (n.body || "")) PR.saveNote(Object.assign({}, n, { body: ta.value.trim(), kind: n.kind === "highlight" && ta.value.trim() ? "note" : n.kind }));
  }, 600);
  function stopEditing() {
    const ta = editing && panel().querySelector('.card[data-note="' + editing + '"] textarea');
    const n = editing && (S.reader.notes || {})[editing];
    saveEditing.cancel();
    if (ta && n) PR.finishNote(n, ta.value);
    editing = null;
    PR.renderNotesPanel(null);
    PR.applyMarks();
  }

  /* 拖卡片：放在另一張的上下緣＝排到它前面／後面（同一頁內），放在中間＝建立關聯 */
  let dragId = null, dropOn = null;
  const clearDrop = () => { if (dropOn) { dropOn.classList.remove("drop-before", "drop-after", "drop-link"); dropOn = null; } };
  panel().addEventListener("dragstart", (e) => {
    const card = e.target.closest && e.target.closest(".np-list .card.mine[data-note]");
    if (!card) return;
    dragId = card.dataset.note;
    card.classList.add("dragging");
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); }
  });
  panel().addEventListener("dragover", (e) => {
    const card = dragId && e.target.closest && e.target.closest(".np-list .card[data-note]");
    if (!card || card.dataset.note === dragId) { clearDrop(); return; }
    e.preventDefault();
    const r = card.getBoundingClientRect(), f = (e.clientY - r.top) / Math.max(1, r.height);
    const notes = S.reader.notes || {}, na = notes[dragId], nb = notes[card.dataset.note];
    const samePage = na && nb && pageOfNote(na) === pageOfNote(nb);  // 不同頁的只能建立關聯，排順序沒有意義
    const zone = !samePage ? "drop-link" : f < 0.28 ? "drop-before" : f > 0.72 ? "drop-after" : "drop-link";
    if (dropOn !== card || !card.classList.contains(zone)) { clearDrop(); dropOn = card; card.classList.add(zone); }
  });
  panel().addEventListener("dragleave", (e) => { if (dropOn && !panel().contains(e.relatedTarget)) clearDrop(); });
  panel().addEventListener("drop", (e) => {
    const card = dropOn, id = dragId;
    if (!card || !id) return;
    e.preventDefault();
    const zone = card.classList.contains("drop-link") ? "link" : card.classList.contains("drop-before") ? "before" : "after";
    clearDrop();
    const n = (S.reader.notes || {})[id];
    if (!n) return;
    if (zone === "link") { PR.linkNotes && PR.linkNotes(id, card.dataset.note); return; }
    const key = PR.reorderKey(allItems(), id, card.dataset.note, zone === "after");
    if (key == null) return;
    PR.saveNote(Object.assign({}, n, { ui: Object.assign({}, n.ui, { order: Math.round(key * 10000) / 10000 }) }), { ui: true });
    PR.renderNotesPanel();
  });
  panel().addEventListener("dragend", () => { PR.$$(".np-list .card.dragging", panel()).forEach((c) => c.classList.remove("dragging")); clearDrop(); dragId = null; });
  panel().addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "npSearch") { query = t.value.trim().toLowerCase(); const l = panel().querySelector(".np-list"); if (l) { l.innerHTML = listHtml(); PR.$$(".card", l).forEach((c) => PR.prepCard(c)); } return; }
    if (t.matches("textarea")) PR.autosize(t);
    if (t.matches(".np-pnote")) { pendingPn = { page: +t.dataset.page, body: t.value }; clearTimeout(pnT); pnT = setTimeout(flushPageNote, 500); return; }
    if (t.id === "paperNote") {
      savePaperNote();
      const empty = !t.value.trim();
      const tpl = PR.$('#notespanel [data-np-act="template"]');
      if (tpl) tpl.hidden = !empty;
      const btns = PR.$("#notespanel .nh-btns");  // 笔记从空变成有内容（或反过来）：“起草稿”换成“点评 / 帮我改”
      if (btns && (btns.querySelector('[data-nh="draft"]') ? 1 : 0) !== (empty ? 1 : 0)) btns.outerHTML = PR.noteHelpButtons();
    } else if (t.matches(".card textarea")) saveEditing();
  });
  panel().addEventListener("keydown", (e) => {
    if (!e.target.matches(".card textarea")) return;
    const card = e.target.closest(".card");
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(e.ctrlKey || e.metaKey) && card.classList.contains("k-question") && card.querySelector('[data-a="send"]')) {
      e.preventDefault(); saveEditing.cancel(); PR.sendQuestion(card.dataset.note, e.target.value, true); return;
    }
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); stopEditing(); }
  });
  panel().addEventListener("focusout", (e) => {
    if (e.target.id === "paperNote") savePaperNote.flush();
    if (e.target.matches && e.target.matches(".np-pnote")) flushPageNote();
    if (e.target.matches && e.target.matches(".np-pnote, #paperNote")) {  // 寫完離開：換回排好的樣子
      const ed = e.target.closest(".md-ed");
      setTimeout(() => {
        if (!ed.isConnected || ed.contains(document.activeElement) || !document.hasFocus()) return;
        pnEdit = sumEdit = false;
        PR.renderNotesPanel(null);
      }, 140);
    }
    if (!e.target.matches || !e.target.matches(".card textarea")) return;
    setTimeout(() => { const card = e.target.closest(".card"); if (card && card.isConnected && !card.contains(document.activeElement) && editing === card.dataset.note) stopEditing(); }, 150);
  });
  panel().addEventListener("click", (e) => {
    const np = e.target.closest("[data-np]");
    if (np) { tab = np.dataset.np; PR.ls.set("easyread-np-tab", tab); detached = false; return PR.renderNotesPanel(null); }
    const nf = e.target.closest("[data-nf]");
    if (nf) { filter = nf.dataset.nf; return PR.renderNotesPanel(null); }
    const nc = e.target.closest("[data-nc]");
    if (nc) { color = color === nc.dataset.nc ? "" : nc.dataset.nc; return PR.renderNotesPanel(null); }
    const act = e.target.closest("[data-np-act]");
    if (act) {
      const a = act.dataset.npAct;
      if (a === "close") PR.toggleNotesPanel(false);
      if (a === "md") PR.openExport();
      if (a === "pedit" || a === "sedit") {
        if (e.target.closest("a, img") || String(getSelection())) return;
        if (a === "pedit") pnEdit = true; else sumEdit = true;
        PR.renderNotesPanel(null);
        const ta = panel().querySelector(a === "pedit" ? ".np-pnote" : "#paperNote");
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return;
      }
      if (a === "template") {
        const kind = (S.paper.meta || {}).kind;
        PR.commit({ op: "paper_note", body: TEMPLATES[kind === "slides" || kind === "notes" ? "class" : "paper"]() });
        sumEdit = true;
        PR.renderNotesPanel(null);
        const ta = PR.$("#paperNote");
        if (ta) { ta.focus(); const i = ta.value.indexOf("\n") + 1; ta.setSelectionRange(i, i); }
      }
      if (a === "pprev" || a === "pnext") {
        flushPageNote();
        const to = Math.max(1, Math.min(pageCount(), panelPage + (a === "pnext" ? 1 : -1)));
        if (pdf()) { PR.openPage(to); detached = false; } else detached = true;  // 文章優先：面板自己翻，不動正文
        panelPage = to; pnEdit = false;
        PR.renderNotesPanel(null);
      }
      if (a === "pgo") { detached = false; PR.renderNotesPanel(null); }
      if (a === "star") { setStar(panelPage, !starred(panelPage)); PR.renderNotesPanel(null); }
      if (a === "region") PR.toggleRegion && PR.toggleRegion(true);
      if (a === "explain") {  // 整頁當成一個框選的提問：頁面的圖和文字一起給模型
        const note = { id: PR.uid("n"), side: "pdf", page: panelPage, region: [0, 0, 1, 1], kind: "question", body: PR.t("解釋這一頁在講什麼、重點是什麼。"), created: PR.nowIso() };
        PR.saveNote(note);
        PR.renderNotesPanel(null);
        PR.askModel(note.id);
      }
      if (a === "add") {
        const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock();
        if (PR.blockById[id]) PR.startNote({ anchor: id });
      }
      return;
    }
    const pn = e.target.closest(".card.pnote");
    if (pn) { tab = "page"; PR.ls.set("easyread-np-tab", tab); panelPage = +pn.dataset.pnote; if (pdf()) { PR.goToPage(panelPage); detached = false; } else detached = true; return PR.renderNotesPanel(null); }
    const card = e.target.closest(".card");
    if (!card) return;
    if (card.dataset.note && !card.classList.contains("editing") && (e.target.closest(".card > .body") || e.target.closest('[data-a="edit"]')) && !e.target.closest("a") && !String(getSelection())) {
      editing = card.dataset.note; PR.renderNotesPanel(editing); return;
    }
    if (PR.cardClick(e, true)) return;
    if (e.target.closest("textarea, button, a")) return;
    const n = card.dataset.note && (S.reader.notes || {})[card.dataset.note];
    if (n && n.side === "pdf" && n.page && pdf()) {  // 畫在 PDF 上的：翻到那一頁、捲到標記那裡
      PR.goToPage(n.page);
      setTimeout(() => {
        const m = PR.$('.pv-mark[data-note="' + n.id + '"], .pv-area[data-note="' + n.id + '"], .pv-badge[data-note="' + n.id + '"]');
        if (m) m.scrollIntoView({ block: "center", behavior: "smooth" });
        PR.$$('.pv-mark[data-note="' + n.id + '"], .pv-area[data-note="' + n.id + '"]').forEach((x) => x.classList.add("active"));
      }, 80);
    } else if (card.dataset.anchor) {
      PR.goToAnchor(card.dataset.anchor);
      if (card.dataset.note) setTimeout(() => PR.$$('mark[data-note="' + card.dataset.note + '"], .pv-mark[data-note="' + card.dataset.note + '"]').forEach((m) => m.classList.add("active")), 400);
    }
  });

  /* 导出的 Markdown：整篇筆記 + 各頁筆記 + 按頁排好的标记 */
  /* pick：{paper, note, highlight, question, ai, chat, quote}，不传就全要 */
  PR.notesMarkdown = function (pick, chat) {
    pick = pick || { paper: true, note: true, highlight: true, question: true, ai: true, quote: true };
    const m = S.paper.meta || {};
    const link = m.url || (m.arxiv ? "https://arxiv.org/abs/" + String(m.arxiv).replace(/^arXiv:/i, "").split(/[\sv]/)[0] : "");
    const out = ["# " + (m.title_zh || m.title_en || ""), "", m.title_zh && m.title_en ? "*" + m.title_en + "*  " : "", [m.authors, m.date, link].filter(Boolean).join(" · "), ""];
    const pn = (S.reader.paper_note || {}).body;
    if (pick.paper && pn) out.push("## " + PR.t("總結"), "", pn, "");
    const pns = Object.entries(S.reader.page_notes || {}).filter(([, v]) => v && (v.body || v.star)).sort((a, b) => +a[0] - +b[0]);
    if (pick.paper && pns.length) {
      out.push("## " + PR.t("各頁筆記"), "");
      for (const [p, v] of pns) out.push("### " + PR.t("第 {page} 页", { page: p }) + (v.star ? " ★" : ""), "", v.body || "", "");
    }
    const want = (it) => it.src === "mine" ? !!pick[it.data.kind === "question" ? "question" : it.data.kind === "highlight" ? "highlight" : "note"] : !!pick.ai;
    const list = allItems().filter(want);
    if (list.length) out.push("## " + PR.t("批注"), "");
    let lastSec = null;
    for (const it of list) {
      const sec = pageLabel(it.page) + (PR.blockById[it.anchor] ? " · " + sectionOf(it.anchor) : "");
      if (sec !== lastSec) { out.push("### " + sec, ""); lastSec = sec; }
      const d = it.data;
      const q = pick.quote && d.quote ? PR.t("「{q}」", { q: d.quote }) + (it.src === "mine" && d.side === "en" ? PR.t("（原文）") : "") : pick.quote && d.region ? PR.t("（框選的區域）") : "";
      if (it.src === "mine") {
        out.push("- **" + ({ question: PR.t("我的问题"), highlight: PR.t("划线") }[d.kind] || PR.t("我的笔记")) + "**" + q + (d.body ? PR.t("：") + d.body : ""));
        if (pick.ai) for (const r of PR.repliesTo(d.id)) out.push("", "  " + PR.t("**AI**（{model}）：", { model: r.by || "AI" }) + (r.body || "").replace(/\n/g, "\n  "));
      } else out.push("- **AI" + (d.kind === "reply" ? " " + PR.t("回答") : "") + (d.title ? PR.t("：") + d.title : "") + "**" + q + (d.q ? PR.t("（问：{q}）", { q: d.q }) : "") + "\n\n  " + (d.body || "").replace(/\n/g, "\n  "));
    }
    if (pick.chat && chat && chat.length) {
      out.push("", "## " + PR.t("问 AI 的对话"), "");
      for (const c of chat) out.push(c.role === "user" ? PR.t("**我**：") + c.content : PR.t("**AI**（{model}）：", { model: c.model || "" }) + c.content, "");
    }
    return out.join("\n");
  };
})(window.PR);
