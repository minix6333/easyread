/* 外殼右邊的「外部工具」欄：把 ChatGPT、Claude、Gemini 這類網頁版的工具嵌在視窗右側，邊讀邊用，不用切視窗。
   - 只有桌面版有（用 Electron 的 <webview>：一個獨立的瀏覽器分頁，一般網站不准被 iframe 嵌，這個可以）。
   - 它只是「放在那裡」：有自己的儲存區（登入狀態留著），拿不到 EasyRead 的任何內容，也連不到本機的後端（electron/main.cjs 收緊）。
   - 怎麼加：把網址、連結從瀏覽器拖進視窗（右緣會出現放下的地方）；欄開著時也可以把 App 圖示（ChatGPT.app…）或 .webloc 拖到欄的上緣；
     或按「＋」從清單挑、自己輸入網址。可以放好幾個，上面一排圖示切換；切走的只是藏起來，對話都還在。
   - 欄寬可以拉（拖的時候只移動一條線，放開才重排，和分割格子一樣）；開關、寬度、放了哪些都記著。
   - 電腦上的應用程式（ChatGPT.app 這種）：macOS 不允許把別的程式的「視窗」放進另一個程式裡，能做的是「貼齊」——
     EasyRead 的視窗讓出右邊，請系統把那個程式的視窗擺在旁邊，EasyRead 移動、改大小時跟著走（electron/native-dock.cjs）。
     要你在「系統設定 → 隱私權與安全性 → 輔助使用」允許 EasyRead。把 App 圖示拖到欄的上緣，或按「＋ → 貼齊一個 App」。
     貼齊的時候欄本身收起來（位置讓給那個視窗），切換的圖示改放在分頁列右邊。重開 App 不會自動再貼（不會一開就去動別的視窗）。
   PR.dockModel 是純函式（tests/test_dock.cjs）。 */
(function (PR) {
  "use strict";
  const KEY = "easyread-dock";
  const MIN_W = 320, DEF_W = 440;
  const PRESETS = [
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Claude", url: "https://claude.ai/" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Perplexity", url: "https://www.perplexity.ai/" },
    { name: "NotebookLM", url: "https://notebooklm.google.com/" },
    { name: "Google 翻譯", url: "https://translate.google.com/" },  // i18n-ok 產品名
    { name: "DeepL", url: "https://www.deepl.com/translator" },
  ];
  /* 拖 App 圖示進來：這些有網頁版的開網頁版 */
  const APPS = { chatgpt: "https://chatgpt.com/", claude: "https://claude.ai/", gemini: "https://gemini.google.com/app", perplexity: "https://www.perplexity.ai/",
    copilot: "https://copilot.microsoft.com/", "microsoft copilot": "https://copilot.microsoft.com/", deepl: "https://www.deepl.com/translator", notion: "https://www.notion.so/",
    slack: "https://app.slack.com/client", discord: "https://discord.com/app", spotify: "https://open.spotify.com/", "google chrome": "https://www.google.com/",
    zotero: "https://www.zotero.org/mylibrary", overleaf: "https://www.overleaf.com/project", "microsoft word": "https://www.office.com/launch/word", notability: "", goodnotes: "https://web.goodnotes.com/" };

  /* ---------- 純函式 ---------- */
  const M = (PR.dockModel = {
    blank: () => ({ open: false, w: DEF_W, nw: 480, apps: [], active: null, seq: 0 }),
    /* 把使用者給的東西變成網址：完整網址、沒寫 https:// 的網域；本機位址、非 http(s) 的不收 */
    url(text) {
      let t = String(text || "").trim().split(/\s+/)[0] || "";
      if (!t) return "";
      if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) { if (!/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t)) return ""; t = "https://" + t; }
      let u;
      try { u = new URL(t); } catch (e) { return ""; }
      if (!/^https?:$/.test(u.protocol)) return "";
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname) || u.hostname === "localhost") return "";
      return u.href;
    },
    /* 拖進來的東西裡找網址：uri-list（# 開頭是註解）、純文字 */
    fromDrop(uriList, plain) {
      const first = String(uriList || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      return M.url(first) || M.url(plain);
    },
    /* 拖進來的檔案：.app → 認得的開網頁版（回 {url} 或 {unknown: 名字}）；.webloc / .url 的內容裡找網址 */
    fromApp(filename) {
      const m = /([^/\\]+)\.app\/?$/i.exec(String(filename || ""));
      if (!m) return null;
      const name = m[1].trim(), url = APPS[name.toLowerCase()];
      return url ? { url, name } : { unknown: name };
    },
    fromLinkFile(text) {
      const s = String(text || "");
      const m = /<key>URL<\/key>\s*<string>([^<]+)<\/string>/i.exec(s) || /^URL=(.+)$/im.exec(s);
      return m ? M.url(m[1].replace(/&amp;/g, "&")) : "";
    },
    nameOf(url) {
      const p = PRESETS.find((x) => { try { return new URL(x.url).hostname === new URL(url).hostname; } catch (e) { return false; } });
      if (p) return p.name;
      try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url; }
    },
    /* 加一個：同一個網站已經有了就切過去 */
    add(st, url, name) {
      url = M.url(url);
      if (!url) return null;
      const host = new URL(url).hostname;
      let app = st.apps.find((a) => { try { return new URL(a.url).hostname === host; } catch (e) { return false; } });
      if (!app) { app = { id: "d" + ++st.seq, url, name: name || M.nameOf(url) }; st.apps.push(app); }
      st.active = app.id;
      st.open = true;
      return app;
    },
    /* 電腦上的應用程式（貼齊用）：同一個程式已經有了就切過去 */
    addApp(st, path, name) {
      path = String(path || "").replace(/\/+$/, "");
      if (!/^\/.+\.app$/i.test(path)) return null;
      let app = st.apps.find((a) => a.kind === "app" && a.path === path);
      if (!app) { app = { id: "d" + ++st.seq, kind: "app", path, name: name || path.split("/").pop().replace(/\.app$/i, "") }; st.apps.push(app); }
      return app;  // 只是加進清單；真的貼成了才算切過去（要權限、可能失敗）
    },
    remove(st, id) {
      const i = st.apps.findIndex((a) => a.id === id);
      if (i < 0) return;
      st.apps.splice(i, 1);
      if (st.active === id) st.active = (st.apps[i] || st.apps[i - 1] || {}).id || null;
    },
    clampW: (w, total) => Math.round(Math.max(MIN_W, Math.min(Math.max(MIN_W, total - 420), Number(w) || DEF_W))),
    load(saved) {
      const st = M.blank();
      if (!saved || typeof saved !== "object") return st;
      st.apps = (Array.isArray(saved.apps) ? saved.apps : []).map((a) => (a && a.kind === "app"
        ? { id: String(a.id || ""), kind: "app", path: /^\/.+\.app$/i.test(a.path || "") ? a.path : "", name: String(a.name || "").slice(0, 60), icon: /^data:image\/png;base64,[\w+/=]+$/.test(a.icon || "") ? a.icon : "" }
        : { id: String((a && a.id) || ""), url: M.url(a && a.url), name: String((a && a.name) || "").slice(0, 60), icon: /^https:\/\//.test((a && a.icon) || "") ? a.icon : "" }))
        .filter((a) => a.id && (a.url || a.path)).slice(0, 12);
      st.nw = Number(saved.nw) > 0 ? Number(saved.nw) : 480;
      st.seq = Math.max(Number(saved.seq) || 0, st.apps.length);
      st.active = st.apps.some((a) => a.id === saved.active) ? saved.active : (st.apps[0] || {}).id || null;
      st.w = Number(saved.w) > 0 ? Number(saved.w) : DEF_W;
      st.open = !!saved.open;
      const cur = st.apps.find((a) => a.id === st.active);
      if (cur && cur.kind === "app") st.open = false;  // 上次貼著別的程式：重開不自動再貼
      return st;
    },
  });

  if (typeof document === "undefined" || !document.body || !PR.$) return;  // 測試環境只要上面的純函式
  const desktop = !!(window.easyreadDesktop && window.easyreadDesktop.isElectron);
  const demo = /[?&]dock=1/.test(location.search);  // 瀏覽器裡看版面用：改用 iframe（大部分網站不給嵌，只是看排版）
  if (!desktop && !demo) return;

  const st = M.load(PR.ls.get(KEY, null));
  const save = () => PR.ls.set(KEY, { open: st.open, w: st.w, nw: st.nw, apps: st.apps.map((a) => (a.kind === "app" ? { id: a.id, kind: "app", path: a.path, name: a.name, icon: a.icon } : { id: a.id, url: a.url, name: a.name, icon: a.icon })), active: st.active, seq: st.seq });
  const native = desktop && window.easyreadDesktop.platform === "darwin" && typeof window.easyreadDesktop.nativeDock === "function" ? window.easyreadDesktop.nativeDock : null;
  let nativeOn = null;  // 現在貼在旁邊的那個程式（apps 裡的 id）；沒有就是 null
  const root = document.documentElement;
  const dock = PR.el("aside", { id: "dock", "aria-label": PR.t("外部工具") });
  const grip = PR.el("div", { id: "dockGrip", title: PR.t("拖動調整寬度（雙擊回預設）") });
  const drop = PR.el("div", { id: "dockDrop" }, "<span>" + PR.icon("plus") + "<b>" + PR.t("放開，嵌在右邊") + "</b></span>");
  document.body.append(dock, grip, drop);
  const views = {};  // app id → <webview>
  const active = () => st.apps.find((a) => a.id === st.active) || null;
  const relayout = () => { PR.shellLayout && PR.shellLayout(); };

  function applyWidth() {
    const inside = st.open && !nativeOn;  // 貼著別的程式時欄本身收起來：位置讓給那個視窗了
    const w = inside ? M.clampW(st.w, innerWidth) : 0;
    root.style.setProperty("--dock-w", w + "px");
    document.body.classList.toggle("dock-open", inside);
    relayout();
  }
  function view(app) {
    let v = views[app.id];
    if (v) return v;
    v = document.createElement(desktop ? "webview" : "iframe");
    v.className = "dock-view";
    v.dataset.app = app.id;
    if (desktop) { v.setAttribute("partition", "persist:embed"); v.setAttribute("allowpopups", ""); }
    v.setAttribute("src", app.url);
    if (desktop) {
      v.addEventListener("page-title-updated", (e) => { app.title = String(e.title || "").slice(0, 80); paintHead(); });
      v.addEventListener("page-favicon-updated", (e) => { const ic = (e.favicons || []).find((x) => /^https:\/\//.test(x)); if (ic && ic !== app.icon) { app.icon = ic; save(); paintHead(); } });
      v.addEventListener("did-start-loading", () => { app.loading = true; app.failed = ""; paintHead(); paintState(); });
      v.addEventListener("did-stop-loading", () => { app.loading = false; paintHead(); });
      v.addEventListener("did-navigate", () => paintHead());
      v.addEventListener("did-navigate-in-page", () => paintHead());
      v.addEventListener("did-fail-load", (e) => { if (e.isMainFrame && e.errorCode !== -3) { app.failed = e.errorDescription || String(e.errorCode); app.loading = false; paintHead(); paintState(); } });  // -3 是自己取消的（換頁）
    }
    PR.$(".dock-body", dock).append(v);
    views[app.id] = v;
    return v;
  }
  function appIcon(a) {
    return a.icon ? '<img src="' + PR.esc(a.icon) + '" alt="" draggable="false">' : '<i class="ltr">' + PR.esc((a.name || "?").trim().charAt(0).toUpperCase()) + "</i>";
  }
  function paintHead() {
    const cur = active(), v = cur && views[cur.id];
    let canBack = false;
    try { canBack = !!(v && v.canGoBack && v.canGoBack()); } catch (e) { canBack = false; }  // 還沒掛上時會丟例外
    PR.$(".dock-head", dock).innerHTML =
      '<div class="dock-apps">' + st.apps.map((a) => '<button class="dock-app' + (a.id === st.active ? " on" : "") + (a.loading ? " loading" : "") + '" data-app="' + PR.esc(a.id) + '" title="' + PR.esc(a.title || a.name) + '">' +
        appIcon(a) + '<span class="x" data-x="' + PR.esc(a.id) + '" title="' + PR.t("拿掉") + '">' + PR.icon("x", "sm") + "</span></button>").join("") +
      '<button class="btn icon" data-d="add" title="' + PR.t("加一個外部工具（也可以把網址拖進來）") + '">' + PR.icon("plus", "sm") + "</button></div>" +
      '<span class="grow"></span>' +
      (cur && cur.kind !== "app" ? '<button class="btn icon" data-d="back" title="' + PR.t("上一頁") + '"' + (canBack ? "" : " disabled") + ">" + PR.icon("back", "sm") + "</button>" +
        '<button class="btn icon" data-d="reload" title="' + PR.t("重新載入") + '">' + PR.icon("redo", "sm") + "</button>" +
        '<button class="btn icon" data-d="more" title="' + PR.t("更多") + '">' + PR.icon("more", "sm") + "</button>" : "") +
      '<button class="btn icon" data-d="hide" title="' + PR.t("收起這一欄") + '">' + PR.icon("x", "sm") + "</button>";
  }
  function paintState() {
    const box = PR.$(".dock-state", dock), cur = active();
    if (!st.apps.length) {
      box.hidden = false;
      box.innerHTML = '<div class="dock-empty"><h3>' + PR.t("把外部工具嵌在這裡") + "</h3><p>" + PR.t("把網址或連結從瀏覽器拖進來，或從下面挑一個。它有自己的登入，讀不到 EasyRead 裡的內容。") + (native ? " " + PR.t("電腦上的程式（例如 ChatGPT）也可以：把它的圖示從「應用程式」拖到這裡，視窗會貼在 EasyRead 右邊。") : "") + "</p>" +
        '<div class="dock-presets">' + PRESETS.map((p, i) => '<button data-preset="' + i + '">' + PR.esc(p.name) + "</button>").join("") +
        '<button data-d="url">' + PR.icon("link", "sm") + PR.t("輸入網址…") + "</button>" + (native ? '<button data-d="pickapp">' + PR.icon("panel", "sm") + PR.t("貼齊一個 App…") + "</button>" : "") + "</div></div>";
    } else if (cur && cur.failed) {
      box.hidden = false;
      box.innerHTML = '<div class="dock-empty"><h3>' + PR.t("這一頁沒載入") + "</h3><p>" + PR.esc(cur.failed) + '</p><div class="dock-presets"><button data-d="reload">' + PR.t("再試一次") + "</button></div></div>";
    } else if (!desktop && cur) {
      box.hidden = true;
    } else box.hidden = true;
  }
  function render() {
    for (const id of Object.keys(views)) if (!st.apps.some((a) => a.id === id)) { views[id].remove(); delete views[id]; }
    if (st.open) {
      const cur = active();
      if (cur && cur.kind !== "app") view(cur);  // 用到才載入
      for (const a of st.apps) if (views[a.id]) views[a.id].classList.toggle("on", a.id === st.active);
    }
    paintHead(); paintState(); applyWidth(); save();
    PR.emit && PR.emit("dock-changed", st.open);
  }
  dock.innerHTML = '<div class="dock-head"></div><div class="dock-body"><div class="dock-state" hidden></div></div>';

  /* ---------- 貼齊電腦上的應用程式（macOS） ---------- */
  const WHY = { fullscreen: PR.t("全螢幕時沒辦法貼齊，先離開全螢幕。"), narrow: PR.t("視窗太窄，放不下兩個並排；把 EasyRead 的視窗拉寬一點再試。"), nowindow: PR.t("那個程式沒有開出視窗。"),
    launch: PR.t("那個程式開不起來。"), path: PR.t("找不到那個程式。"), platform: PR.t("貼齊別的程式的視窗目前只有 macOS 版做得到。"), helper: PR.t("貼齊用的幫手程式沒有回應。"), timeout: PR.t("等太久了，那個程式沒有回應。") };
  async function permissionGuide(app, at) {
    const ok = await PR.confirm({ title: PR.t("要先允許 EasyRead「輔助使用」"), ok: PR.t("打開系統設定"), at,
      body: PR.t("macOS 不讓一個程式把別的程式的視窗放進自己裡面。EasyRead 能做的是讓出右邊，請系統把「{name}」的視窗貼在旁邊、跟著一起移動——這需要你在「系統設定 → 隱私權與安全性 → 輔助使用」把 EasyRead 打開。開好之後回來，再點一次它的圖示。", { name: app.name }) });
    if (!ok) return;
    try { await native("request"); await native("settings"); } catch (e) { PR.toast(PR.esc(e.message)); }
  }
  async function goNative(app, at) {
    if (!native) return PR.toast(WHY.platform);
    let r;
    try { r = await native("attach", { path: app.path, width: st.nw }); } catch (e) { r = { ok: false, reason: "helper" }; }
    if (!r || !r.ok) {
      if (r && r.reason === "permission") return permissionGuide(app, at);
      return PR.toast(WHY[(r && r.reason) || "helper"] || WHY.helper, null, 5000);
    }
    nativeOn = app.id; st.active = app.id; st.open = true;
    if (r.width) st.nw = r.width;
    render();
  }
  async function leaveNative() {
    if (!nativeOn) return;
    nativeOn = null;
    try { await native("detach"); } catch (e) { /* 幫手沒了：視窗已經放開 */ }
  }
  async function addNative(path, at) {
    const app = M.addApp(st, path);
    if (!app) return PR.toast(WHY.path);
    if (!app.icon && native) { try { app.icon = (await native("icon", app.path)) || ""; } catch (e) { app.icon = ""; } }
    save(); paintHead(); PR.emit("dock-changed", st.open);
    await select(app.id, at);
  }
  /* 切到某一個：網頁的就顯示在欄裡；應用程式的就貼齊在旁邊 */
  async function select(id, at) {
    const app = st.apps.find((a) => a.id === id);
    if (!app) return;
    if (app.kind === "app") { if (nativeOn !== app.id) { await leaveNative(); await goNative(app, at); } return; }
    await leaveNative();
    st.active = app.id; st.open = true;
    render();
  }
  if (native && window.easyreadDesktop.onNativeDock) {
    window.easyreadDesktop.onNativeDock((msg) => {
      if (msg.type === "gone" && nativeOn) { nativeOn = null; st.open = false; render(); PR.toast(PR.t("貼在旁邊的程式關了，EasyRead 的視窗變回原來的寬度。"), null, 3500); }
      else if (msg.type === "width" && msg.width) { st.nw = msg.width; save(); }
    });
  }

  /* ---------- 對外 ---------- */
  PR.dock = {
    isOpen: () => st.open,
    async toggle(force) {
      const open = force != null ? !!force : !st.open;
      const cur = active();
      if (!open) { await leaveNative(); st.open = false; return render(); }
      if (cur && cur.kind === "app") return goNative(cur, PR.$('#tabs [data-act="dock"]'));
      st.open = true; render();
    },
    add(url, name) {
      const app = M.add(st, url, name);
      if (!app) { PR.toast(PR.t("這不是可以嵌的網址（要 https:// 開頭的網站）")); return null; }
      leaveNative().then(render);
      return app;
    },
    native: () => nativeOn,
    addApp: (path) => addNative(path, PR.$('#tabs [data-act="dock"]')),
    /* 分頁列右邊的按鈕；貼著別的程式時欄收起來了，切換用的圖示也放在這裡 */
    button: () => (nativeOn ? '<span class="dock-rail">' + st.apps.map((a) => '<button class="dock-app' + (a.id === st.active ? " on" : "") + '" data-dockapp="' + PR.esc(a.id) + '" title="' + PR.esc(a.title || a.name) + '">' + appIcon(a) + "</button>").join("") + "</span>" : "") +
      '<button class="btn icon' + (st.open ? " on" : "") + '" data-act="dock" title="' + PR.t("外部工具：把 ChatGPT 之類的網頁或程式放在右邊") + '">' + PR.icon("popout", "sm") + "</button>",
  };

  /* ---------- 按鈕 ---------- */
  function addMenu(at) {
    PR.menu(at, PRESETS.map((p) => ({ label: p.name, fn: () => PR.dock.add(p.url, p.name) })).concat(["-", { label: PR.t("輸入網址…"), icon: "link", fn: () => askUrl(at) }],
      native ? [{ label: PR.t("貼齊一個 App…"), icon: "panel", fn: async () => { const path = await native("pick"); if (path) addNative(path, at); } }] : []));
  }
  async function askUrl(at) {
    const text = await PR.promptText({ title: PR.t("要嵌的網址"), value: "https://", ok: PR.t("加入"), max: 600, at });
    if (text) PR.dock.add(text);
  }
  dock.addEventListener("click", async (e) => {
    const x = e.target.closest("[data-x]");
    if (x) { e.stopPropagation(); if (nativeOn === x.dataset.x) await leaveNative(); M.remove(st, x.dataset.x); const cur = active(); if (cur && cur.kind === "app" && !nativeOn) st.open = false; return render(); }
    const tab = e.target.closest(".dock-app[data-app]");
    if (tab) return select(tab.dataset.app, tab);
    const pre = e.target.closest("[data-preset]");
    if (pre) { const p = PRESETS[+pre.dataset.preset]; return PR.dock.add(p.url, p.name); }
    const b = e.target.closest("[data-d]");
    if (!b) return;
    const a = b.dataset.d, cur = active(), v = cur && views[cur.id];
    if (a === "add") return addMenu(b);
    if (a === "url") return askUrl(b);
    if (a === "pickapp") { const path = await native("pick"); return path ? addNative(path, b) : null; }
    if (a === "hide") return PR.dock.toggle(false);
    if (a === "back" && v && v.goBack) return v.goBack();
    if (a === "reload" && v) { cur.failed = ""; paintState(); return v.reload ? v.reload() : (v.src = cur.url); }
    if (a === "more" && cur) {
      const here = () => { try { return (v && v.getURL && v.getURL()) || cur.url; } catch (err) { return cur.url; } };
      PR.menu(b, [
        { label: PR.t("回到首頁"), icon: "back", fn: () => { if (v && v.loadURL) v.loadURL(cur.url); else if (v) v.src = cur.url; } },
        { label: PR.t("用瀏覽器開這一頁"), icon: "popout", fn: () => window.open(here(), "_blank", "noopener") },
        { label: PR.t("複製這一頁的網址"), icon: "copy", fn: () => navigator.clipboard.writeText(here()).then(() => PR.toast(PR.t("已复制"), null, 1200)) },
        "-",
        { label: PR.t("從這一欄拿掉"), icon: "x", fn: () => { M.remove(st, cur.id); render(); } },
        { label: PR.t("登出並清除所有外部工具的資料…"), icon: "trash", fn: async () => {
          if (!(await PR.confirm({ title: PR.t("清除外部工具的資料？"), body: PR.t("嵌在這一欄的網站會全部登出，快取也會清掉；EasyRead 自己的論文和筆記不受影響。"), ok: PR.t("清除"), danger: true, at: b }))) return;
          try { if (desktop && window.easyreadDesktop.clearEmbedData) await window.easyreadDesktop.clearEmbedData(); } catch (err) { return PR.toast(PR.esc(err.message)); }
          for (const id of Object.keys(views)) { views[id].remove(); delete views[id]; }
          render();
          PR.toast(PR.t("已清除"), null, 1500);
        } },
      ]);
    }
  });

  document.addEventListener("click", (e) => {  // 貼著別的程式時，切換的圖示在分頁列上
    const chip = e.target.closest && e.target.closest("#tabs [data-dockapp]");
    if (chip) { e.stopPropagation(); select(chip.dataset.dockapp, chip); }
  }, true);

  /* ---------- 拉欄寬：拖的時候只移一條線，放開才重排（網頁和 PDF 每一幀都重排會卡） ---------- */
  grip.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add("sizing");
    const ghost = PR.el("div", { class: "gap-ghost" });
    document.body.append(ghost);
    let w = M.clampW(st.w, innerWidth);
    const place = (x) => { w = M.clampW(innerWidth - x, innerWidth); Object.assign(ghost.style, { left: innerWidth - w + "px", top: "var(--tabs-h)", height: "calc(100% - var(--tabs-h))" }); };
    place(e.clientX);
    const move = (ev) => place(ev.clientX);
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      ghost.remove();
      document.body.classList.remove("sizing");
      st.w = w; applyWidth(); save();
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  grip.addEventListener("dblclick", () => { st.w = DEF_W; applyWidth(); save(); });
  window.addEventListener("resize", () => { if (st.open) applyWidth(); });

  /* ---------- 拖進來 ---------- */
  let dropT = 0;
  const hasLink = (dt) => { const t = Array.from((dt && dt.types) || []); return t.includes("text/uri-list") && !t.includes("Files"); };
  const hasFiles = (dt) => Array.from((dt && dt.types) || []).includes("Files");
  function showDrop() {
    drop.classList.add("show");
    clearTimeout(dropT);
    dropT = setTimeout(() => drop.classList.remove("show", "over"), 500);  // 拖走了、放在別處了：沒有再收到 dragover 就收掉
  }
  PR.dockDragHint = showDrop;  // 分頁裡的頁面（iframe）看到有人拖著連結經過，會來叫（frame-bridge.js）
  document.addEventListener("dragover", (e) => { if (hasLink(e.dataTransfer)) showDrop(); });
  drop.addEventListener("dragover", (e) => { if (!hasLink(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = "link"; drop.classList.add("over"); showDrop(); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  async function takeDrop(e) {
    const dt = e.dataTransfer;
    let url = M.fromDrop(dt.getData("text/uri-list"), dt.getData("text/plain"));
    if (!url && dt.files && dt.files.length) {
      const f = dt.files[0];
      const app = M.fromApp(f.name);
      const path = app && native && window.easyreadDesktop.pathForFile ? window.easyreadDesktop.pathForFile(f) : "";
      if (path) return addNative(path, PR.$(".dock-head", dock));  // Mac：把那個程式本身貼在旁邊
      if (app && app.url) return PR.dock.add(app.url, app.name);
      if (app) return PR.toast(PR.t("「{name}」沒有可以嵌的網頁版。這裡嵌的是網站：把它的網址拖進來，或按 ＋ 輸入。", { name: PR.esc(app.unknown) }), null, 6000);
      if (/\.(webloc|url)$/i.test(f.name)) { try { url = M.fromLinkFile(await f.text()); } catch (err) { url = ""; } }
    }
    if (url) return PR.dock.add(url);
    PR.toast(PR.t("這不是可以嵌的網址（要 https:// 開頭的網站）"));
  }
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("show", "over"); takeDrop(e); });
  // 欄開著時：上緣那一排和空白畫面也收（App 圖示、.webloc 檔只能放這裡——別處放檔案是匯入 PDF）
  dock.addEventListener("dragover", (e) => {
    if (e.target.closest(".dock-view") || !(hasLink(e.dataTransfer) || hasFiles(e.dataTransfer))) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "link"; dock.classList.add("drop-on");
  });
  dock.addEventListener("dragleave", (e) => { if (!dock.contains(e.relatedTarget)) dock.classList.remove("drop-on"); });
  dock.addEventListener("drop", (e) => { if (e.target.closest(".dock-view")) return; e.preventDefault(); dock.classList.remove("drop-on"); takeDrop(e); });

  render();
})(window.PR);
