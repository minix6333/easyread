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
    const nav = PR.navWidth ? PR.navWidth() : 0;  // 左邊釘著的導覽欄（panels.js）：--pdf-w 是 PDF 那一格的右緣，左緣讓給它
    const want = w || innerWidth * 0.56;
    const max = innerWidth - MIN_ART - sideW();
    const fits = !artOpen || max >= nav + MIN_PDF;
    const v = Math.round(fits ? Math.max(nav + MIN_PDF, Math.min(max, want)) : Math.max(nav + MIN_PDF, Math.min(innerWidth - sideW(), want)));
    root.style.setProperty("--pdf-w", v + "px");
    return [v, fits];
  }

  /* 讀到哪裡：PDF 那一格變寬變窄（開關右側面板、導覽欄、譯文、拖分割線、視窗大小）時每一頁的高度跟著變，
     同一個捲動位置（像素）就不是原來那一段了。所以一邊捲一邊記「視窗上三分之一處在第幾頁的幾分之幾」（spot），
     頁面寬度一變就照它捲回去。不能在要改版面時才量——有的寬度是 CSS 跟著 class 直接變的（body.side-open），那時候量到的已經跑掉了。 */
  const topOf = (sc, node) => node.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  const pageW = () => { const n = PR.pageNodes ? PR.pageNodes() : []; return n.length ? n[0].node.offsetWidth : 0; };
  let spot = null, spotW = 0, spotHold = 0;
  /* at：畫面上的哪個高度（距捲動區頂端幾像素）；不給就是上三分之一處。縮放時給游標的位置——那一點要留在游標下 */
  function capture(at, top) {  // top：假設捲到這個位置（不給就是現在的位置）
    const sc = PR.$(".pv-scroll"), nodes = PR.pageNodes ? PR.pageNodes() : [];
    if (!sc || !nodes.length || !sc.clientHeight || !nodes[0].node.offsetHeight) return null;
    const y = (top == null ? sc.scrollTop : Math.max(0, Math.min(top, sc.scrollHeight - sc.clientHeight))) + (at == null ? sc.clientHeight / 3 : at);
    let i = 0;
    for (let lo = 0, hi = nodes.length - 1; lo <= hi;) {  // 最後一個頂端在 y 以上的頁
      const mid = (lo + hi) >> 1;
      if (topOf(sc, nodes[mid].node) <= y) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const node = nodes[i].node;
    return { i, frac: (y - topOf(sc, node)) / node.offsetHeight, at: at == null ? null : at };
  }
  function restore(s) {
    const sc = PR.$(".pv-scroll"), e = s && (PR.pageNodes ? PR.pageNodes() : [])[s.i];
    if (!sc || !e || !e.node.offsetHeight) return;
    sc.scrollTop = Math.max(0, topOf(sc, e.node) + s.frac * e.node.offsetHeight - (s.at == null ? sc.clientHeight / 3 : s.at));
  }
  function keepPlace(fn) {
    const s = spot || capture();
    fn();
    restore(s);
    spotW = pageW();
  }
  /* 程式自己要捲去某個位置（翻到某一頁、跳到某一段，pageview.js 的 showPage）時叫：馬上以那個位置為準。
     不能等捲動事件——它下一格才來，這中間要是版面寬度變了（跳頁的同時開了面板、釘了導覽欄），會照舊的位置捲回去，等於沒跳。
     smooth：平滑捲動途中的捲動事件不要把目標換掉（使用者自己動了滾輪就不管了，見下面） */
  PR.pdfSpotAt = function (top, smooth) {
    const s = capture(null, top);
    if (!s) return;
    spot = s; spotW = pageW();
    spotHold = smooth ? performance.now() + 700 : 0;
  };
  (function watchSpot() {
    const sc = PR.$(".pv-scroll");
    if (!sc) return;
    let raf = 0;
    // 縮放剛定好位置的那一下（spotHold）不換：那是程式捲的，換掉就變成記上三分之一處、不是游標那一點了
    sc.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (performance.now() < spotHold) return; const s = capture(); if (s) spot = s; }); }, { passive: true });
    // 使用者自己捲了（不是捏合縮放——那個是對著游標定位的）：馬上回到照實際位置記
    ["wheel", "touchstart", "pointerdown", "keydown"].forEach((t) => sc.addEventListener(t, (e) => { if (!e.ctrlKey) spotHold = 0; }, { passive: true }));
    if (!window.ResizeObserver) return;
    const ro = new ResizeObserver(() => {  // 版面已經排好、還沒畫出來：這時候捲回去，畫面上看不到跳
      const w = pageW();
      if (!w || w === spotW) return;
      spotW = w;
      restore(spot);
    });
    PR.on("pages-built", (nodes) => { ro.disconnect(); spot = null; spotW = 0; if (nodes && nodes[0]) ro.observe(nodes[0].node); });
    const have = PR.pageNodes ? PR.pageNodes() : [];
    if (have[0]) ro.observe(have[0].node);
  })();
  PR.applyLayout = function () { keepPlace(applyLayoutNow); };
  function applyLayoutNow() {
    const pdf = PR.pdfMain();
    const [, fits] = clampW();
    body.classList.toggle("pdf-main", pdf);
    body.classList.toggle("art-open", pdf && artOpen && fits && hasArticle());
    const zsc = PR.$(".pv-scroll");  // 縮放的變數掛在捲動區上，不掛 <html>：改它的時候只有 PDF 那幾頁重算
    if (zsc) zsc.style.setProperty("--pv-zoom", String((PR.prefs || {}).pdfZoom || 1));
    // 頁碼和縮放：一直留在 PDF 這一格裡，是底部正中的一顆膠囊（頂欄只放少數幾顆鈕，像 Craft 那樣空）
    const head = PR.$(".pv-head"), pv = PR.$("#pageview");
    if (head && pv && head.parentNode !== pv) pv.prepend(head);
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
    PR.renderPvMargin && PR.renderPvMargin();  // 縮放、開關面板後邊註欄擺不擺得下會變
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
    const to = (opts && opts.to) || (PR.pdfBlockNow ? PR.pdfBlockNow() : PR.pdfBlock && PR.pdfBlock());  // PDF 畫面中間那一段（「跟隨」關著也一樣對得到）
    if (!(opts && opts.quiet) && to && PR.blockById[to]) PR.jumpTo("b-" + to, { noBack: true, instant: true });
    // 寬公式重量（實測 140 ms）和邊注排版等譯文滑出來之後再做，先讓面板順順地滑；量完把剛才跳到的段落停回原位
    const node = to && document.getElementById("b-" + to);
    PR.afterSlide(() => {
      const top = node ? node.getBoundingClientRect().top : 0;
      PR.fitWide(); PR.renderMargin(); PR.layoutMargin && PR.layoutMargin();
      if (node) window.scrollBy(0, node.getBoundingClientRect().top - top);
    });
  };
  /* 換版面：換過去之後要停在同一個地方，而且是直接到位（不滑、不經過別頁）。
     - PDF 優先 → 文章優先：譯文跳到 PDF 畫面中間那一段；
     - 文章優先 → PDF 優先：PDF 翻到譯文正讀到的那一段。先量好再換——換過去譯文就收起來，量不到了。
       只是換過去看一眼又換回來（譯文幾乎沒捲、或剛才對到的那一段還在畫面中間）：PDF 留在原來那個位置，一格都不動。 */
  let artBlock = null, artY = null;  // 換到文章優先時譯文對到的那一段、當時捲到哪
  PR.setLayout = function (mode) {
    const pdf = mode !== "article";
    if (!pdf && !hasArticle()) return PR.toast(PR.t("還沒有譯文，先用 PDF 讀"), null, 1800);
    const was = PR.pdfMain();
    if (was === pdf) return;
    const from = was ? (PR.pdfBlockNow ? PR.pdfBlockNow() : null) : PR.readingBlock();
    const el = !was && artBlock && document.getElementById("b-" + artBlock), r = el && el.getBoundingClientRect();
    const stayed = !was && artY != null && (Math.abs(scrollY - artY) < innerHeight * 0.25 || (!!r && r.top < innerHeight * 0.75 && r.bottom > innerHeight * 0.2));
    PR.setPref("layout", pdf ? "pdf" : "article");
    if (pdf) {
      if (PR.side === "pages") PR.openSide(null);
      const b = PR.blockById[from], loc = b && S.layout[from];
      if (!stayed && b && PR.openPage) PR.openPage(loc ? loc.page : b.page, from, { instant: true });
      else if (!stayed && from === "head" && PR.openPage) PR.openPage(1, null, { instant: true });  // 譯文還在最上面的標題：第 1 頁
      artBlock = artY = null;
    } else {
      PR.togglePages(false);
      artBlock = from && PR.blockById[from] ? from : null;
      if (artBlock) PR.jumpTo("b-" + artBlock, { noBack: true, instant: true, noFlash: true });
      artY = scrollY;
    }
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
  /* 縮放要順。以前每一步都跑整套 applyPrefs：在 <html> 上改五六個 CSS 變數（整份文件——含開著的譯文——全部重算樣式）、
     寫 localStorage、存偏好、重排版面、重抓每一頁的圖，連按或捏合時一格要上百毫秒。現在分兩段：
     （1）手在動的時候只改捲動區自己的 --pv-zoom（只有 PDF 那幾頁重排）和縮放的數字，游標底下那一點不動；
     （2）手停 220 毫秒才收尾：存偏好、重算筆記欄放不放得下、換清晰度合適的圖。 */
  let zoomT = null;
  const zoomLabel = (z) => PR.$$(".pv-zoom-lbl").forEach((b) => (b.textContent = Math.round(z * 100) + "%"));
  PR.setPdfZoom = function (z, at) {
    z = Math.round(Math.max(0.5, Math.min(4, z)) * 100) / 100;
    const z0 = (PR.prefs || {}).pdfZoom || 1;
    if (z === z0) return;
    const sc = PR.$(".pv-scroll");
    // 定住的那一點：游標所在（捏合），沒有就用畫面上三分之一處
    const box = sc.getBoundingClientRect();
    const cx = at ? at.x - box.left : sc.clientWidth / 2, cy = at ? at.y - box.top : sc.clientHeight / 3;
    const first = sc.querySelector(".pv-page");
    const x0 = first ? first.offsetLeft : 0, w0 = first ? first.offsetWidth : 1;
    const fx = (sc.scrollLeft + cx - x0) / Math.max(1, w0);
    const s = capture(cy);  // 游標下的那一點：第幾頁的幾分之幾（以前用整份文件高度的比例算，頁和頁中間的空隙不跟著縮放，會漂一點）
    PR.prefs.pdfZoom = z;
    sc.style.setProperty("--pv-zoom", String(z));
    zoomLabel(z);
    const x1 = first ? first.offsetLeft : 0, w1 = first ? first.offsetWidth : 1;  // 讀一次版面（只有捲動區裡面重排）
    restore(s);
    if (sc.scrollWidth > sc.clientWidth + 1) sc.scrollLeft = Math.max(0, x1 + fx * w1 - cx);
    // 以這一點為準：等一下邊註欄擺不擺得下再變一次寬度時，照樣讓它留在游標下
    if (s) { spot = s; spotW = pageW(); spotHold = performance.now() + 500; }
    clearTimeout(zoomT);
    zoomT = setTimeout(() => { zoomT = null; PR.applyPrefs(); PR.reloadPages && PR.reloadPages(); }, 220);
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
    else if (k === " " && !(PR.keyAction && PR.keyAction(" "))) {  // 空白鍵往下捲一個畫面（⇧空白往上），和 PDF 閱讀器、瀏覽器一樣；自己把空白鍵設成別的快捷鍵的話照你的
      const sc = PR.$(".pv-scroll");
      e.preventDefault();
      if (sc) sc.scrollBy({ top: (e.shiftKey ? -1 : 1) * Math.round(sc.clientHeight * 0.88), behavior: "smooth" });
    }
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
  /* 捏合：一格畫面套一次（不是 40 毫秒一次），以手指中間那一點為中心 */
  let pinch = 0, pinchRaf = 0, pinchAt = null;
  PR.$(".pv-scroll").addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !PR.pdfMain()) return;
    e.preventDefault();
    pinch += e.deltaY;
    pinchAt = { x: e.clientX, y: e.clientY };
    if (pinchRaf) return;
    pinchRaf = requestAnimationFrame(() => {
      pinchRaf = 0;
      const z = (PR.prefs || {}).pdfZoom || 1, d = pinch;
      pinch = 0;
      PR.setPdfZoom(z * Math.exp(-d * 0.012), pinchAt);
    });
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

  /* 從別處指定要看哪裡：網址後面帶 #page=12（還可以加 &find=要標出來的詞）。全文搜尋的結果、筆記裡「出處」的連結都是這樣開過來的。
     用完就把它從網址上拿掉：同一個地方第二次再點才會再跳一次（網址沒變就不會有 hashchange）；重新整理也不會又跳回去 */
  function jumpFromHash() {
    const m = /^#(?:.*&)?page=(\d+)/.exec(location.hash || ""), f = /[#&]find=([^&]*)/.exec(location.hash || "");
    if (!m && !f) return 0;
    history.replaceState(history.state, "", location.pathname + location.search);
    const n = m ? Math.max(1, Math.min(PR.pageNodes ? PR.pageNodes().length || 1 : 1, +m[1])) : 0;
    if (n && PR.openPage) PR.openPage(n, null, { instant: true });
    let term = "";
    try { term = f ? decodeURIComponent(f[1]) : ""; } catch (e) { term = ""; }
    if (term && PR.openFind) setTimeout(() => PR.openFind(term), n ? 120 : 0);
    return n || -1;
  }
  PR.jumpFromHash = jumpFromHash;
  window.addEventListener("hashchange", () => { if (started) jumpFromHash(); });

  /* 第一次畫完：PDF 優先就翻到上次讀到的頁（閱讀進度和瀏覽器記的，取較新的）。
     頁面的圖和邊註欄還在陸續排好，位置會跑掉：之後再對幾次，讀者自己一捲就不管了 */
  let started = false;
  PR.on("rendered", () => {
    if (started) { PR.applyLayout(); return; }
    started = true;
    wasRunning = ["queued", "running"].includes((S.job || {}).state);
    PR.applyLayout();
    const asked = jumpFromHash();  // 指定了要看哪一頁：就去那一頁，不接著上次
    if (!PR.pdfMain()) return;
    const target = asked > 0 ? asked : (PR.lastPage && PR.lastPage()) || 1;
    let touched = false;
    const sc = PR.$(".pv-scroll");
    const mark = () => { touched = true; };
    ["wheel", "mousedown", "touchstart"].forEach((ev) => sc && sc.addEventListener(ev, mark, { passive: true, once: true }));
    document.addEventListener("keydown", mark, { once: true });
    document.addEventListener("mousedown", mark, { once: true, capture: true });  // 點了任何地方（筆記、回答裡的頁碼連結…）也算：讀者已經在動了，不要再把他拉回「上次那一頁」
    const go = () => { if (!touched && PR.pdfPage() !== target) PR.openPage(target, null, { instant: true }); };
    setTimeout(() => { if (!touched) PR.openPage(target, null, { instant: true }); }, 50);
    [350, 900, 1800].forEach((ms) => setTimeout(go, ms));
    if (target > 1 && !asked) setTimeout(() => { if (!touched) PR.toast(PR.t("接著上次：第 {page} 頁", { page: target }), null, 1800); }, 400);
  });
})(window.PR);
