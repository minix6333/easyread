/* PDF 優先的閱讀頁：PDF 是主畫面；譯文要看時按「譯文」才出現在右邊（開著時兩邊互相跟隨、點段落對到譯文），
   中間的分割線可拖，PDF 可縮放。頁碼和縮放放在頂欄正中間（和頂欄併成一條，多留一點高度給頁面）；
   右下角的浮動按鈕是框選、筆記、問 AI。筆記不佔版面：原文上只有標記和小圓點，點開是便利貼（sticky.js）。
   沒有譯文、譯到一半、翻譯失敗都一樣能讀、能畫、能問；翻譯的狀態和「翻譯／重試」在譯文按鈕的小框裡。
   版面偏好 layout：pdf（預設）/ article（上游原本的樣子：文章為主，原頁在右側面板）；還沒有任何譯文時一律是 PDF 優先。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;
  const root = document.documentElement;
  const KEY_W = "easyread-pdf-w";
  const MIN_PDF = 360, MIN_ART = 420;
  let artOpen = false;  // 譯文每次都從收著開始：要看的時候自己按「譯文」，不會自己跳出來
  let w = PR.ls.get(KEY_W, 0);

  const hasArticle = () => !!(S.paper && (S.paper.blocks || []).length);  // 沒整理、沒翻譯的 PDF：譯文面板沒東西
  PR.hasArticle = hasArticle;
  PR.pdfMain = () => (PR.prefs || {}).layout !== "article" || !hasArticle();
  PR.articleOpen = () => !PR.pdfMain() || artOpen;
  PR.pdfFocus = false;
  document.addEventListener("pointerdown", (e) => { PR.pdfFocus = !!(e.target.closest && e.target.closest("#pageview, .pv-head")); }, true);

  const sideW = () => { const p = PR.$("#notespanel"); return body.classList.contains("side-open") && p ? p.offsetWidth : 0; };
  /* PDF 的寬度：使用者拖的那個值，但譯文至少要留 MIN_ART；右邊還開著筆記／問 AI 時再讓一點。
     三欄怎麼都擠不下（視窗太窄）就先把譯文收起來，側面板關了再回來。回傳 [寬度, 譯文擠不擠得下] */
  function clampW() {
    const want = w || innerWidth * 0.56;
    const max = innerWidth - MIN_ART - sideW();
    const fits = !artOpen || max >= MIN_PDF;
    const v = Math.round(fits ? Math.max(MIN_PDF, Math.min(max, want)) : Math.max(MIN_PDF, Math.min(innerWidth - sideW(), want)));
    root.style.setProperty("--pdf-w", v + "px");
    return [v, fits];
  }

  /* PDF 面板變寬變窄（開關譯文、開側面板、拖分割線）時頁面高度跟著變：做完之後捲回原來看的那個位置 */
  function keepPlace(fn) {
    const sc = PR.$(".pv-scroll"), nodes = PR.pageNodes ? PR.pageNodes() : [];
    const entry = nodes[(PR.pdfPage ? PR.pdfPage() : 1) - 1];
    const top = (node) => node.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const node = entry && entry.node;
    const at = node && node.offsetHeight ? (sc.scrollTop + sc.clientHeight / 3 - top(node)) / node.offsetHeight : null;  // 視窗上三分之一處在這一頁的幾分之幾
    fn();
    if (at != null && node.offsetHeight) sc.scrollTop = Math.max(0, top(node) + at * node.offsetHeight - sc.clientHeight / 3);
  }
  PR.applyLayout = function () { keepPlace(applyLayoutNow); };
  function applyLayoutNow() {
    const pdf = PR.pdfMain();
    const [, fits] = clampW();
    body.classList.toggle("pdf-main", pdf);
    body.classList.toggle("art-open", pdf && artOpen && fits && hasArticle());
    root.style.setProperty("--pv-zoom", String((PR.prefs || {}).pdfZoom || 1));
    // 頁碼和縮放：PDF 優先時搬到頂欄正中間；文章優先（或視窗很窄）留在原頁面板頂上
    const head = PR.$(".pv-head"), bar = PR.$("#bar"), pv = PR.$("#pageview");
    if (head && bar && pv) {
      const host = pdf && innerWidth >= 900 ? bar : pv;
      if (head.parentNode !== host) host === bar ? bar.append(head) : pv.prepend(head);
    }
    const btn = PR.$('[data-act="pages"]');
    if (btn) {
      btn.innerHTML = PR.icon(pdf ? "book" : "page");
      btn.title = pdf ? (hasArticle() ? PR.t("譯文（O）") : PR.t("譯文：還沒有，點一下看怎麼翻譯")) : PR.t("PDF 原页，跟随阅读位置（O）");
      btn.classList.toggle("on", pdf ? artOpen && hasArticle() : PR.side === "pages");
      btn.disabled = false;
    }
    const lb = PR.$('[data-act="layout"]');
    if (lb) { lb.classList.toggle("on", !pdf); lb.hidden = !hasArticle(); lb.title = pdf ? PR.t("現在是 PDF 優先；點一下換成文章優先（L）") : PR.t("現在是文章優先；點一下換成 PDF 優先（L）"); }
    PR.$$(".pv-zoom-lbl").forEach((b) => (b.textContent = Math.round(((PR.prefs || {}).pdfZoom || 1) * 100) + "%"));
    const close = PR.$('[data-pv="close"]'), fl = PR.$(".pv-follow");
    if (close) close.hidden = pdf;
    if (fl) fl.hidden = pdf && !(artOpen && hasArticle());  // 跟隨：譯文開著才有意義
    PR.syncFabs && PR.syncFabs();
    markPageNote();
  }

  /* 開關譯文面板。PDF 是主畫面：打開時譯文跳到 PDF 正在看的那一段（opts.to 指定段落；quiet 不跳）。
     還沒有譯文：出一個小框說明狀況，可以在那裡開始翻譯／重試 */
  PR.toggleArticle = function (force, opts) {
    if (!hasArticle()) { artOpen = false; if (force !== false) PR.jobPopover(PR.$('[data-act="pages"]')); return; }
    const open = force != null ? !!force : !artOpen;
    if (open === artOpen) return;
    artOpen = open;
    PR.applyLayout();
    if (!open) return;
    PR.fitWide(); PR.renderMargin(); PR.layoutMargin && PR.layoutMargin();
    const to = (opts && opts.to) || (PR.pdfBlock && PR.pdfBlock());
    if (!(opts && opts.quiet) && to && PR.blockById[to]) PR.jumpTo("b-" + to, { noBack: true, instant: true });
  };
  PR.setLayout = function (mode) {
    const pdf = mode !== "article";
    if (!pdf && !hasArticle()) return PR.toast(PR.t("還沒有譯文，先用 PDF 讀"), null, 1800);
    PR.setPref("layout", pdf ? "pdf" : "article");
    if (pdf) { if (PR.side === "pages") PR.openSide(null); PR.syncPage && PR.syncPage(true); }
    else PR.togglePages(false);
    PR.toast(pdf ? PR.t("PDF 優先") : PR.t("文章優先"), null, 1400);
  };

  /* ---------- 翻譯的狀態和操作 ---------- */
  const post = (bodyObj, msg) => PR.api("/api/p/" + PR.pid + "/translate", { method: "POST", body: bodyObj }).then(() => { PR.hidePopover(); PR.toast(msg); PR.poll(); }).catch((e) => PR.toast(PR.esc(e.message)));
  PR.jobPopover = function (at) {
    if (!at) return;
    const j = S.job || {}, m = S.paper.meta || {}, tr = S.paper.translation || {};
    const total = (m.pages || []).length, done = (tr.done_pages || []).length;
    const running = ["queued", "running"].includes(j.state);
    const nFailed = j.state === "partial" ? Object.keys(j.failed || {}).length : 0;
    const lang = PR.targetName(m.target || PR.target);
    const b = (act, label, cls) => '<button class="btn sm ' + (cls || "line") + '" data-job="' + act + '">' + label + "</button>";
    let h = '<div class="hd">' + PR.t("譯文") + '</div><div class="job-pop">';
    if (j.state === "confirm" && PR.pageCapHtml) h += PR.pageCapHtml(j);
    else if (running) h += '<p><span class="spin"></span> ' + PR.esc(j.message || PR.t("翻译中")) + (j.total ? "　" + j.done + " / " + j.total : "") + "</p>";
    else if (!total) h += '<p><span class="spin"></span> ' + PR.t("正在渲染原页、抽取文字…") + "</p>";
    else h += "<p>" + (done >= total ? PR.t("全文 {n} 页", { n: total }) + PR.t("都譯好了。") : done ? PR.t("已译 {done} / {n} 页", { done, n: total }) : PR.t("這份文件還沒有譯文。不翻譯也可以照常閱讀、畫線、寫筆記、問 AI。")) + "</p>";
    if (!running && (nFailed || j.state === "error") && (j.error || j.message)) h += '<p class="err">' + PR.esc(j.error || j.message).replace(/\n/g, "<br>") + "</p>";
    h += '<div class="acts">';
    if (running) h += b("cancel", PR.t("取消"));
    else if (!PR.canAsk()) h += '<span class="hint">' + PR.t("還沒設定翻譯用的模型。") + "</span>";
    else if (j.state !== "confirm" && total) {
      if (nFailed) h += b("retry", PR.t("重試沒成功的 {n} 頁", { n: nFailed }), "accent");
      else if (done < total) h += b("go", PR.t("翻译成{lang}", { lang }), "accent");
      if (hasArticle()) h += b("open", PR.t("打開譯文"));
    }
    if (PR.store.mode === "server") h += '<span style="flex:1"></span>' + b("models", PR.t("模型设置"), "");
    h += "</div></div>";
    PR.popover(at, h, { sticky: true, wide: true });
    PR.$("#popover").onclick = (e) => {
      const cap = e.target.closest("[data-page-cap]");
      if (cap && PR.handlePageCap) return PR.handlePageCap(cap, PR.pid, S.job, () => { PR.hidePopover(); PR.poll(); });
      const act = (e.target.closest("[data-job]") || { dataset: {} }).dataset.job;
      if (act === "cancel") PR.api("/api/p/" + PR.pid + "/cancel", { method: "POST", body: {} }).then(() => { PR.hidePopover(); PR.poll(); });
      if (act === "retry") post({ failed: true }, PR.t("正在重试，译好后自动替换"));
      if (act === "go") post({ focus: PR.pdfPage ? PR.pdfPage() : undefined }, PR.t("已開始翻譯，譯好了按「譯文」看"));  // focus：正在看的這頁最先譯出來
      if (act === "open") { PR.hidePopover(); PR.toggleArticle(true); }
      if (act === "models") { PR.hidePopover(); PR.openSettings("chat"); }
    };
  };
  /* 翻譯進度變了：按鈕狀態跟著換；譯完說一聲（不自己打開譯文） */
  let wasRunning = false;
  PR.on("remote", (changed) => {
    if (!changed.includes("paper") && !changed.includes("job")) return;
    const running = ["queued", "running"].includes((S.job || {}).state);
    if (wasRunning && !running && PR.pdfMain() && hasArticle() && !artOpen) PR.toast(PR.t("譯文好了"), { label: PR.t("打開譯文"), fn: () => PR.toggleArticle(true) }, 6000);
    wasRunning = running;
    PR.applyLayout();
  });

  /* ---------- 分割線 ---------- */
  const grip = PR.el("div", { class: "split-grip", title: PR.t("拖動調整 PDF 與譯文的比例（連點兩下恢復）") });
  body.appendChild(grip);
  function relayout() { PR.fitWide(); PR.renderMargin(); PR.reloadPages && PR.reloadPages(); }
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    body.classList.add("resizing");
    // 拖的時候只動分割線本身（--pdf-w-live），放開才重排：每一格都重排幾頁的圖和文字框會一卡一卡
    let pending = 0, x = e.clientX;
    const paint = () => { pending = 0; root.style.setProperty("--pdf-w-live", Math.round(x) + "px"); };
    const move = (ev) => { x = ev.clientX; if (!pending) pending = requestAnimationFrame(paint); };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      if (pending) cancelAnimationFrame(pending);
      body.classList.remove("resizing");
      root.style.removeProperty("--pdf-w-live");
      keepPlace(() => { w = x; w = clampW()[0]; });
      PR.ls.set(KEY_W, w);
      relayout();
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  grip.addEventListener("dblclick", () => { keepPlace(() => { w = 0; PR.ls.set(KEY_W, 0); clampW(); }); relayout(); });
  window.addEventListener("resize", PR.debounce(() => PR.applyLayout(), 100));
  PR.on("ui-changed", () => PR.applyLayout());

  /* ---------- 縮放 ---------- */
  PR.setPdfZoom = function (z) {
    z = Math.round(Math.max(0.5, Math.min(4, z)) * 100) / 100;
    const scroller = PR.$(".pv-scroll");
    const yr = scroller.scrollTop / Math.max(1, scroller.scrollHeight), xr = scroller.scrollLeft / Math.max(1, scroller.scrollWidth);
    PR.prefs.pdfZoom = z;
    PR.applyPrefs();  // 會存偏好並呼叫 applyLayout（更新 --pv-zoom 和縮放標籤）
    scroller.scrollTop = yr * scroller.scrollHeight; scroller.scrollLeft = xr * scroller.scrollWidth;
    PR.reloadPages && PR.reloadPages();
  };
  /* 工具列和浮動按鈕的圖示（reader.html 裡只留空按鈕） */
  [["[data-pv='prev']", "back"], ["[data-pv='next']", "next"], ["[data-pv='zoom-out']", "zoomOut"], ["[data-pv='zoom-in']", "zoomIn"], ["[data-pv='pdf']", "download"], ["[data-pv='close']", "x"],
    ["[data-fab='region']", "region"], ["[data-fab='notes']", "notebook"], ["[data-fab='chat']", "sparkle"]].forEach(([sel, name]) => {
    const el = PR.$(sel);
    if (el) el.innerHTML = PR.icon(name, el.classList.contains("fab") ? "" : "sm");
  });
  const fl = PR.$(".pv-follow");
  if (fl) fl.insertAdjacentHTML("beforeend", PR.icon("follow", "sm"));
  PR.syncFabs = () => PR.$$("[data-fab]").forEach((f) => f.classList.toggle("on", f.dataset.fab === "region" ? !!(PR.regionMode && PR.regionMode()) : PR.side === f.dataset.fab));
  document.addEventListener("click", (e) => {
    const f = e.target.closest && e.target.closest("[data-fab]");
    if (f) {
      if (f.dataset.fab === "notes") PR.toggleNotesPanel();
      else if (f.dataset.fab === "chat") PR.toggleChat();
      else if (f.dataset.fab === "region") PR.toggleRegion && PR.toggleRegion();
      return;
    }
    const b = e.target.closest && e.target.closest("[data-pv]");
    if (!b) return;
    const z = (PR.prefs || {}).pdfZoom || 1;
    if (b.dataset.pv === "zoom-in") PR.setPdfZoom(z + (z >= 2 ? 0.5 : 0.25));
    if (b.dataset.pv === "zoom-out") PR.setPdfZoom(z - (z > 2 ? 0.5 : 0.25));
    if (b.dataset.pv === "zoom-fit") PR.setPdfZoom(1);
  });
  /* 鍵盤：游標在 PDF 這邊時 ← → PageUp PageDown 翻頁，= - 0 縮放（在正文那邊照舊是調字級） */
  document.addEventListener("keydown", (e) => {
    if (!PR.pdfMain() || !PR.pdfFocus || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("textarea, input, [contenteditable]")) return;
    const k = e.key;
    const z = (PR.prefs || {}).pdfZoom || 1;
    if (k === "ArrowLeft" || k === "PageUp") { e.preventDefault(); PR.pageStep(-1); }
    else if (k === "ArrowRight" || k === "PageDown") { e.preventDefault(); PR.pageStep(1); }
    else if (k === "=" || k === "+") { e.preventDefault(); e.stopImmediatePropagation(); PR.setPdfZoom(z + 0.25); }
    else if (k === "-" || k === "_") { e.preventDefault(); e.stopImmediatePropagation(); PR.setPdfZoom(z - 0.25); }
    else if (k === "0") { e.preventDefault(); e.stopImmediatePropagation(); PR.setPdfZoom(1); }
  });

  /* ⌘+ ⌘- ⌘0：縮放的是 PDF（不是整個視窗）；觸控板兩指縮放也一樣 */
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !PR.pdfMain()) return;
    const z = (PR.prefs || {}).pdfZoom || 1;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); PR.setPdfZoom(z + (z >= 2 ? 0.5 : 0.25)); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); PR.setPdfZoom(z - (z > 2 ? 0.5 : 0.25)); }
    else if (e.key === "0") { e.preventDefault(); PR.setPdfZoom(1); }
  }, true);
  let pinch = 0, pinchT = null;
  PR.$(".pv-scroll").addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !PR.pdfMain()) return;
    e.preventDefault();
    pinch += e.deltaY;
    if (pinchT) return;
    pinchT = setTimeout(() => { const z = (PR.prefs || {}).pdfZoom || 1; PR.setPdfZoom(z * Math.exp(-pinch * 0.012)); pinch = 0; pinchT = null; }, 40);
  }, { passive: false });

  /* 筆記的浮動按鈕：這一頁寫過筆記就亮一個點 */
  function markPageNote() {
    const fab = PR.$('[data-fab="notes"]');
    if (!fab) return;
    const n = PR.pdfPage ? PR.pdfPage() : 1;
    fab.classList.toggle("has-note", !!(((S.reader.page_notes || {})[n] || {}).body || "").trim());
  }
  PR.on("pages-built", (nodes) => {
    nodes.forEach((entry) => {
      new ResizeObserver(() => { entry.node.style.setProperty("--ph", entry.node.clientHeight + "px"); }).observe(entry.node);
    });
    PR.renderPdfMarks();
    markPageNote();
    ensureNear();
  });
  PR.$(".pv-scroll").addEventListener("scroll", PR.throttle(markPageNote, 200), { passive: true });
  /* 文字層按需鋪：只鋪看得到的頁和前後兩頁 */
  const ensureNear = PR.throttle(() => {
    const nodes = PR.pageNodes ? PR.pageNodes() : [];
    const p = PR.pdfPage ? PR.pdfPage() : 1;
    for (let n = Math.max(1, p - 2); n <= Math.min(nodes.length, p + 2); n++) if (!PR.hasTextLayer(n)) PR.buildTextLayer(nodes[n - 1], n);
  }, 150);
  PR.$(".pv-scroll").addEventListener("scroll", ensureNear, { passive: true });
  PR.on("text-layer", () => PR.renderPdfMarks());
  PR.on("reader", (op) => { if (op && op.op === "page_note") markPageNote(); });
  PR.on("remote", (changed) => { if (changed.includes("reader")) markPageNote(); });

  /* 第一次畫完：PDF 優先就翻到上次讀到的頁 */
  let started = false;
  PR.on("rendered", () => {
    if (started) { PR.applyLayout(); return; }
    started = true;
    wasRunning = ["queued", "running"].includes((S.job || {}).state);
    PR.applyLayout();
    if (!PR.pdfMain()) return;
    const p = (S.reader.progress || {}).page;
    setTimeout(() => PR.openPage(p && p > 1 ? p : 1), 50);
  });
})(window.PR);
