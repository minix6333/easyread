/* 文献库：列表、筛选、排序、键盘操作、状态轮询。 */
(function (PR) {
  "use strict";
  const L = (PR.lib = { items: [], view: "all", tag: null, q: "", sort: PR.ls.get("easyread-sort", "opened"), selected: null, engine: "claude", picked: new Set(), picking: false });
  const prefs = PR.ls.get("easyread-prefs", {});
  PR.applyTheme(prefs.theme);


  PR.$("#importBtn").innerHTML = PR.icon("plus");
  PR.$("#importBtn").title = PR.t("导入论文");
  PR.$("#settingsBtn").innerHTML = PR.icon("gear");
  /* 排序：一顆圖示鈕，底下疊一個看不見的 <select>（點了就是系統的選單） */
  PR.$("#sortBtn").insertAdjacentHTML("afterbegin", PR.icon("sort"));
  /* 「更多」：批次操作、深淺色、設定（頂欄只留常用的） */
  PR.$("#moreBtn").innerHTML = PR.icon("more");
  PR.$("#moreBtn").onclick = (e) => {
    const dark = document.documentElement.dataset.theme === "dark";
    PR.menu(e.currentTarget, [
      { label: PR.t("批量操作"), icon: "check", disabled: !L.items.length, fn: () => L.startPick() },
      "-",
      { label: dark ? PR.t("换成浅色") : PR.t("换成深色"), icon: dark ? "sun" : "moon", fn: () => PR.toggleTheme() },
      { label: PR.t("设置"), icon: "gear", kbd: "⌘,", fn: () => PR.openSettings() },
    ]);
  };
  PR.$(".search .si").outerHTML = PR.icon("search", "sm");
  PR.$("#sort").value = L.sort;
  /* 清單／格子（像 Craft 的檢視切換）：只是換個樣子，列還是同一批 */
  (function libView() {
    const seg = PR.$("#libView"); if (!seg) return;
    const paint = () => {
      const v = PR.ls.get("easyread-lib-view", "grid");  // 預設格子（像 Craft）
      PR.$("#list").classList.toggle("grid", v === "grid");
      PR.$$("button", seg).forEach((b) => b.classList.toggle("on", b.dataset.lv === v));
    };
    PR.$$("button", seg).forEach((b) => { b.innerHTML = PR.icon(b.dataset.lv === "grid" ? "grid" : "list", "sm"); b.title = b.dataset.lv === "grid" ? PR.t("格子") : PR.t("清單"); });
    /* 換檢視：封面從格子裡的大張縮成清單裡的小張、飛到新的位置（View Transitions，ui.js 的 PR.morph），其餘的字淡入淡出 */
    const names = () => {
      const out = [], vh = innerHeight, k = seg.querySelector(".seg-knob");
      if (k) out.push([k, "lv-knob"]);
      PR.$$("#list > .row").forEach((r) => {
        const t = r.querySelector(".thumb"), b = t && t.getBoundingClientRect();
        if (b && b.width && b.bottom > -80 && b.top < vh + 80) out.push([t, "lv-th-" + r.dataset.id, "thumb"]);
      });
      return out;
    };
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lv]");
      if (!b || b.classList.contains("on")) return;
      PR.ls.set("easyread-lib-view", b.dataset.lv);
      if (PR.morph) PR.morph(paint, { type: "lv-" + b.dataset.lv, names }); else paint();
    });
    paint();
  })();

  L.byId = (id) => L.items.find((i) => i.id === id);
  function readerUrl(id) {
    const main = PR.$(".main"), row = PR.$$(".row").find((r) => r.dataset.id === id);
    const bounds = main.getBoundingClientRect(), rect = row && row.getBoundingClientRect();
    const view = L.VIEWS.find((v) => v[0] === L.view) || L.VIEWS[0];
    return PR.libraryNav.readerUrl(id, {
      view: L.view, tag: L.tag, q: L.q, sort: L.sort, label: view[1],
      scroll: main.scrollTop,
      offset: rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom ? rect.top - bounds.top : null,
    });
  }
  L.openReader = (id) => { PR.navigate ? PR.navigate(readerUrl(id)) : (location.href = readerUrl(id)); };  // 在外殼裡：開成分頁（frame-bridge.js）
  function prepareReaderLink(e) {
    const link = e.target.closest("a[href]");
    if (!link || !link.closest("#detail, #side")) return;
    const match = (link.getAttribute("href") || "").match(/^\/read\/([a-zA-Z0-9_-]+)(?:\?|$)/);
    if (match) link.href = readerUrl(match[1]);
  }
  ["click", "auxclick", "contextmenu"].forEach((name) => document.addEventListener(name, prepareReaderLink, true));
  L.patch = async function (id, fields) {
    const it = L.byId(id);
    if (it) { Object.assign(it, fields.meta_override ? {} : fields); L.render(); }  // 先改界面，再存盘
    try { await PR.api("/api/p/" + id + "/item", { method: "POST", body: fields }); }
    catch (e) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) })); }
    await L.load();
  };

  let loadSeq = 0, loadDone = 0;
  L.load = async function () {
    if (L.loadNotes) L.loadNotes();  // 獨立筆記的清單、分類的圖示顏色（library/notes.js）
    const seq = ++loadSeq, d = await PR.api("/api/library");
    if (seq < loadDone) return;  // 比已經畫出來的那一份還舊（兩個請求前後腳、回來的順序反了）：不要蓋回去
    loadDone = seq;
    apply(d);
    if (d.library_status === "idle") L.tellDocs("paper", d.items.map((i) => i.id));
  };
  /* 外殼裡開著的分頁要和文獻庫對得上：文件、筆記不在了，開著它的分頁要跟著關（不然分頁列上留著一個打不開的）。
     - 在這裡刪的：刪成功就叫 L.docsGone，馬上關；
     - 別處刪的（別台刪了同步過來、另一個視窗）：輪詢的清單裡「上次還在、連續兩次都沒有」才算——
       只憑一次不算，免得清單剛好讀到一半、或一份比較舊的清單晚到，就把正在寫的筆記關掉；
     - 第一次拿到清單時整份交給外殼（docs）：上次開著、現在已經不在的分頁，一開 App 就收掉。 */
  const have = { paper: null, note: null }, absent = new Map();
  const tellShell = (msg) => { if (PR.framed) window.parent.postMessage(Object.assign({ easyread: true }, msg), location.origin); };
  L.tellDocs = function (kind, ids) {
    const cur = new Set(ids);
    if (!have[kind]) { have[kind] = cur; tellShell({ type: "docs", kind, ids }); return; }
    const gone = [];
    for (const id of have[kind]) {
      if (cur.has(id)) { absent.delete(id); continue; }
      if (absent.get(id)) { gone.push(id); absent.delete(id); } else { absent.set(id, 1); cur.add(id); }
    }
    have[kind] = cur;
    if (gone.length) tellShell({ type: "gone", ids: gone });
  };
  /* 刪掉的那幾列先淡出去（.leaving，craft.css），再把清單重畫：回傳一個淡完才好的 Promise */
  L.fadeOut = function (sel) {
    const els = PR.$$(sel);
    els.forEach((el) => el.classList.add("leaving"));
    return new Promise((done) => setTimeout(done, els.length ? 150 : 0));
  };
  L.docsGone = function (ids) {
    for (const id of ids) { absent.delete(id); if (have.paper) have.paper.delete(id); if (have.note) have.note.delete(id); }
    if (ids.length) tellShell({ type: "gone", ids });
  };
  function apply(d) {
    L.lastData = d;  // 切换界面语言前存一份，刷新后先拿它画列表，不闪空白（lang-toggle.js）
    PR.token = d.token;
    L.engine = d.engine;
    L.engineLabel = d.engine_label;
    L.firstRun = d.first_run;
    L.autoTranslate = !!d.auto_translate;
    L.version = d.version;
    L.trashCount = d.trash || 0;
    if (PR.libraryLocationNotice) PR.libraryLocationNotice(d);
    engineChip();
    // 多了、少了幾篇（匯入好了、刪掉、從回收站拿回來、別台同步過來）：重畫時其他卡片滑去補位、新的淡入（不是一下子全部跳過去）
    const ids = (list) => (list || []).map((i) => i.id).sort().join(",");
    if (L.items.length && ids(L.items) !== ids(d.items)) L.moveNext = true;
    L.items = d.items;
    L.render();
    schedule();
  }

  let pollT;
  function schedule() {
    clearTimeout(pollT);
    const busy = L.items.some((i) => i.job && ["queued", "running"].includes(i.job.state));
    pollT = setTimeout(() => L.load().catch(() => schedule()), busy ? 2500 : 15000);
  }

  function filtered() {
    const view = L.VIEWS.find((v) => v[0] === L.view) || L.VIEWS[0];
    const q = L.q.trim().toLowerCase();
    let list = L.items.filter(view[3]);
    if (L.tag) list = list.filter((i) => i.tags.includes(L.tag));
    if (q) list = list.filter((i) => [i.title_zh, i.title_en, i.authors, i.venue, i.arxiv, i.abstract, (i.tags || []).join(" "), i.year]
      .join(" ").toLowerCase().includes(q));
    const key = { opened: (i) => i.last_opened || i.added, added: (i) => i.added, year: (i) => String(i.year || ""), title: (i) => PR.titles(i).main };
    const k = key[L.sort] || key.opened;
    list.sort((a, b) => (L.sort === "title" ? String(k(a)).localeCompare(String(k(b)), "zh") : String(k(b)).localeCompare(String(k(a)))));
    return list;
  }
  L.filtered = filtered;

  function statusPill(i) {
    const m = { unread: PR.t("未读"), reading: PR.t("在读"), done: PR.t("已读") };
    return '<span class="pill ' + (i.status || "unread") + '">' + (m[i.status] || m.unread) + "</span>";
  }
  L.jobLine = function (i) {
    const j = i.job;
    if (j && j.state === "confirm") return '<span class="stat">' + PR.t("等你确认") + "</span>";
    if (j && ["queued", "running"].includes(j.state)) {
      const pct = j.total ? " " + PR.t("{done}/{total} 页", { done: j.done, total: j.total }) : "";
      return '<span class="stat job"><span class="spin"></span>' + PR.esc(j.state === "queued" ? PR.t("排队中") : (j.message || PR.t("处理中"))) + pct + "</span>";
    }
    if (j && j.state === "error") return '<span class="stat err">' + (j.read ? PR.t("整理原文出错") : PR.t("翻译出错")) + "</span>";
    if (j && j.state === "partial") return '<span class="stat err">' + (j.read ? PR.t("{n} 页没整理成功", { n: Object.keys(j.failed || {}).length }) : PR.t("{n} 页没译成功", { n: Object.keys(j.failed || {}).length })) + "</span>";
    const tr = i.done_pages - (i.en_pages || 0);
    if (i.en_pages && !tr) return '<span class="stat">' + PR.t("英文原文") + "</span>";
    if (i.pages && tr < i.pages) return '<span class="stat">' + PR.t("已译 {done}/{total} 页", { done: tr, total: i.pages }) + "</span>";
    return "";
  };

  function rowHtml(i) {
    const tt = PR.titles(i), title = tt.main;
    const sub = "";  // 卡片、清單只放原文標題（譯名在詳細資訊裡）
    const bits = [i.authors && PR.esc(i.authors.split(",").slice(0, 3).join(",") + (i.authors.split(",").length > 3 ? PR.t(" 等") : "")), i.year, i.venue || i.arxiv].filter(Boolean);
    const kind = i.kind && i.kind !== "paper" ? '<span class="chip kind">' + PR.esc(PR.kindName(i.kind)) + "</span>" : "";  // 投影片、講義標一下
    const tags = kind + (i.tags || []).map((t) => '<span class="chip cat">' + (L.catIcon ? L.catIcon(t) : PR.icon("folder", "sm")) + PR.esc(t) + "</span>").join("");
    // 縮圖有兩張：清單用整頁的小圖（--t），卡片用伺服器裁好的橫的封面（--c，covers.py）；用哪一張由 CSS 決定，沒用到的那張不會去載
    const kindTag = i.kind && i.kind !== "paper" ? '<span class="cv-kind">' + PR.esc(PR.kindName(i.kind)) + "</span>" : "";
    // 格子檢視：讀到哪裡是封面底邊一條細線（像書架上的書），下面那一排就只剩狀態和數字；清單檢視還是右邊那條
    const cvProg = i.progress ? '<i class="cv-prog" style="--p:' + Math.max(2, Math.round(i.progress * 100)) + '%"></i>' : "";
    const thumb = i.thumb ? '<div class="thumb" style="--t:url(' + i.thumb + ")" + (i.cover ? ";--c:url(" + i.cover + ")" : "") + '">' + kindTag + cvProg + "</div>" : '<div class="thumb blank">' + PR.icon("pdf") + cvProg + "</div>";
    const notes = i.notes + i.highlights ? '<span class="stat">' + PR.icon("note", "sm") + (i.notes + i.highlights) + (i.open_questions ? " · " + PR.t("{n} 问待答", { n: i.open_questions }) : "") + "</span>" : "";
    const prog = i.progress ? '<div class="meter" title="' + PR.t("阅读进度 {p}%", { p: Math.round(i.progress * 100) }) + '"><i style="width:' + Math.round(i.progress * 100) + '%"></i></div>' : "";
    const picked = L.picked.has(i.id);
    return '<div class="row' + (L.selected === i.id ? " on" : "") + (picked ? " picked" : "") + '" data-id="' + i.id + '" role="option" draggable="true"' + (L.picking ? ' aria-selected="' + picked + '"' : "") + ">" +
      '<span class="pick" data-pick title="' + PR.t("勾选（批量操作）") + '">' + PR.icon("check", "sm") + "</span>" + thumb +
      '<div class="row-main"><div class="t1">' + (i.starred ? '<span class="star">' + PR.icon("star") + "</span>" : "") + "<span>" + PR.esc(title) + "</span></div>" + sub +
      '<div class="t3">' + bits.map((b) => "<span>" + PR.esc(String(b)) + "</span>").join("<span>·</span>") + tags + "</div></div>" +
      '<div class="side-info">' + statusPill(i) + prog + L.jobLine(i) + notes + "</div></div>";
  }

  /* 清單換了內容但大部分還是同一批（L.moveNext：刪了、多了幾篇、換了排序）：重畫前記下每一張看得到的卡片在哪（照 data-id／data-note），
     重畫後同一張從舊位置滑到新位置、新出現的淡入。換分類、搜尋這種一天幾十次的不動（直接換）。 */
  const rowKey = (el) => (el.dataset.id ? "p" + el.dataset.id : el.dataset.note ? "n" + el.dataset.note : "");
  function rowsBefore() {
    if (!L.moveNext) return null;
    L.moveNext = false;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !document.body.animate) return null;
    const vh = innerHeight, at = new Map();
    PR.$$("#list > *").forEach((el) => {
      const k = rowKey(el), b = k && el.getBoundingClientRect();
      if (b && b.width && b.bottom > -120 && b.top < vh + 120) at.set(k, b);
    });
    return at;
  }
  function rowsAfter(at) {
    if (!at) return;
    const vh = innerHeight, ease = PR.spring(), dur = PR.dur();
    PR.$$("#list > *").forEach((el) => {
      const k = rowKey(el);
      if (!k) return;
      const a = el.getBoundingClientRect(), b = at.get(k);
      if (!(a.bottom > -120 && a.top < vh + 120) && !b) return;
      if (!b) { el.animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], { duration: 260, easing: "cubic-bezier(.23, 1, .32, 1)", delay: 80 }); return; }
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) el.animate([{ translate: dx + "px " + dy + "px" }, { translate: "0px 0px" }], { duration: dur, easing: ease });
    });
  }
  /* 換分類、換「全部／在讀…」：清單換成另一批，淡進來一下（一天點幾十次，所以只動透明度、很短） */
  L.listIn = function () {
    const el = PR.$("#list");
    if (el && el.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 170, easing: "ease-out" });
  };
  L.render = function () {
    const before = rowsBefore();
    PR.renderSide();
    // 「全部筆記」只列筆記；點了某個分類，那個分類裡的筆記排在論文前面（library/notes.js）
    const notesView = L.view === "notes" && !L.tag;
    const list = notesView ? [] : filtered();
    const notes = L.notesShown ? L.notesShown() : [];
    const view = L.VIEWS.find((v) => v[0] === L.view) || L.VIEWS[0];
    PR.$("#viewTitle").textContent = L.tag ? L.tag : notesView ? PR.t("筆記") : L.view === "all" ? PR.t("全部论文") : view[1];
    PR.$("#count").textContent = notesView ? PR.t("{n} 份", { n: notes.length }) : PR.t("{n} 篇", { n: list.length }) + (notes.length ? " · " + PR.t("{n} 份筆記", { n: notes.length }) : "");
    PR.renderBatch && PR.renderBatch(list);
    const el = PR.$("#list");
    el.classList.toggle("notes-view", notesView);
    if (document.body) document.body.classList.toggle("lib-notes", notesView);
    if (notesView) el.innerHTML = notes.length || !L.q.trim() ? L.noteCardsHtml(notes, !L.q.trim()) : emptyState("search", PR.t("沒有符合的筆記"), "");
    else el.innerHTML = (notes.length ? '<div class="list-sec">' + PR.t("筆記") + "</div>" + L.noteCardsHtml(notes, false) + (list.length ? '<div class="list-sec">' + PR.t("論文") + "</div>" : "") : "") +
      (list.length ? list.map(rowHtml).join("") : notes.length ? "" : emptyHtml());
    if (L.selected && !L.byId(L.selected)) L.select(null);
    else PR.renderDetail && PR.renderDetail();
    rowsAfter(before);
  };
  /* 空的時候（搜尋、分類裡沒有東西）：置中一顆淡淡的圖示、一句話；有搜尋字的話多一顆「清除搜尋」 */
  function emptyState(icon, title, hint) {
    return '<div class="empty-state"><div class="es-ic">' + PR.icon(icon) + '</div><div class="big">' + title + "</div>" + (hint ? '<div class="es-hint">' + hint + "</div>" : "") +
      (L.q.trim() ? '<button class="btn sm" data-clear-q>' + PR.t("清除搜尋") + "</button>" : "") + "</div>";
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest || !e.target.closest("[data-clear-q]")) return;
    L.q = ""; PR.$("#q").value = ""; L.render(); L.listIn && L.listIn();
  });
  function emptyHtml() {
    if (L.items.length) return emptyState(L.q.trim() ? "search" : "folder", PR.t("没有符合条件的论文"), PR.t("换个关键词或筛选试试。"));
    const ok = L.engineReady;
    return '<div class="welcome">' + PR.logo("hero") + "<h2>" + PR.t("把英文论文，读成舒服的中文") + "</h2>" +
      '<p class="sub">' + PR.t("导入 PDF，后台逐页翻译；公式、表格照原文排好，随时对照原文，边读边划线、记笔记、提问。") + "</p>" +
      '<ol class="steps">' +
      '<li class="' + (ok ? "done" : "") + '"><b>' + PR.t("选一个翻译引擎") + "</b><span>" + (ok === undefined ? '<span class="spin"></span> ' + PR.t("正在检测本机…") : ok ? PR.t("已就绪：{name}", { name: PR.esc(L.engineLabel) }) : PR.t("当前引擎还不能用，{hint}", { hint: L.engineHint || PR.t("去设置里选一个") })) + '</span><button class="btn sm ' + (ok ? "line" : "accent") + '" onclick="PR.openSettings()">' + (ok ? PR.t("换一个") : PR.t("去设置")) + "</button></li>" +
      "<li><b>" + PR.t("导入论文") + "</b><span>" + PR.t("拖进 PDF、粘贴 arXiv 链接，或者直接在这个页面按 Ctrl+V") + "</span>" +
      '<button class="btn sm accent" onclick="PR.openImport()">' + PR.icon("plus", "sm") + PR.t("导入") + "</button></li>" +
      '<li><b>' + PR.t("开始读") + "</b><span>" + PR.t("点段落出操作条，选中文字能划线、写笔记、提问；按 <kbd>?</kbd> 看快捷键") + "</span></li></ol>" +
      '<p class="try">' + PR.t("没有现成的论文？试试") + ' <button class="linkish" onclick="PR.importRef(&quot;1706.03762&quot;)">Attention Is All You Need</button></p></div>';
  }

  /* 顶栏上的引擎状态：一眼看出现在用什么翻译、能不能用 */
  async function engineChip() {
    const chip = PR.$("#engineChip");
    chip.innerHTML = '<span class="dot"></span><span>' + PR.esc(L.engineLabel || "") + "</span>";
    if (L.engineReady === undefined && !engineChip.pending) {
      engineChip.pending = true;
      const r = await PR.api("/api/engines").catch(() => null);
      engineChip.pending = false;
      L.engineReady = r ? r.ready : true;
      const f = r && r.found && r.found[L.engine];
      L.engineHint = f && !f.found ? PR.t("本机没找到 {name}", { name: L.engineLabel }) : L.engine === "openai" ? PR.t("API 还没填 Key") : "";
      L.render();
    }
    chip.classList.toggle("bad", L.engineReady === false);
    chip.title = L.engineReady === false ? PR.t("翻译引擎还不能用：{hint}（点这里设置）", { hint: L.engineHint || "" }) : PR.t("翻译引擎（点这里设置）");
    // 頂欄不放文字狀態：引擎不能用時設定的齒輪上一顆紅點，滑鼠提示說原因
    const gear = PR.$("#settingsBtn");
    gear.classList.toggle("bad", L.engineReady === false);
    gear.title = L.engineReady === false ? chip.title : PR.t("设置");
  }
  PR.$("#engineChip").onclick = () => PR.openSettings();

  /* 選一篇：只標出來；右邊的詳細資訊欄開著的話換成這一篇。選了不會再把欄打開——
     以前點一下卡片就多開一欄，整排卡片瞬間被擠到別的位置，要再點一次進去時滑鼠還得重新找（讀者回報過）。 */
  L.select = function (id) {
    L.selected = id;
    PR.$(".lib").classList.toggle("has-detail", !!id);
    PR.$$(".row").forEach((r) => r.classList.toggle("on", r.dataset.id === id));
    PR.renderDetail && PR.renderDetail();
  };

  /* ---------- 欄開合（寬視窗）的動畫 ----------
     版面一次換好（不做欄寬的動畫——以前卡片會在中途被擠壓、換行，一跳一跳的）：
     卡片、頂欄的標題從舊位置滑到新位置（PR.flip，只動 translate）；一整條有底色的（清單檢視那張紙、上面的提示條）邊緣跟著滑；
     欄自己（側欄、右欄）同一條曲線、同一段時間滑進滑出，看起來是欄把內容推開。
     shrink：內容區變窄（打開側欄、右欄）——卡片的舊位置在新版面會被切掉，所以在舊版面裡滑、滑完才換（hold）。 */
  L.relayout = function (change, opts) {
    opts = opts || {};
    const list = PR.$("#list"), grid = list.classList.contains("grid");
    const cards = grid ? PR.$$("#list > *") : [];
    const items = cards.concat(PR.$$("#importBtn, .list-head > *"));
    const edges = PR.$$(".main > *").filter((e) => e !== list || !grid);
    return PR.flip(items, change, { hold: opts.shrink ? opts.hold : null, edges, scale: cards, done: opts.done });
  };
  /* 不要動畫（視窗跨過寬窄的界線、一開頁）：欄的滑進滑出也跳過 */
  L.instant = function (change) {
    const lib = PR.$(".lib");
    lib.classList.add("lay-instant");
    change();
    lib.offsetWidth;
    requestAnimationFrame(() => lib.classList.remove("lay-instant"));
  };

  /* ---------- 右邊的詳細資訊欄：使用者自己開關（頂欄最右邊那顆、按 i） ----------
     寬視窗是一欄（記住開著還是關著，預設開著）；窄視窗是從右邊滑出來蓋在內容上的一塊，點外面、按 Esc 收回。 */
  const INSP_KEY = "easyread-lib-insp";
  const wideLib = matchMedia("(min-width: 1100px)");
  L.inspOpen = () => PR.$(".lib").classList.contains("insp-on");
  function syncInspBtn() {
    const b = PR.$("#inspBtn");
    if (b) { b.classList.toggle("on", L.inspOpen()); b.setAttribute("aria-pressed", String(L.inspOpen())); }
  }
  L.setInsp = function (open, opts) {
    opts = opts || {};
    const lib = PR.$(".lib");
    open = !!open;
    if (!opts.keep && wideLib.matches) PR.ls.set(INSP_KEY, open);
    if (L.inspOpen() === open) { syncInspBtn(); return; }
    const change = () => { lib.classList.toggle("insp-on", open); syncInspBtn(); if (open && PR.renderDetail) PR.renderDetail(); };
    if (opts.instant) L.instant(change);
    else if (!wideLib.matches) change();  // 窄視窗：蓋在內容上的一塊，CSS 自己滑進滑出
    else L.relayout(change, { shrink: open, hold: (on) => lib.classList.toggle("insp-hold", on) });
  };
  L.toggleInsp = () => L.setInsp(!L.inspOpen());
  (function initInsp() {
    const b = PR.$("#inspBtn");
    if (b) { b.innerHTML = PR.icon("panelright"); b.title = PR.t("詳細資訊（i）"); b.onclick = () => L.toggleInsp(); }
    const want = wideLib.matches && PR.ls.get(INSP_KEY, true) !== false;
    PR.$(".lib").classList.toggle("insp-on", want);
    syncInspBtn();
    wideLib.addEventListener("change", () => L.setInsp(wideLib.matches && PR.ls.get(INSP_KEY, true) !== false, { keep: true, instant: true }));
  })();

  function restoreReturn() {
    const state = PR.libraryNav.restore();
    if (!state) return;
    L.view = state.view === "notes" || L.VIEWS.some((v) => v[0] === state.view) ? state.view : "all";
    L.tag = state.tag && L.cats().includes(state.tag) ? state.tag : null;
    L.q = state.q;
    L.sort = ["opened", "added", "year", "title"].includes(state.sort) ? state.sort : "opened";
    PR.$("#q").value = L.q;
    PR.$("#sort").value = L.sort;
    L.selected = filtered().some((i) => i.id === state.paper) ? state.paper : null;
    PR.$(".lib").classList.toggle("has-detail", !!L.selected);  // 只是「有選著一篇」；欄開不開是 insp-on（使用者自己開關）
    L.render();
    requestAnimationFrame(() => {
      const main = PR.$(".main"), row = PR.$$(".row").find((r) => r.dataset.id === state.paper);
      main.scrollTop = state.scroll;
      if (!row) return;
      if (state.offset !== null) main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - state.offset;
      const rect = row.getBoundingClientRect(), bounds = main.getBoundingClientRect(), head = PR.$(".topbar");  // 清單從浮著的頂欄底下捲過去
      if (rect.top < bounds.top + head.offsetHeight || rect.bottom > bounds.bottom) row.scrollIntoView({ block: "center" });
      PR.$("#list").focus({ preventScroll: true });
    });
  }

  /* ---------- 事件 ---------- */
  /* 點一下選起來；已經選著的那篇再點一次就打開（雙擊也是——雙擊的第二下 detail 是 2，交給 dblclick，不會開兩次） */
  PR.$("#list").addEventListener("click", (e) => {
    const r = e.target.closest(".row");
    if (!r) return;
    if (L.selected === r.dataset.id && e.detail === 1 && !L.picking && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.target.closest("[data-pick], .pick")) {
      L.openReader(r.dataset.id);
      return;
    }
    if (e.detail <= 1) L.select(r.dataset.id);
  });
  /* 点列表空白处、侧栏、标题栏空白：取消選取（欄開著的話換成空的那一頁，版面不動）；窄視窗蓋在上面的那塊點外面就收 */
  document.addEventListener("click", (e) => {
    if (!wideLib.matches && L.inspOpen() && !e.target.closest("#detail, #inspBtn, .row, .dialog-backdrop, .menu, #toast")) L.setInsp(false, { keep: true });
    if (!L.selected || e.target.closest(".row, #detail, .dialog-backdrop, .menu, #toast, .topbar button, .topbar input, select")) return;
    if (e.target.closest(".main, .side, .topbar")) L.select(null);
  });
  PR.$("#list").addEventListener("dblclick", (e) => { const r = e.target.closest(".row"); if (r) L.openReader(r.dataset.id); });
  PR.$("#list").addEventListener("contextmenu", (e) => {
    const r = e.target.closest(".row");
    if (!r) return;
    e.preventDefault();
    L.select(r.dataset.id);
    PR.rowMenu && PR.rowMenu(r.dataset.id, { x: e.clientX, y: e.clientY });
  });
  PR.$("#q").addEventListener("input", PR.debounce((e) => { L.q = e.target.value; L.render(); }, 120));
  PR.$("#sort").addEventListener("change", (e) => { L.sort = e.target.value; PR.ls.set("easyread-sort", L.sort); L.moveNext = true; L.render(); });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable]")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (PR.$(".dialog-backdrop.open")) return;
    const rows = PR.$$(".row");
    const idx = rows.findIndex((r) => r.dataset.id === L.selected);
    if ((e.metaKey || e.ctrlKey) && PR.framed && e.key !== "/") return;  // 外殼裡 ⌘K、⌘T、⌘W… 是外殼的（frame-bridge.js 轉過去），這裡的單鍵快捷不要跟著動
    if (e.key === "/" || (e.key === "k" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); PR.$("#q").focus(); }
    else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); const r = rows[Math.min(rows.length - 1, idx + 1)]; if (r) { L.select(r.dataset.id); r.scrollIntoView({ block: "nearest" }); } }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); const r = rows[Math.max(0, idx - 1)]; if (r) { L.select(r.dataset.id); r.scrollIntoView({ block: "nearest" }); } }
    else if (e.key === "Enter" && L.selected) L.openReader(L.selected);
    else if (e.key === "Escape") { if (!wideLib.matches && L.inspOpen()) L.setInsp(false, { keep: true }); else L.select(null); }
    else if (e.key === "i" && !e.metaKey && !e.ctrlKey && !e.altKey) L.toggleInsp();
    else if (e.key === "s" && L.selected) { const it = L.byId(L.selected); L.patch(it.id, { starred: !it.starred }); }
  });

  PR.onSettingsSaved = () => L.load();
  // 从阅读页按“返回”回来时浏览器可能直接用缓存的旧页面：重新取一次，在读状态、进度马上更新
  window.addEventListener("pageshow", (e) => { if (e.persisted) L.load().then(restoreReturn).catch(() => {}); });
  // 等侧栏、详情这些脚本都加载完再取数据：数据先到、脚本还没到时会出错
  document.addEventListener("DOMContentLoaded", () => {
    const prefsReady = PR.loadPrefs().then((p) => { if (p.reader && p.reader.theme) PR.applyTheme(p.reader.theme); PR.useServerUi(p); L.useServerSide(p); }).catch(() => {});
    try {
      const snap = JSON.parse(sessionStorage.getItem("easyread-lib-snap") || "null");
      sessionStorage.removeItem("easyread-lib-snap");
      if (snap && Date.now() - snap.t < 15000) apply(snap.d);
    } catch (e) { /* 没有就等下面取 */ }
    Promise.all([prefsReady, L.load()]).then(restoreReturn).then(() => PR.painted && PR.painted()).catch((e) => { PR.$("#list").innerHTML = '<div class="empty-state"><div class="big">' + PR.t("连不上本地服务") + "</div>" + PR.esc(e.message) + "</div>"; });
  });
})(window.PR);
