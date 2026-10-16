/* 顶栏、阅读设置（字号/版心/行距用滑杆，= - 键也能调）、左侧抽屉（目录/术语/说明）、悬浮卡。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;

  /* ---------- 偏好 ---------- */
  const DEF = Object.assign({ theme: "auto", mode: "zh", lead: "translation", biOrder: "translation", layout: "pdf", pdfZoom: 1, night: "invert" }, PR.TYPE_DEFAULTS);
  /* 1.3.1 测试版存过 readingLanguage（zh / en），换成 lead；传进来的是存下的原样，还没合默认值 */
  PR.migratePrefs = function (p) {
    if (p.lead == null && p.readingLanguage != null) p.lead = p.readingLanguage === "en" ? "original" : "translation";
    if (p.biOrder == null && p.readingLanguage != null) p.biOrder = p.lead;
    delete p.readingLanguage;
    if (p.fontGen !== 2) {  // 這一版起內文預設用黑體（以前是宋體）：存過的偏好換一次，之後改回宋體就照你的
      if (p.font === "serif") p.font = "sans";
      p.fontGen = 2;
    }
    return p;
  };
  PR.prefs = Object.assign({}, DEF, PR.migratePrefs(PR.ls.get("easyread-prefs", {})));
  /* quiet：只套用、不存回伺服器。開頁面時用——那時候手上的是瀏覽器記的那一份（可能是舊的、甚至是空的＝全部預設值），
     伺服器存的要晚一點才拿得到；以前這裡照樣排進存檔，伺服器回得慢（剛開機、正在做圖）就會被這份舊的蓋掉，設定像被重設了一樣 */
  PR.applyPrefs = function (quiet) {
    PR.pullShared();  // 主題、外觀以 localStorage 為準（別格可能剛改過）：這一格記憶裡過期的值不能套回去、更不能存回去（util.js 的說明）
    const p = PR.prefs, root = document.documentElement;
    root.style.setProperty("--fs", p.fs + "px");
    root.style.setProperty("--lh", p.lh);
    // 問 AI、筆記卡片、邊註的字級跟著內文字級走（預設 21px 時是 1；只放大縮小到 0.85–1.35 倍，面板不會爆掉）
    root.style.setProperty("--fs-ratio", String(Math.round(Math.max(0.85, Math.min(1.35, (Number(p.fs) || 21) / 21)) * 100) / 100));
    root.style.setProperty("--measure", p.measure + "em");
    // 文章優先時右邊筆記欄的寬度（拖欄邊調的，見 margin.js；PDF 旁的那一欄由 pvmargin.js 管）：視窗放不下就自己縮
    if (Number(p.marginW) > 0) root.style.setProperty("--margin-w", "min(" + Math.round(p.marginW) + "px, calc(100vw - var(--gutter) - var(--measure) - var(--gap) - 24px))");
    else root.style.removeProperty("--margin-w");
    PR.applyTheme(p.theme);
    body.classList.toggle("font-sans", p.font === "sans");
    body.classList.toggle("font-serif", p.font === "serif");
    body.classList.toggle("font-round", p.font === "round");
    body.classList.toggle("mode-bi", p.mode === "bi");
    body.classList.toggle("no-margin", !p.margin);
    // 夜間的原頁圖：反相（預設）/ 調暗 / 原色（base.css 的 --night-filter）
    body.classList.toggle("night-dim", p.night === "dim");
    body.classList.toggle("night-none", p.night === "none");
    if (PR.applyReadingLanguage) PR.applyReadingLanguage();
    if (PR.applyLayout) PR.applyLayout();  // PDF 優先 / 文章優先（pdfmode.js）
    PR.ls.set("easyread-prefs", Object.assign(PR.migratePrefs(PR.ls.get("easyread-prefs", {})), p));
    if (!quiet && PR.store.mode === "server") PR.savePrefs("reader", p);
  };
  // 系統外觀變了由 util.js 處理（只有「跟隨系統」時重算主題）。以前這裡整個 applyPrefs 一次——連存檔一起，是換主題會閃個不停的一環
  PR.on("shared-prefs", () => { if (PR.$("#settings").classList.contains("open")) PR.renderSettings(); });
  // 改了設定之後重排。原頁那邊：PDF 優先時 PDF 是讀者自己在翻的，改設定不能動它；文章優先時右邊的原頁面板只在
  // 「譯文讀到的段落真的變了」才跟（syncPage(false)）。以前這裡不分情況硬對一次（true）：PDF 優先時每改一項設定 PDF 就被捲走——
  // 有譯文的捲到上次對到的那一段，沒譯文的一路滑回第 1 頁
  const relayout = PR.debounce(() => { PR.fitWide(); PR.renderMargin(); if (PR.syncPage && !(PR.pdfMain && PR.pdfMain())) PR.syncPage(false); }, 60);
  PR.setPref = function (k, v, quiet) {
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    const shared = PR.SHARED_PREFS.includes(k);
    if (shared) { const s = PR.ls.get("easyread-prefs", {}) || {}; s[k] = v; PR.ls.set("easyread-prefs", s); }  // 共用的先寫進 localStorage（applyPrefs 會從那裡拿回來）
    PR.prefs[k] = v;
    if (k === "theme" && PR.lookTransition) PR.lookTransition(() => PR.applyPrefs()); else PR.applyPrefs();  // 深淺色：整個畫面淡入淡出換過去
    if (shared) PR.flushPrefs();  // 換主題馬上存，別等 0.7 秒
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);  // 调字号时阅读位置不跳
    if (!quiet) PR.renderSettings();
    else syncSettings();
    relayout();
  };
  PR.bumpFont = (d) => { PR.setPref("fs", Math.min(28, Math.max(13, PR.prefs.fs + d)), true); PR.toast(PR.t("字号 {n} px", { n: PR.prefs.fs }), null, 900); };

  function segHtml(key, opts) {
    return '<div class="seg">' + opts.map(([v, label]) => '<button data-p="' + key + '" data-v="' + v + '" class="' + (String(PR.prefs[key]) === String(v) ? "on" : "") + '">' + label + "</button>").join("") + "</div>";
  }
  const pct = (v, min, max) => Math.round(((Number(v) - min) / (max - min)) * 100);
  function slider(key, label, min, max, step, unit) {
    // 和設定 → 外觀同一種滑桿（細軌道、白色圓鈕；--p 是填到哪裡）
    return '<div class="row slider"><span>' + label + '</span><input type="range" class="look-range" data-r="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + PR.prefs[key] + '" style="--p:' + pct(PR.prefs[key], min, max) + '%"><b data-rv="' + key + '">' + PR.prefs[key] + unit + "</b></div>";
  }
  PR.renderSettings = function () {
    PR.$("#settings").innerHTML =
      '<div class="row view-row-narrow">' + PR.viewSegHtml(true) + "</div>" +
      '<div class="row"><span>' + PR.t("版面") + "</span>" + segHtml("layout", [["pdf", PR.t("PDF 優先")], ["article", PR.t("文章優先")]]) + "</div>" +
      slider("fs", PR.t("字号"), 13, 28, 1, " px") + slider("measure", PR.t("版心"), 26, 50, 1, PR.t(" 字")) + slider("lh", PR.t("行距"), 1.5, 2.4, 0.05, "") +
      '<div class="row"><span>' + PR.t("字体") + "</span>" + segHtml("font", [["sans", PR.t("黑体")], ["round", PR.t("圓體")], ["serif", PR.t("宋体")]]) + "</div>" +
      '<div class="row"><span>' + PR.t("边注") + "</span>" + segHtml("margin", [[true, PR.t("显示")], [false, PR.t("收起")]]) + "</div>" +
      '<div class="row"><span>' + PR.t("外觀") + "</span>" + segHtml("theme", [["light", PR.t("浅色")], ["dark", PR.t("深色")], ["auto", PR.t("跟随系统")]]) + "</div>" +
      '<div class="row"><span>' + PR.t("夜間頁面") + "</span>" + segHtml("night", [["invert", PR.t("反相")], ["dim", PR.t("調暗")], ["none", PR.t("原色")]]) + "</div>" +
      '<div class="row hintrow"><button class="linkish" data-reset-type>' + PR.t("恢复默认") + '</button><span class="grow"></span>' +
      (PR.store.mode === "server" ? '<button class="linkish" data-open-settings="reading">' + PR.t("更多设置…") + "</button>" : "") + "</div>";
  };
  function syncSettings() {
    PR.$$("#settings [data-r]").forEach((r) => { r.value = PR.prefs[r.dataset.r]; r.style.setProperty("--p", pct(r.value, +r.min, +r.max) + "%"); });
    PR.$$("#settings [data-rv]").forEach((b) => { const k = b.dataset.rv; b.textContent = PR.prefs[k] + ({ fs: " px", measure: PR.t(" 字") }[k] || ""); });
  }
  PR.$("#settings").addEventListener("input", (e) => {
    const r = e.target.closest("[data-r]");
    if (r) { r.style.setProperty("--p", pct(r.value, +r.min, +r.max) + "%"); PR.setPref(r.dataset.r, +r.value, true); }
  });
  PR.$("#settings").addEventListener("click", (e) => {
    const os = e.target.closest("[data-open-settings]");
    if (os) { PR.$("#settings").classList.remove("open"); return PR.openSettings(os.dataset.openSettings); }
    if (e.target.closest("[data-reset-type]")) return PR.resetAllType();
    const view = e.target.closest("[data-view]");
    if (view) return PR.setView(view.dataset.view);
    const order = e.target.closest("[data-order]");
    if (order) return PR.setBiOrder(order.dataset.order);
    const b = e.target.closest("[data-p]");
    if (!b) return;
    let v = b.dataset.v;
    if (b.dataset.p === "margin") v = v === "true";
    if (b.dataset.p === "layout" && PR.setLayout) return PR.setLayout(v);
    PR.setPref(b.dataset.p, v);
  });
  /* 排版全部回到默认（主题不动）；opts 传进来就用它（设置里改过的默认值） */
  PR.resetAllType = function (vals) {
    Object.assign(PR.prefs, vals || PR.TYPE_DEFAULTS);
    PR.setPref("fs", PR.prefs.fs);
    if (!vals) PR.toast(PR.t("排版已恢复默认"), null, 1200);
  };
  PR.resetType = () => { ["fs", "measure", "lh"].forEach((k) => (PR.prefs[k] = DEF[k])); PR.setPref("fs", DEF.fs, true); PR.toast(PR.t("已恢复默认字号和版心"), null, 1200); };

  /* ---------- 顶栏 ---------- */
  PR.$("#backBtn").innerHTML = PR.icon("back");
  /* 在线演示：左上角回演示主页，顶栏多一个“在线演示”标记 */
  PR.setupDemo = function () {
    if (!S.demo) return;
    const back = PR.$("#backBtn");
    back.href = S.demo.home || "../"; back.title = PR.t("FOLI 主页"); back.style.display = "";
    const pill = PR.el("a", { class: "demo-pill", href: S.demo.repo, target: "_blank", rel: "noopener", title: PR.t("这是在线演示；在 GitHub 上免费下载，装到自己电脑") }, PR.t("在线演示<span> · 免费下载</span>"));
    PR.$("#bar .save-state").before(pill);
  };
  PR.$('[data-act="drawer"]').innerHTML = PR.icon("menu");
  /* 頂欄只放圖示（名字在滑鼠提示裡） */
  PR.$('[data-act="pages"]').innerHTML = PR.icon("page");
  PR.$('[data-act="pages"]').addEventListener("mouseenter", () => PR.preloadPage && PR.preloadPage());  // 鼠标移过去就开始加载
  PR.$('[data-act="notes"]').innerHTML = PR.icon("notebook");
  PR.$('[data-act="chat"]').innerHTML = PR.icon("sparkle");
  PR.$('[data-act="layout"]').innerHTML = PR.icon("panel");
  PR.$('[data-act="find"]').innerHTML = PR.icon("search");
  PR.$('[data-act="settings"]').innerHTML = PR.icon("type");
  /* 设置里关掉的功能：顶栏按钮也藏起来 */
  PR.applyFeatures = function () {
    const set = (sel, on) => { const el = PR.$(sel); if (el) el.style.display = on ? "" : "none"; };
    set('[data-act="pages"]', PR.feature("pages"));
    set('[data-act="chat"]', PR.feature("chat") && PR.chatView());
    if (!PR.feature("pages") && PR.side === "pages") PR.openSide(null);
    if (!PR.feature("chat") && PR.side === "chat") PR.openSide(null);
  };
  PR.on("ui-changed", () => { PR.applyFeatures(); PR.hideBlockbar && PR.hideBlockbar(); PR.renderMargin && PR.renderMargin(); });
  PR.$("#bar").addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (v) return PR.setView(v.dataset.view);
    if (e.target.closest("[data-order-menu]")) return PR.toggleOrderMenu();
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "drawer") PR.toggleNav();
    if (act === "pages") PR.togglePages();
    if (act === "layout" && PR.setLayout) PR.setLayout(PR.pdfMain && PR.pdfMain() ? "article" : "pdf");
    if (act === "notes") PR.toggleNotesPanel();
    if (act === "chat") PR.toggleChat();
    if (act === "settings") { PR.renderSettings(); PR.$("#settings").classList.toggle("open"); }
    if (act === "insp" && PR.toggleInspector) PR.toggleInspector();
    if (act === "about") PR.toggleDrawer(true, "about");
    if (act === "job" && PR.jobPopover) PR.jobPopover(a);
    if (act === "find" && PR.openFind) PR.findOpen() ? PR.closeFind() : PR.openFind();
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#settings, [data-act=settings]")) PR.$("#settings").classList.remove("open");
    if (!e.target.closest("#popover, a.cite, a.xref, mark.hl, .stale-tag, #blockbar, #jobState, [data-act=pages], #ctxmenu")) PR.hidePopover();
  });
  PR.on("status", ({ s, text }) => {
    const el = PR.$(".save-state");
    el.dataset.s = s;
    el.querySelector("span").textContent = text;
    el.title = s === "saved" ? PR.t("修改已写入 reader.json") : text;
  });
  /* 翻譯狀態：一顆小按鈕（進度或警示），點開是說明和「重試／取消」（pdfmode.js 的 jobPopover） */
  PR.renderJobState = function () {
    const j = S.job || {};
    const el = PR.$("#jobState");
    let html = "", title = "", cls = "";
    if (j.state === "confirm") { html = PR.icon("alert", "sm"); title = PR.t("等你确认"); }
    else if (["queued", "running"].includes(j.state)) { html = '<span class="spin"></span>' + (j.total ? "<span>" + j.done + "/" + j.total + "</span>" : ""); title = j.message || PR.t("翻译中"); }
    else if (j.state === "error") { html = PR.icon("alert", "sm"); cls = "err"; title = (j.read ? PR.t("整理原文出错") : PR.t("翻译出错")) + (j.error ? PR.t("：") + j.error : ""); }
    else if (j.state === "partial") { html = PR.icon("alert", "sm"); cls = "err"; const n = Object.keys(j.failed || {}).length; title = (j.read ? PR.t("{n} 页没整理成功", { n }) : PR.t("{n} 页没译成功", { n })) + (j.error ? PR.t("：") + j.error : ""); }
    el.innerHTML = html;
    el.title = title;
    el.className = "job-state" + (cls ? " " + cls : "");
    el.hidden = !html;
  };

  /* ---------- 導覽欄（目錄、頁面、術語、最近、說明） ---------- */
  /* PDF 優先、視窗放得下時是左邊釘著的一欄（body.nav-open，像 Craft 文件左邊那欄：PDF 那一格讓出位置，見 craft.css 的 --nav-now
     和 pdfmode.js 的 clampW；點目錄不會收）；放不下、或文章優先時是蓋在上面的抽屜（body.drawer-open，點一下目錄就收）。
     頂欄那顆鈕和 T 鍵：放得下就釘／收那一欄（記得住），放不下就開關抽屜。 */
  const NAV_W = 248, TABS = ["toc", "pages", "terms", "recent", "about"];
  let tab = TABS.includes(PR.ls.get("easyread-nav-tab", "toc")) ? PR.ls.get("easyread-nav-tab", "toc") : "toc";
  let pinned = !!PR.ls.get("easyread-nav", false), over = false;
  const inspW = () => { const p = PR.$("#notespanel"); return body.classList.contains("side-open") && body.classList.contains("insp-col") && p ? p.offsetWidth : 0; };
  // 釘成一欄之後，文件那一格至少還要有 640（開著譯文時 PDF＋譯文要 800）
  // 文件還沒載進來（剛開頁面的那一下）不算：那時候沒有目錄可以畫
  const navCol = () => !!S.paper && !!(PR.pdfMain && PR.pdfMain()) && !PR.chatOnly && !PR.notesOnly && innerWidth - inspW() - NAV_W >= (body.classList.contains("art-open") ? 800 : 640);
  const navShown = () => body.classList.contains("nav-open") || body.classList.contains("drawer-open");
  PR.navWidth = () => (body.classList.contains("nav-open") ? NAV_W : 0);
  let navT = 0;
  /* redraw：內容要重畫（自己按了開關、換了分頁）。別的原因叫進來的（版面的 class 變了、視窗大小變了）只在「剛出現」時畫一次——
     不然每次開關右側面板都把整欄重畫一遍：縮圖閃一下、術語表打到一半的字也沒了 */
  function syncNav(redraw) {
    if (!S.paper) return;  // 文件載好才動（開頁面時 body 的 class 就在變，那時候來叫的先不理；載好之後 rendered／pages-built 會再叫）
    const col = navCol(), was = body.classList.contains("nav-open"), shown = navShown(), now = col && pinned;
    body.classList.toggle("nav-col", col);
    body.classList.toggle("nav-open", now);
    body.classList.toggle("drawer-open", !col && over);
    const b = PR.$('[data-act="drawer"]');
    if (b) b.classList.toggle("on", now);
    if (was !== now && PR.applyLayout) {  // PDF 那一格變寬變窄：重新分配寬度、停在原來看的地方；頁面的圖等滑完再照新寬度換
      PR.applyLayout();
      clearTimeout(navT);
      navT = setTimeout(() => { PR.reloadPages && PR.reloadPages(); PR.renderPvMargin && PR.renderPvMargin(); }, 280);
    }
    if (navShown() && (redraw || !shown)) PR.renderDrawer();
  }
  PR.toggleNav = function () {
    if (!navCol()) { over = !over; syncNav(true); return; }  // 蓋在上面的抽屜：CSS 自己滑
    // 釘著的一欄：PDF 那一格要讓位——頁面從舊的位置、大小滑到新的（PR.flipLayout，見 pageview.js）
    pinned = !pinned;
    PR.ls.set("easyread-nav", pinned);
    over = false;
    if (PR.flipLayout && PR.sideMotion !== false) PR.flipLayout(() => syncNav(true));
    else syncNav(true);
  };
  /* 舊的入口：打開某一頁（說明…）、Esc 或跳走之後收起來。釘著的那一欄不會被 force=false 收掉 */
  PR.toggleDrawer = function (force, which) {
    if (which && TABS.includes(which)) tab = which;
    if (navCol()) {
      if (force === true && !pinned) { pinned = true; PR.ls.set("easyread-nav", true); }
      else if (force == null) { pinned = !pinned; PR.ls.set("easyread-nav", pinned); }
    } else over = force != null ? !!force : !over;
    syncNav(force !== false);
  };
  PR.$("#scrim").onclick = () => PR.toggleDrawer(false);
  const TAB_ICON = { toc: "list", pages: "grid", terms: "type", recent: "clock", about: "info" };
  PR.$$(".drawer-tabs [data-tab]").forEach((b) => { b.innerHTML = PR.icon(TAB_ICON[b.dataset.tab], "sm"); });
  if (PR.store.mode !== "server") PR.$('[data-tab="recent"]').hidden = true;  // 离线单文件版没有文献库
  PR.$(".drawer-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; PR.ls.set("easyread-nav-tab", tab); PR.renderDrawer(); } });
  // 版面變了（開關右側面板、譯文、換版面）、視窗大小變了：放不放得下重新算
  new MutationObserver(() => syncNav(false)).observe(body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", PR.debounce(() => syncNav(false), 120));
  // 文件載好、畫好了：上次釘著的欄這時候才出來，內容照現在的文件畫。
  // 2.1.0-tw.5 沒等：釘著欄再開文件，文件還沒載進來就去畫（出錯），之後又以為「已經出現過」不再畫，欄是空的
  PR.on("pages-built", () => setTimeout(() => syncNav(true), 0));
  PR.on("rendered", () => syncNav(true));

  PR.renderDrawer = function () {
    if (!S.paper) return;
    const m = S.paper.meta || {}, n = (m.pages || []).length, first = (m.pages || [])[0];
    // 「頁面」：還沒有頁面圖時不出現；文章優先時點縮圖開的是右邊的原頁面板，那個功能關了也不出現
    const pg = PR.$('.drawer-tabs [data-tab="pages"]');
    if (pg) pg.hidden = !n || (!(PR.pdfMain && PR.pdfMain()) && PR.feature && PR.feature("pages") === false);
    if (pg && pg.hidden && tab === "pages") tab = "toc";
    PR.$$(".drawer-tabs button").forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    const doc = PR.$(".nav-doc");
    const head = (first ? '<i class="nd-thumb" style="background-image:url(' + thumbUrl(first) + ')"></i>' : "") + "<span><b>" + PR.esc(m.short_zh || m.title_zh || m.title_en || "") + "</b>" +
      (n ? "<small>" + PR.t("{n} 页", { n }) + "</small>" : "") + "</span>";
    if (doc && doc._html !== head) { doc._html = head; doc.innerHTML = head; }
    const box = PR.$(".drawer-body"), keep = box.className === "drawer-body " + tab ? box.scrollTop : 0;
    // 欄釘著的時候，別處一有變動（畫了線、背景同步）就會叫這裡重畫：正在術語表裡打字就先不動，免得字和游標不見
    if (keep !== 0 || box.className === "drawer-body " + tab) { const a = document.activeElement; if (a && box.contains(a) && a.matches("input, textarea")) return; }
    box.innerHTML = ({ toc: tocHtml, pages: pagesHtml, terms: termsHtml, about: aboutHtml, recent: recentHtml })[tab]();
    box.className = "drawer-body " + tab;
    box.scrollTop = keep;
    if (tab === "pages" && !keep) { const on = PR.$(".np-thumb.on", box); if (on) on.scrollIntoView({ block: "center" }); }
  };
  /* PDF 優先時「現在在哪一節」：照 PDF 捲到的位置算（畫面四成高的地方在第幾頁的幾分之幾），往回找最近的標題。
     不靠「正在讀哪一段」——那要捲動時跟隨開著才會更新，剛開啟、或關了跟隨就不準 */
  function pdfHeading() {
    const sc = PR.$(".pv-scroll"), nodes = PR.pageNodes ? PR.pageNodes() : [];
    const page = PR.pdfPage ? PR.pdfPage() : 1, e = nodes[page - 1];
    let frac = 0.5;
    if (sc && e) { const r = e.node.getBoundingClientRect(), box = sc.getBoundingClientRect(); frac = (box.top + sc.clientHeight * 0.4 - r.top) / Math.max(1, r.height); }
    let cur = null;
    for (const h of PR.headings || []) {
      const loc = S.layout[h.id] || {}, pg = loc.page || (PR.blockById[h.id] || {}).page;
      if (!pg) continue;
      const y = loc.box ? loc.box[1] : loc.boxes && loc.boxes[0] ? loc.boxes[0][1] : 0;
      if (pg < page || (pg === page && y <= frac)) cur = h.id; else break;
    }
    return cur;
  }
  const headingNow = () => (PR.pdfMain && PR.pdfMain() ? pdfHeading() : PR.currentHeading && PR.currentHeading());
  /* 捲動時只換「現在在哪」的記號（不整個重畫）：目錄是目前這一節，頁面是目前這一頁 */
  PR.navMark = function () {
    if (!navShown()) return;
    const box = PR.$(".drawer-body");
    if (tab === "toc") {
      const cur = headingNow();
      PR.$$("a[data-go]", box).forEach((a) => {
        const on = a.dataset.go === cur;
        if (on && !a.classList.contains("on") && !box.matches(":hover")) a.scrollIntoView({ block: "nearest" });
        a.classList.toggle("on", on);
      });
    } else if (tab === "pages") {
      const n = String(PR.pdfPage ? PR.pdfPage() : 1);
      PR.$$("[data-go-page]", box).forEach((b) => {
        const on = b.dataset.goPage === n;
        if (on && !b.classList.contains("on") && !box.matches(":hover")) b.scrollIntoView({ block: "nearest" });  // 滑鼠在欄裡時不要自己捲走
        b.classList.toggle("on", on);
      });
    }
  };
  const pvsc = PR.$(".pv-scroll");
  if (pvsc) pvsc.addEventListener("scroll", PR.throttle(() => PR.navMark(), 160), { passive: true });
  const thumbUrl = (p) => PR.imageUrl(p.img) + (PR.store.mode === "server" ? "?w=400&v=2" : "");  // v：見 pageview.js 的 srcOf
  /* 頁面：兩欄縮圖（要用到才載入）；有筆記、畫線的頁右下角有它們的顏色 */
  function pagesHtml() {
    const pages = (S.paper.meta || {}).pages || [], cur = PR.pdfPage ? PR.pdfPage() : 1, marks = {};
    for (const nt of Object.values(S.reader.notes || {})) {
      if (!nt || nt.deleted) continue;
      const pg = (nt.side === "pdf" && nt.page) || ((S.layout[nt.anchor] || {}).page) || ((PR.blockById[nt.anchor] || {}).page);
      if (pg) (marks[pg] = marks[pg] || []).push(nt.color || "yellow");
    }
    if (!pages.length) return '<p class="hint">' + PR.t("正在渲染原页、抽取文字…") + "</p>";
    return '<div class="nav-pages">' + pages.map((p, i) => {
      const n = i + 1, cs = Array.from(new Set(marks[n] || [])).slice(0, 4);
      return '<button class="np-thumb' + (n === cur ? " on" : "") + '" data-go-page="' + n + '" title="' + PR.t("第 {page} 页", { page: n }) + '"><span class="pg" style="aspect-ratio:' + (p.w || 612) + "/" + (p.h || 792) + '"><img loading="lazy" decoding="async" alt="" src="' + thumbUrl(p) + '"></span>' +
        "<small>" + n + (cs.length ? '<i class="dots">' + cs.map((c) => '<i class="dot-' + PR.esc(c) + '"></i>').join("") + "</i>" : "") + "</small></button>";
    }).join("") + "</div>";
  }
  /* 最近读过的论文：不用回文献库就能换一篇 */
  let recent = null;
  function recentHtml() {
    if (!recent) {
      PR.api("/api/library").then((d) => { recent = d.items.filter((i) => i.last_opened).sort((a, b) => String(b.last_opened).localeCompare(String(a.last_opened))).slice(0, 15); if (tab === "recent") PR.renderDrawer(); })
        .catch(() => { recent = []; });
      return '<p class="hint">' + PR.t("加载中…") + "</p>";
    }
    return '<nav class="toc recent-list">' + recent.map((i) => '<a href="/read/' + i.id + '" class="l1' + (i.id === PR.pid ? " on" : "") + '"><span class="t">' +
      PR.esc(i.short_zh || i.title_zh || i.title_en || PR.t("（未命名）")) + '</span><span class="cnt">' + (i.progress > 0.02 ? Math.round(i.progress * 100) + "%" : "") + "</span></a>").join("") + '</nav><a class="btn sm line" href="/" style="margin-top:12px">' + PR.t("打开文献库") + "</a>";
  }
  function countByHeading() {
    const counts = {};
    let cur = "head";
    for (const b of S.paper.blocks || []) {
      if (b.type === "heading" || b.type === "references") cur = b.id;
      const n = ((PR.noteGroups || {})[b.id] || []).length;
      if (n) counts[cur] = (counts[cur] || 0) + n;
    }
    return counts;
  }
  function tocHtml() {
    const counts = countByHeading();
    const cur = headingNow();
    let html = '<nav class="toc">', app = false;
    for (const h of PR.headings) {
      if (h.appendix && !app) { html += '<div class="group">' + PR.t("附录") + "</div>"; app = true; }
      html += '<a href="#b-' + h.id + '" data-go="' + h.id + '" class="' + (h.level === 2 ? "l2" : "l1") + (cur === h.id ? " on" : "") + '">' +
        '<span class="n">' + PR.esc(h.num || "") + '</span><span class="t">' + PR.esc(PR.plain(PR.textFor(h.id) || h.zh)) + "</span>" + (counts[h.id] ? '<span class="cnt">' + counts[h.id] + "</span>" : "") + "</a>";
    }
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const miss = ((S.paper.meta || {}).pages || []).filter((p) => !done.has(p.n));
    if (miss.length) html += '<div class="group">' + ((S.job || {}).read || (S.paper.translation || {}).en_pages?.length ? PR.t("还没整理的页") : PR.t("未译的页")) + '</div>' + miss.map((p) => '<a href="#orig-' + p.n + '" data-go-orig="' + p.n + '" class="l1"><span class="n"></span><span class="t">' + PR.t("原文第 {n} 页", { n: p.n }) + "</span></a>").join("");
    return html + "</nav>";
  }
  function termsHtml() {
    const g = S.paper.glossary || [];
    return '<p class="hint" style="margin:0 0 10px">' + PR.t("译法不合心意？改右边的译法，再点“替换”，会把正文里的旧译法换成新的（记为你的修改，公式不动，随时可在段落右键“恢复译者稿”）。") + "</p>" +
      (g.length ? '<table class="terms-t">' + g.map((t, i) => "<tr><td>" + PR.esc(t.en) + '</td><td><input class="input term-in" data-i="' + i + '" value="' + PR.esc(t.zh) + '"></td><td><button class="btn sm line" data-term="' + i + '">' + PR.t("替换") + "</button></td></tr>").join("") + "</table>" : '<p class="hint">' + PR.t("这篇论文还没有术语表。") + "</p>") +
      '<div class="term-free"><div class="hint" style="margin:14px 0 6px">' + PR.t("任意替换") + '</div><div style="display:flex;gap:6px"><input class="input" id="tFrom" placeholder="' + PR.t("原译法") + '"><input class="input" id="tTo" placeholder="' + PR.t("新译法") + '"><button class="btn sm line" data-term="free">' + PR.t("替换") + "</button></div></div>";
  }
  function aboutHtml() {
    const tr = S.paper.translation || {};
    const m = S.paper.meta || {};
    const pdf = PR.pdfUrl(1);
    const status = S.demo ? PR.t("这是 FOLI 的在线演示。你在这里做的划线和笔记只存在这个浏览器里，别人看不到。装到自己电脑上，就能导入任意论文、后台翻译、边读边问 AI。")
      : PR.store.mode === "server"
      ? PR.t("你改的译文、笔记、划线写进论文目录的 reader.json（每次保存记日志，每 10 分钟留快照）。翻译方只写 paper.json 和 discussion.json，不会覆盖你的内容。")
      : PR.t("这是离线单文件版：修改只存在当前浏览器里。要把修改带回文献库，点“导出我的修改”得到一个 JSON，再运行 easyread merge。");
    const en = (tr.en_pages || []).length, done = (tr.done_pages || []).length;
    return '<div class="about"><h3>' + (en ? PR.t("英文原文") : PR.t("译文")) + "</h3><p>" + (en ? PR.t("{done} / {n} 页，其中 {en} 页没有翻译。", { done, n: (m.pages || []).length, en }) : PR.t("{done} / {n} 页。", { done, n: (m.pages || []).length })) + PR.esc(tr.note || "") + "</p>" +
      "<h3>" + PR.t("保存") + "</h3><p>" + status + "</p>" + (PR.store.pending ? "<p>" + PR.t("还有 {n} 条修改在等待写入。", { n: PR.store.pending }) + "</p>" : "") +
      '<div class="row">' + (pdf ? '<a class="btn sm line" href="' + pdf + '" target="_blank" rel="noopener">' + PR.t("打开原 PDF") + "</a>" : "") +
      '<button class="btn sm line" data-x="md">' + PR.t("导出笔记…") + "</button>" + (PR.store.mode === "static" && !S.demo ? '<button class="btn sm line" data-x="ops">' + PR.t("导出我的修改") + "</button>" : "") + "</div>" +
      "<h3>" + PR.t("怎么用") + "</h3><p>" + PR.t("在 PDF 上選字：畫線、寫筆記、翻譯、問 AI。選不到字的圖和投影片用右下角的框選。筆記收起來是一顆小圓點，點它打開。上課時開筆記面板的「本頁」，跟著頁面邊聽邊打。") + "</p>" +
      "<h3>" + PR.t("快捷键") + "</h3>" + (PR.keysOn
        ? '<div class="keyrows">' + PR.KEY_ACTIONS.filter(([id, , , , need]) => PR.keymap[id] && (!need || PR.feature(need))).map(([id, label]) => "<kbd>" + PR.esc(PR.keyOf(id)) + "</kbd><span>" + label + "</span>").join("") +
          "<kbd>1–8</kbd><span>" + PR.t("選字之後：八種顏色的畫線") + "</span><kbd>Esc</kbd><span>" + PR.t("关闭面板、取消选中") + "</span></div>" + PR.shortcutRows()
        : "<p>" + PR.t("快捷键已关闭。") + "</p>") +
      '<button class="btn sm line" data-x="keys">' + PR.t("设置快捷键和功能") + "</button></div>";
  }
  PR.$("#drawer").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) {
      e.preventDefault(); PR.toggleDrawer(false);
      const id = go.dataset.go;
      if (PR.pdfMain && PR.pdfMain()) {  // PDF 優先：翻到那一節所在的頁、框出那一段（以前只捲譯文，譯文收著時點了沒反應）
        const pg = (S.layout[id] || {}).page || (PR.blockById[id] || {}).page;
        if (pg) PR.openPage(pg, id);
        if (PR.articleOpen()) PR.jumpTo("b-" + id);
      } else PR.jumpTo("b-" + id);
      setTimeout(() => PR.navMark(), 60);
      return;
    }
    const og = e.target.closest("[data-go-orig]");
    if (og) {
      e.preventDefault(); PR.toggleDrawer(false);
      if (PR.pdfMain && PR.pdfMain()) PR.openPage(+og.dataset.goOrig); else PR.jumpTo("orig-" + og.dataset.goOrig);
      return;
    }
    const gp = e.target.closest("[data-go-page]");
    if (gp) { PR.toggleDrawer(false); PR.openPage(+gp.dataset.goPage, null, { instant: Math.abs(+gp.dataset.goPage - (PR.pdfPage ? PR.pdfPage() : 1)) > 3 }); setTimeout(() => PR.navMark(), 60); return; }
    const t = e.target.closest("[data-term]");
    if (t) {
      let from, to;
      if (t.dataset.term === "free") { from = PR.$("#tFrom").value.trim(); to = PR.$("#tTo").value.trim(); }
      else { const g = S.paper.glossary[+t.dataset.term]; from = g.zh; to = PR.$('.term-in[data-i="' + t.dataset.term + '"]').value.trim(); }
      const n = PR.replaceTerm(from, to, true);
      if (!n) return PR.toast(PR.t("正文里没找到“{s}”", { s: PR.esc(from) }));
      PR.confirm({ title: PR.t("替换 {n} 处？", { n }), body: PR.t("把正文里的“{from}”换成“{to}”。", { from, to }), ok: PR.t("替换"), at: t })
        .then((ok) => { if (ok) { PR.replaceTerm(from, to); PR.toast(PR.t("已替换 {n} 处", { n })); } });
      return;
    }
    const x = e.target.closest("[data-x]");
    if (x) x.dataset.x === "keys" ? PR.openSettings("keys") : x.dataset.x === "md" ? PR.openExport() : PR.download(x.dataset.x);
  });

  PR.download = function (kind) {
    const stem = ((S.paper.meta || {}).short_zh || (S.paper.meta || {}).title_zh || PR.t("论文")).replace(/[\\/:*?"<>|]/g, "");
    const text = kind === "ops" ? JSON.stringify(PR.exportOps(), null, 1) : PR.notesMarkdown();
    const a = PR.el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })), download: stem + (kind === "ops" ? PR.t("-我的修改.json") : PR.t("-笔记.md")) });
    document.body.appendChild(a); a.click(); a.remove();
  };

  /* ---------- 悬浮卡 ---------- */
  let popHideT = null, popSticky = false;
  PR.popover = function (anchor, html, opts) {
    if (!html) return;
    clearTimeout(popHideT);
    const pop = PR.$("#popover");
    pop.onclick = null;
    popSticky = !!(opts && opts.sticky);
    pop.classList.toggle("wide", !!(opts && opts.wide));
    if (pop._cls) pop.classList.remove(pop._cls);  // 各自的樣式（PDF 預覽卡 peek.js 是 "peek"）：換人用時拿掉
    pop._cls = (opts && opts.cls) || "";
    if (pop._cls) pop.classList.add(pop._cls);
    pop.innerHTML = html;
    pop.classList.add("open");
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const x = Math.min(innerWidth - w - 10, Math.max(10, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 8;
    if (y + h > innerHeight - 10) y = r.top - h - 8;
    pop.style.left = x + "px"; pop.style.top = Math.max(58, y) + "px";
    PR.growFrom(pop, r);
  };
  PR.hidePopover = () => { clearTimeout(popHideT); PR.$("#popover").classList.remove("open"); };
  PR.hidePopoverSoon = () => { if (popSticky) return; clearTimeout(popHideT); popHideT = setTimeout(PR.hidePopover, 220); };
  PR.$("#popover").addEventListener("mouseenter", () => clearTimeout(popHideT));
  PR.$("#popover").addEventListener("mouseleave", () => PR.hidePopoverSoon());
})(window.PR);
