/* 边注：共读讨论（discussion.json）和我的笔记（reader.json）。
   宽屏排在正文右侧、贴着对应段落；窄屏或开着侧面板时收成段尾角标，点开在段落下方。
   卡片（cardHtml）是共用的：頁邊、筆記面板、PDF 上的便利貼（sticky.js）都用同一張——
   我的筆記／問題一張卡，AI 對它的回答嵌在卡片裡面；AI 自己寫的解釋另外一張。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const KIND_LABEL = { explain: PR.t("AI · 解释"), qa: PR.t("AI · 问答"), insight: PR.t("AI · 补充"), reply: PR.t("AI · 回答你的问题"), check: PR.t("原文核对提示") };
  const expanded = new Set();
  PR.editingNote = null;
  PR.asking = new Set();   // 正在等模型回答的问题
  PR.liveAnswers = {};     // 筆記 id → { text, model, error }：正在流出來的回答（ask.js）

  PR.myNotes = () => Object.values(S.reader.notes || {}).filter((n) => !n.deleted);
  PR.repliesTo = (nid) => (S.discussion.entries || []).filter((e) => e.reply_to === nid);
  const anchorOf = (a) => (a && (a === "head" || PR.blockById[a]) ? a : "head");
  PR.anchorOfEntry = (e) => anchorOf(e.anchor || (((S.reader.notes || {})[e.reply_to] || {}).anchor));

  /* 按锚点分组：组内按时间，agent 的回复紧跟在被回复的笔记后面 */
  function collect() {
    const groups = {};
    const push = (anchor, item) => { item.anchor = anchor; (groups[anchor] = groups[anchor] || []).push(item); };
    const noteById = {};
    const notes = PR.myNotes();
    notes.forEach((n) => (noteById[n.id] = n));
    for (const n of notes) {
      if (n.kind === "highlight" && !(n.body || "").trim() && PR.editingNote !== n.id) continue;
      if (n.side === "pdf" && !PR.blockById[n.anchor]) continue;  // 畫在 PDF 上、沒對到段落的：卡片在 PDF 旁邊和筆記面板
      push(anchorOf(n.anchor), { src: "mine", t: n.created || n.updated || "", data: n });
    }
    for (const e of S.discussion.entries || []) {
      if (e.reply_to && noteById[e.reply_to]) continue;  // 對筆記的回答嵌在那張筆記卡片裡
      push(PR.anchorOfEntry(e), { src: "agent", t: e.at || "", data: e });
    }
    for (const list of Object.values(groups)) list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    return groups;
  }

  /* 框選的區域（選不到字的圖、投影片）：用整頁圖當背景裁出那一塊當縮圖 */
  function clipHtml(d) {
    const p = d.region && d.page && ((S.paper.meta || {}).pages || [])[d.page - 1];
    if (!p) return "";
    const [x0, y0, x1, y1] = d.region, w = Math.max(x1 - x0, 0.001), h = Math.max(y1 - y0, 0.001);
    const ratio = (h * (p.h || 792)) / (w * (p.w || 612));  // 高 / 寬
    const src = PR.imageUrl(p.img) + (PR.store.mode === "server" ? "?w=1600" : "");
    return '<div class="clip" style="width:min(100%,' + Math.round(170 / ratio) + "px);aspect-ratio:" + (1 / ratio).toFixed(4) + ";background-image:url(&quot;" + PR.esc(src) + "&quot;);background-size:" +
      (100 / w).toFixed(2) + "% " + (100 / h).toFixed(2) + "%;background-position:" + (w < 1 ? (x0 / (1 - w)) * 100 : 0).toFixed(2) + "% " + (h < 1 ? (y0 / (1 - h)) * 100 : 0).toFixed(2) + '%"></div>';
  }
  PR.clipHtml = clipHtml;
  const act = (a, icon, title, extra) => '<button data-a="' + a + '" title="' + PR.esc(title) + '"' + (extra || "") + ">" + PR.icon(icon, "sm") + "</button>";
  /* AI 對這條筆記／問題的回答：嵌在卡片裡 */
  function replyHtml(e) {
    const can = PR.store.mode === "server";
    return '<div class="reply" data-card="' + PR.esc(e.id) + '"><div class="rhd"><span class="ic ai">' + PR.icon("sparkle", "sm") + '</span><span class="who">' + PR.esc(e.by || "AI") + '</span><span class="meta">' + PR.shortTime(e.updated || e.at) +
      '</span><span class="grow"></span><span class="acts">' + act("rcopy", "copy", PR.t("复制")) + (can && PR.canChat && PR.canChat() ? act("regen", "redo", PR.t("重新回答")) : "") + (can ? act("adel", "trash", PR.t("删除")) : "") + "</span></div>" +
      '<div class="body">' + PR.mdBlocks(e.body) + "</div></div>";
  }
  /* 正在流出來的回答（ask.js 一邊收一邊改這一塊） */
  function liveHtml(id) {
    const l = PR.liveAnswers[id];
    if (!l) return "";
    return '<div class="reply live' + (l.error ? " err" : "") + '"><div class="rhd"><span class="ic ai">' + PR.icon("sparkle", "sm") + '</span><span class="who">' + PR.esc(l.model || "AI") + "</span>" + (l.error ? "" : '<span class="spin"></span>') +
      '<span class="grow"></span><span class="acts on">' + (l.error ? act("ask", "redo", PR.t("再試一次")) + act("dismiss", "x", PR.t("关闭")) : act("stop", "stop", PR.t("停止"))) + "</span></div>" +
      '<div class="body">' + (l.error ? PR.esc(l.error) : l.text ? PR.mdBlocks(l.text) : '<p class="thinking"><i></i><i></i><i></i>' + (PR.waitHint ? PR.waitHint() : "") + "</p>") + "</div></div>";
  }
  const pageOf = (d) => (d.side === "pdf" && d.page) || (PR.blockById[d.anchor] || {}).page || 0;

  function cardHtml(item, editingId) {
    const d = item.data;
    if (item.src === "agent") {
      return '<div class="card agent' + (d.kind === "check" ? " check" : "") + '" data-card="' + PR.esc(d.id) + '" data-anchor="' + PR.esc(item.anchor) + '">' +
        '<div class="hd"><span class="ic ai">' + PR.icon(d.kind === "check" ? "alert" : "sparkle", "sm") + '</span><span class="lbl">' + (KIND_LABEL[d.kind] || "AI") + '</span><span class="meta">' + PR.shortTime(d.updated || d.at) + '</span><span class="grow"></span>' +
        (PR.store.mode !== "server" ? "" : '<span class="acts">' + (d.reply_to && (S.reader.notes || {})[d.reply_to] && PR.canChat && PR.canChat() ? act("regen", "redo", PR.t("重新回答")) : "") + act("adel", "trash", PR.t("删除")) + "</span>") + "</div>" +
        (d.quote ? '<div class="quote">' + PR.md(d.quote, { cite: false, xref: false }) + "</div>" : "") +
        (d.title ? '<div class="ttl">' + PR.md(d.title, { xref: false }) + "</div>" : "") +
        (d.q ? '<div class="q">' + PR.md(d.q) + "</div>" : "") +
        '<div class="body">' + PR.mdBlocks(d.body) + "</div></div>";
    }
    const replies = PR.repliesTo(d.id);
    const answered = replies.length > 0;
    const asking = PR.asking.has(d.id);
    const isQ = d.kind === "question";
    const lbl = isQ ? (answered ? PR.t("我的问题") : asking ? PR.t("模型思考中") : PR.t("我的问题") + " · " + PR.t("待回答")) : d.kind === "highlight" ? PR.t("我的划线") : PR.t("我的笔记");
    const lost = d.quote && PR.quoteLost && PR.quoteLost(d.id) ? " lost" : "";
    const editing = (editingId !== undefined ? editingId : PR.editingNote) === d.id;
    const canAsk = PR.canChat && PR.canChat() && PR.feature("chat");
    const page = pageOf(d);
    // 動作（滑鼠移上去才出現）：改、讓 AI 回答／點評／追問、刪
    const askBtn = !canAsk || d.kind === "highlight" || !d.body || asking ? ""
      : isQ ? (answered ? act("followup", "message", PR.t("追问 AI")) : act("ask", "sparkle", PR.t("让 AI 回答"))) : act("ask", "sparkle", PR.t("让 AI 点评"));
    const head = '<div class="hd"><span class="ic">' + PR.icon(isQ ? "help" : d.kind === "highlight" ? "marker" : "note", "sm") + '</span><span class="lbl">' + lbl + "</span>" +
      (page ? '<span class="where">p.' + page + "</span>" : "") + '<span class="meta">' + PR.shortTime(d.updated || d.created) + '</span><span class="grow"></span>' +
      (editing ? "" : '<span class="acts">' + askBtn + act("link", "link", PR.t("建立關聯")) + act("edit", "edit", PR.t("编辑")) + act("del", "trash", PR.t("删除")) + "</span>") + "</div>";
    // 關聯的筆記：一排小標籤，點了跳過去，× 取消關聯
    const links = (d.links || []).map((id) => noteById(id)).filter((x) => x && !x.deleted);
    const linksHtml = links.length ? '<div class="links">' + links.map((x) => '<span class="lk"><button data-a="goto" data-to="' + PR.esc(x.id) + '" title="' + PR.t("看這條關聯的筆記") + '">' + PR.icon("link", "sm") +
      "<span>" + PR.esc(linkLabel(x)) + '</span></button><button class="lk-x" data-a="unlink" data-to="' + PR.esc(x.id) + '" title="' + PR.t("取消關聯") + '">×</button></span>').join("") + "</div>" : "";
    const quote = (d.region ? clipHtml(d) : "") + (d.quote ? '<div class="quote' + lost + '"' + (d.side === "en" || d.side === "pdf" ? ' lang="en"' : "") + ">" +
      (d.side === "en" ? '<span class="side-tag">' + PR.t("原文") + "</span>" : "") + PR.md(d.quote, { cite: false, xref: false }) + "</div>" : "");
    // 快速問題：還沒打字時給兩顆小按鈕，按了直接送
    const quick = !isQ || !canAsk || d.body ? "" : '<div class="qchips">' + (d.region
      ? [[PR.t("解釋"), PR.t("解釋這個區域在表達什麼、重點是什麼。")], [PR.t("翻譯"), PR.t("把這個區域裡的文字翻譯出來。")]]
      : [[PR.t("解釋"), PR.t("用白話解釋這段在說什麼。")], [PR.t("舉例"), PR.t("舉一個具體的例子說明這段。")]])
      .map(([l, q]) => '<button data-q="' + PR.esc(q) + '">' + l + "</button>").join("") + "</div>";
    const body = editing
      ? (PR.mdEd || ((h) => h))('<textarea rows="1" placeholder="' + (isQ ? PR.t("想問什麼？") : PR.t("寫筆記…")) + '">' + PR.esc(d.body || "") + "</textarea>", { bar: !isQ }) + quick +
        '<div class="kinds"><span class="kseg"><button data-k="note" class="' + (!isQ ? "on" : "") + '">' + PR.t("笔记") + '</button><button data-k="question" class="' + (isQ ? "on" : "") + '">' + PR.t("提問") + "</button></span>" +
        (isQ ? "" : colorDots(d)) + '<span class="grow"></span>' +
        (isQ && canAsk ? '<button class="ask-model" data-a="model" title="' + PR.t("换模型") + '"><span>' + PR.esc((PR.chatModel && PR.chatModel.label()) || PR.t("模型")) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
          '<button class="send" data-a="send" title="' + PR.t("送出（Enter）") + '">' + PR.icon("arrowUp", "sm") + "</button>"
          : '<span class="hint">' + PR.t("Esc 收起") + "</span>") + "</div>"
      : (d.body ? '<div class="body">' + PR.mdBlocks(d.body) + "</div>" : "");
    return '<div class="card mine k-' + (d.kind || "note") + (editing ? " editing" : "") + (d.color && !isQ ? " c-" + d.color : "") + '" data-note="' + PR.esc(d.id) + '" data-anchor="' + PR.esc(item.anchor) + '">' +
      head + quote + body + replies.map(replyHtml).join("") + liveHtml(d.id) + linksHtml + "</div>";
  }
  PR.cardHtml = cardHtml;
  PR.collectNotes = collect;
  /* 關聯標籤上的字：筆記的前幾個字（沒寫字就用原話、框選），加頁碼 */
  function linkLabel(n) {
    const text = PR.plain((n.body || "").trim()) || (n.quote || "").trim() || (n.region ? PR.t("框選的區域") : PR.t("筆記"));
    const page = pageOf(n);
    return text.replace(/\s+/g, " ").slice(0, 16) + (text.length > 16 ? "…" : "") + (page ? " · p." + page : "");
  }
  function colorDots(d) {
    if (!d.quote) return "";
    return '<span class="dots">' + ["yellow", "green", "blue", "pink"].map((c) =>
      '<button data-color="' + c + '" class="dot-' + c + ((d.color || "yellow") === c ? " on" : "") + '" title="' + PR.t("换颜色") + '"></button>').join("") + "</span>";
  }

  // PDF 優先時譯文排在 PDF 旁邊，沒有空間放邊注欄（#margin 是藏著的）：卡片收成段尾角標，不然會畫進看不見的地方
  PR.marginWide = () => window.matchMedia("(min-width: 1240px)").matches && !document.body.classList.contains("pdf-main") &&
    !document.body.classList.contains("side-open") && !document.body.classList.contains("no-margin");

  PR.renderMargin = function () {
    const groups = collect();
    PR.noteGroups = groups;
    const margin = PR.$("#margin");
    PR.$$(".note-pin, .inline-notes").forEach((n) => n.remove());
    const wide = PR.marginWide();
    margin.innerHTML = "";
    for (const [anchor, items] of Object.entries(groups)) {
      const host = document.getElementById("b-" + anchor);
      if (!host) continue;
      const html = items.map((it) => cardHtml(it)).join("");
      if (wide) margin.insertAdjacentHTML("beforeend", html);
      else {
        const mine = items.every((i) => i.src === "mine");
        host.appendChild(PR.el("button", { class: "note-pin" + (mine ? " mine" : ""), title: PR.t("讨论与笔记"), "data-t": "pin", text: String(items.length) }));
        host.appendChild(PR.el("div", { class: "inline-notes" }, html));
      }
    }
    PR.$$("#margin .card, .inline-notes .card").forEach(prepCard);
    if (wide) PR.layoutMargin();
    PR.renderPvMargin && PR.renderPvMargin();  // PDF 頁旁邊的邊註欄（pvmargin.js）跟著重畫
    PR.emit("margin-rendered");
  };

  PR.prepCard = prepCard;
  function prepCard(card) {
    // 长的先收起；展开过的也留一个“收起全文”（#31）。筆記本身和每一則回答各自收
    PR.$$(".body", card).forEach((body) => {
      const host = body.closest(".reply") || card;
      const id = host.dataset.card || host.dataset.note;
      if (host.classList.contains("live") || body.nextElementSibling && body.nextElementSibling.matches(".more")) return;
      if (body.scrollHeight > 220) {
        const open = expanded.has(id);
        body.classList.toggle("clamp", !open);
        body.insertAdjacentHTML("afterend", '<button class="more" data-a="more">' + (open ? PR.t("收起全文") : PR.t("展开全文")) + "</button>");
      }
    });
    const ta = card.querySelector("textarea");
    if (ta) PR.autosize(ta);
  }

  /* 宽屏：卡片贴着锚点，放不下就往下顺延 */
  PR.layoutMargin = function () {
    if (!PR.marginWide()) return;
    const margin = PR.$("#margin");
    const mTop = margin.getBoundingClientRect().top;
    const cards = PR.$$(".card", margin).map((c) => {
      const host = document.getElementById("b-" + c.dataset.anchor);
      let y = host ? host.getBoundingClientRect().top - mTop : 0;
      // 划线所在的那边可能藏着（原文模式藏译文）：取看得见的划线，没有就取另一边的同步标记
      const sel = c.dataset.note ? 'mark[data-note="' + c.dataset.note + '"], [data-mirror="' + c.dataset.note + '"]' : 'mark[data-card="' + c.dataset.card + '"]';
      const mark = PR.$$(sel).find((m) => m.getClientRects().length);
      if (mark) y = Math.max(y, mark.getBoundingClientRect().top - mTop - 4);
      return { c, y };
    });
    cards.sort((a, b) => a.y - b.y);
    let bottom = -Infinity;
    for (const { c, y } of cards) {
      const top = Math.max(y, bottom + 16);
      c.style.top = Math.round(top) + "px";
      bottom = top + c.offsetHeight;
    }
    margin.style.minHeight = Math.max(0, bottom) + "px";
  };

  /* ---------- 笔记的增删改 ---------- */
  const noteById = (id) => (S.reader.notes || {})[id];
  /* opts.ui：只是拖了位置、拉了大小（note.ui），不進復原記錄 */
  PR.saveNote = function (note, opts) { note.updated = PR.nowIso(); PR.commit(Object.assign({ op: "note", note }, opts && opts.ui ? { ui: true } : {})); };

  /* 畫在 PDF 上的筆記（PDF 優先版面）：在標記旁邊的便利貼裡寫（sticky.js），不佔版面 */
  const onPdf = (n) => !!(n && n.side === "pdf" && PR.openSticky && PR.pdfMain && PR.pdfMain());
  PR.freshNotes = new Set();  // 這次新開、還沒寫過字的筆記：空著收起就直接刪掉
  PR.startNote = function (opts) {
    const note = Object.assign({ id: PR.uid("n"), kind: "note", body: "", created: PR.nowIso() }, opts);
    if (onPdf(note)) { PR.openSticky(note.id, { draft: note }); return note; }  // 先當草稿，寫了字才存
    PR.freshNotes.add(note.id);
    PR.saveNote(note);
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel(note.id);
    else PR.openNoteEditor(note.id);
    return note;
  };

  PR.openNoteEditor = function (id) {
    const n = noteById(id);
    if (onPdf(n)) { PR.openSticky(id, { edit: true }); return; }
    if (PR.notesPanelOpen && PR.notesPanelOpen()) { PR.renderNotesPanel(id); return; }
    PR.editingNote = id;
    PR.renderMargin();
    PR.applyMarks && PR.applyMarks();
    if (!PR.marginWide() && n) { const host = document.getElementById("b-" + anchorOf(n.anchor)); host && host.classList.add("notes-open"); }
    const ta = PR.$('#margin .card[data-note="' + id + '"] textarea, .inline-notes .card[data-note="' + id + '"] textarea');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const r = ta.getBoundingClientRect();
      if (r.bottom > innerHeight - 40 || r.top < 70) ta.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  PR.closeNoteEditor = function () {
    const id = PR.editingNote;
    if (!id) return;
    if (PR.stickyNote && PR.stickyNote() === id) { PR.closeSticky(); return; }
    const ta = PR.$('#margin .card[data-note="' + id + '"] textarea, .inline-notes .card[data-note="' + id + '"] textarea, .pv-margin .card[data-note="' + id + '"] textarea');
    const n = noteById(id);
    PR.editingNote = null;
    if (n && ta) PR.finishNote(n, ta.value);
    PR.renderMargin();
    PR.applyMarks && PR.applyMarks();
  };
  /* 结束编辑。空著的：問題、框選、剛新開的直接刪；原本是畫線的退回成畫線（畫線還在） */
  PR.finishNote = function (n, value) {
    const body = value.trim();
    const fresh = PR.freshNotes.delete(n.id);
    if (!body && n.kind !== "highlight") {
      if (n.quote && n.kind !== "question" && !fresh && !n.region) PR.saveNote(Object.assign({}, n, { kind: "highlight", body: "" }));
      else PR.commit({ op: "note_del", id: n.id });
    } else if (body !== (n.body || "")) PR.saveNote(Object.assign({}, n, { body, kind: n.kind === "highlight" ? "note" : n.kind }));
  };

  PR.autosaveNote = PR.debounce(() => {
    const id = PR.editingNote;
    const ta = id && PR.$('#margin .card[data-note="' + id + '"] textarea, .inline-notes .card[data-note="' + id + '"] textarea, .pv-margin .card[data-note="' + id + '"] textarea');
    const n = id && noteById(id);
    if (ta && n && ta.value.trim() !== (n.body || "")) {
      const copy = Object.assign({}, n, { body: ta.value.trim() });
      if (copy.kind === "highlight" && copy.body) copy.kind = "note";
      PR.saveNote(copy);
    }
  }, 600);

  /* 笔记卡片上的“让 AI 回答 / 点评”：回答直接流進這張卡片（ask.js），同時成為這條筆記的回覆。
     “追问”：到右邊的問 AI 面板接著問（接在這一問的對話後面） */
  PR.askModel = function (nid) {
    if (PR.askInline) return PR.askInline(nid);
    const n = noteById(nid);
    if (n) PR.chatAsk({ anchor: n.anchor, quote: n.quote, page: n.page, text: n.body, note: nid });
  };
  PR.followUp = function (nid) {
    const n = noteById(nid);
    if (!n) return;
    PR.closeSticky && PR.closeSticky();
    PR.chatAsk({ anchor: n.anchor, quote: n.quote, page: n.page, draft: "", thread: n.thread, region: n.region });
  };
  PR.on("job-finished", (j) => {
    if (j.kind !== "answer") return;
    PR.asking.delete(j.note);
    if (j.state === "error") PR.toast(PR.t("模型回答失败：{msg}", { msg: PR.esc(j.message) }));
    PR.renderMargin(); PR.notesPanelOpen && PR.notesPanelOpen() && PR.renderNotesPanel();
  });

  /* ---------- 卡片上的交互（边注和笔记面板共用） ---------- */
  const CARD_TA = "#margin .card textarea, .inline-notes .card textarea, .pv-margin .card textarea";
  document.addEventListener("input", (e) => {
    if (e.target.matches(CARD_TA)) { PR.autosize(e.target); PR.autosaveNote(); PR.layoutMargin(); PR.layoutPvMargin && PR.layoutPvMargin(); }
  });
  document.addEventListener("keydown", (e) => {
    if (!e.target.matches(CARD_TA)) return;
    const card = e.target.closest(".card");
    // 問題：Enter 直接送給 AI（Shift+Enter 換行）
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(e.ctrlKey || e.metaKey) && card.classList.contains("k-question") && card.querySelector('[data-a="send"]')) {
      e.preventDefault(); PR.sendQuestion(card.dataset.note, e.target.value, false); return;
    }
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault(); PR.autosaveNote.flush(); PR.closeNoteEditor();
    }
  });
  /* 把卡片裡正在寫的問題存好、收起編輯，然後交給 AI 回答 */
  PR.sendQuestion = function (nid, value, inPanel) {
    const n = noteById(nid), body = (value || "").trim();
    if (!n || !body) return;
    PR.freshNotes.delete(nid);
    if (body !== (n.body || "") || n.kind !== "question") PR.saveNote(Object.assign({}, n, { body, kind: "question" }));
    if (PR.editingNote === nid) PR.editingNote = null;
    if (inPanel) PR.renderNotesPanel(null); else { PR.renderMargin(); PR.applyMarks && PR.applyMarks(); }
    PR.askModel(nid);
  };
  document.addEventListener("focusout", (e) => {
    if (!e.target.matches(CARD_TA)) return;
    setTimeout(() => {
      const card = e.target.closest(".card");
      if (!card || !card.isConnected) return;   // 卡片被重排替换掉了，新卡片已接手编辑
      if (card.contains(document.activeElement)) return;
      if (PR.editingNote === card.dataset.note) { PR.autosaveNote.flush(); PR.closeNoteEditor(); }
    }, 150);
  });

  PR.cardClick = function (e, inPanel) {
    const card = e.target.closest(".card");
    if (!card) return false;
    const a = e.target.closest("[data-a]"), k = e.target.closest("[data-k]"), col = e.target.closest("[data-color]");
    const nid = card.dataset.note;
    const inSticky = !!card.closest(".pv-sticky"), inMargin = !!card.closest(".pv-margin");
    const repaint = () => (inSticky ? PR.renderSticky() : inPanel ? PR.renderNotesPanel() : PR.renderMargin());
    const rerender = () => (inSticky ? PR.openSticky(nid, { edit: true }) : inMargin ? PR.editInMargin(nid) : inPanel ? PR.renderNotesPanel(nid) : PR.openNoteEditor(nid));
    // 關聯：建立（進入選取模式）、跳過去、取消
    if (nid && a && a.dataset.a === "link") { PR.linkFrom && PR.linkFrom(nid); return true; }
    if (a && a.dataset.a === "goto") { PR.goToNote && PR.goToNote(a.dataset.to); return true; }
    if (nid && a && a.dataset.a === "unlink") { PR.unlinkNotes && PR.unlinkNotes(nid, a.dataset.to); return true; }
    if (a && a.dataset.a === "more") {
      const body = a.previousElementSibling, host = a.closest(".reply") || card;
      const id = host.dataset.card || host.dataset.note, open = !expanded.has(id);
      open ? expanded.add(id) : expanded.delete(id);
      body && body.classList.toggle("clamp", !open);
      a.textContent = open ? PR.t("收起全文") : PR.t("展开全文");
      PR.layoutMargin();
      if (!open && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "nearest" });  // 收起后卡片顶端跑到屏幕上方了，拉回来
      return true;
    }
    // 嵌在筆記卡片裡的回答：複製、重新回答、刪除
    const reply = e.target.closest(".reply[data-card]");
    if (reply && a) {
      const entry = (S.discussion.entries || []).find((x) => x.id === reply.dataset.card);
      if (a.dataset.a === "rcopy" && entry) navigator.clipboard.writeText(entry.body || "").then(() => PR.toast(PR.t("已复制")));
      else if (a.dataset.a === "adel" || a.dataset.a === "regen") delAgent(reply.dataset.card, a.dataset.a === "regen", a);
      return true;
    }
    if (card.dataset.card && a && (a.dataset.a === "adel" || a.dataset.a === "regen")) { delAgent(card.dataset.card, a.dataset.a === "regen", a); return true; }
    if (nid && a) {
      const n = noteById(nid) || (PR.stickyDraft && PR.stickyDraft() && PR.stickyDraft().id === nid ? PR.stickyDraft() : null);
      const ta = card.querySelector("textarea");
      if (a.dataset.a === "edit") rerender();
      else if (a.dataset.a === "ask") PR.askModel(nid);
      else if (a.dataset.a === "followup") PR.followUp(nid);
      else if (a.dataset.a === "stop") PR.stopInline && PR.stopInline(nid);
      else if (a.dataset.a === "dismiss") { delete PR.liveAnswers[nid]; repaint(); }
      else if (a.dataset.a === "model") PR.chatModel && PR.chatModel.menu(a);
      else if (a.dataset.a === "send") { if (inSticky) PR.stickySend(); else PR.sendQuestion(nid, ta ? ta.value : n.body, inPanel); }
      else if (a.dataset.a === "kind" && n) { PR.saveNote(Object.assign({}, n, { kind: n.kind === "question" ? "note" : "question" })); repaint(); PR.applyMarks(); }
      else if (a.dataset.a === "del" && n) {
        if (inSticky) PR.closeSticky({ discard: true });
        PR.commit({ op: "note_del", id: nid });
        PR.renderMargin(); PR.applyMarks(); inPanel && PR.renderNotesPanel();
        PR.toast(PR.t("已删除这条笔记"), { label: PR.t("撤销"), fn: () => { PR.saveNote(Object.assign({}, n, { deleted: false })); PR.renderMargin(); PR.applyMarks(); PR.notesPanelOpen && PR.notesPanelOpen() && PR.renderNotesPanel(); } });
      }
      return true;
    }
    if (nid && (k || col)) {
      if (inSticky) { PR.stickyPatch(k ? { kind: k.dataset.k } : { color: col.dataset.color }); return true; }
      const n = noteById(nid);
      const ta = card.querySelector("textarea");
      const patch = k ? { kind: k.dataset.k } : { color: col.dataset.color };
      PR.saveNote(Object.assign({}, n, { body: ta ? ta.value.trim() : n.body }, patch));
      PR.applyMarks();
      rerender();
      return true;
    }
    if (nid && !card.classList.contains("editing") && e.target.closest(".body") && !e.target.closest("a, .reply, img") && !String(getSelection())) { rerender(); return true; }
    if (card.dataset.anchor && inPanel) { PR.goToAnchor(card.dataset.anchor); return true; }
    return false;
  };
  /* 跳到錨點：段落 id 跳正文；"page:N" 是只畫在 PDF 上的筆記，翻到那一頁 */
  PR.goToAnchor = function (a) {
    if (String(a).startsWith("page:")) PR.goToPage(+String(a).slice(5));
    else if (PR.pdfMain && PR.pdfMain() && !(PR.articleOpen && PR.articleOpen())) { const b = PR.blockById[a]; if (b && b.page) PR.goToPage(b.page, a); }  // 譯文收著：翻到那一段所在的頁
    else PR.jumpTo("b-" + a);
  };
  /* 翻到某一頁；跳得遠就留一個「回剛才那頁」 */
  PR.goToPage = function (n, blockId) {
    const from = PR.pdfPage ? PR.pdfPage() : n;
    PR.openPage(n, blockId);
    if (Math.abs(from - n) >= 2) PR.toast(PR.t("第 {page} 页", { page: n }), { label: PR.t("回第 {n} 頁", { n: from }), fn: () => PR.openPage(from) }, 5000);
  };
  document.addEventListener("click", (e) => { if (e.target.closest("#margin, .inline-notes, .pv-sticky, .pv-margin")) PR.cardClick(e, false); });

  /* AI 写的卡片：删除；回答类的还能重新回答（删掉旧的，再问一次） */
  async function delAgent(id, regen, btn) {
    const e = (S.discussion.entries || []).find((x) => x.id === id);
    if (!e) return;
    if (!regen && !(await PR.confirm({ title: PR.t("删除这条 AI 内容？"), body: PR.t("删了不能撤销。"), ok: PR.t("删除"), danger: true, at: btn }))) return;
    try {
      await PR.api("/api/p/" + PR.pid + "/discussion_del", { method: "POST", body: { id } });
    } catch (err) { return PR.toast(PR.t("删除失败：{msg}", { msg: PR.esc(err.message) })); }
    S.discussion.entries = S.discussion.entries.filter((x) => x.id !== id);
    PR.renderMargin(); PR.applyMarks();
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel();
    PR.renderSticky && PR.renderSticky();
    if (regen) PR.askModel(e.reply_to);
  }

  /* 卡片和段落互相高亮 */
  function link(card, on) {
    const host = document.getElementById("b-" + card.dataset.anchor);
    host && host.classList.toggle("linked", on);
    card.classList.toggle("linked", on);
    const sel = card.dataset.note ? 'mark[data-note="' + card.dataset.note + '"], [data-mirror="' + card.dataset.note + '"], .pv-mark[data-note="' + card.dataset.note + '"], .pv-area[data-note="' + card.dataset.note + '"]' : 'mark[data-card="' + card.dataset.card + '"]';
    PR.$$(sel).forEach((m) => m.classList.toggle("active", on));
  }
  document.addEventListener("mouseover", (e) => {
    const card = e.target.closest && e.target.closest("#margin .card, #notespanel .card, .pv-margin .card");
    if (card && !card.classList.contains("linked")) { PR.$$(".card.linked").forEach((c) => link(c, false)); link(card, true); }
    if (!card && e.target.closest && !e.target.closest("#margin, #notespanel, .pv-margin")) PR.$$(".card.linked").forEach((c) => link(c, false));
  });

  PR.flashCard = function (id) {
    const card = PR.$('.card[data-card="' + id + '"], .card[data-note="' + id + '"]');
    if (!card) return;
    if (!PR.marginWide()) { const host = card.closest(".blk"); host && host.classList.add("notes-open"); }
    card.classList.remove("new"); void card.offsetWidth; card.classList.add("new");
  };
})(window.PR);
