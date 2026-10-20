/* 右邊外部工具欄裡的 AI（ChatGPT、Claude、Gemini…）讀得到、碰得到正在讀的文件。dock.js 建 <webview> 時交給這裡接上：
   - 載好就放進 dock-guest.js：底色換成 FOLI 面板的顏色；回答裡的頁碼（第 5 頁、p. 5）變成可以點、點了這邊翻到那一頁；
   - 讀者在它的輸入框問問題、按送出：先附上正在讀的那一頁的圖（問「整份」「這篇」時加上整份 PDF），傳完才送出——直接問「這頁在講什麼」
     它就看得到。同一段對話裡已經附過的那一頁不再附；換一段對話、開新對話就重新附。迴紋針裡可以關掉（每個網頁各自記）；
   - ChatGPT、Claude：讀者在那邊建了叫「FOLI」的專案，就找出來記著，在這裡開的新對話都從那個專案開始（對話存在專案裡）；
     迴紋針選單裡可以關掉，或改成正在看的那個專案；
   - 標題列多一顆迴紋針：附上整份 PDF、附上這一頁（那一頁的圖）、貼上在文件裡選的字、把最後一則回答存成筆記；
   - 閱讀頁選字時多一顆「問右邊的 ChatGPT」：選的字和出處貼進它的輸入框；
   - 在它的回答上選字按右鍵：存成筆記、在小視窗問這段、在文件裡找這段、跳到第 N 頁（選單在 main.cjs，做的事在這裡）；
   - 滑過一則訊息有兩顆小按鈕：加書籤（標題列的書籤可以跳回來，換了對話也跳得回去）、存成筆記（改寫成筆記的樣子，存進正在讀的那一頁）；
     在回答裡選字冒出「問這句」：開漂浮小視窗另外問（dock-float.js），小視窗送出第一個問題時把原本那段對話附上，接著問。
   附檔：主程序用 DevTools 協定把檔案交給它的上傳欄位，沒有合用的欄位就模擬把檔案拖進輸入框（main.cjs 的 easyread:embed-files）。
   只有讀者自己按了送出，那一頁才會跟著送出去；迴紋針附上、貼上之後要不要送、怎麼問，讀者自己決定。
   存回來的回答改寫成筆記（閱讀頁的 PR.addAnswerAsNote → notehelp.py 的 asnote），不是一則回答的樣子。
   只對認得的 AI 網站這樣做；別的網站（Notion、翻譯…）照舊只是放在那裡。 */
(function (PR) {
  "use strict";
  const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|aistudio\.google\.com|notebooklm\.google\.com|perplexity\.ai|copilot\.microsoft\.com|chat\.deepseek\.com|grok\.com|poe\.com|chat\.mistral\.ai|kimi\.com|chat\.qwen\.ai)$/i;
  const desktop = !!(window.easyreadDesktop && window.easyreadDesktop.isElectron);
  const anyHost = () => { try { return localStorage.getItem("easyread-dockai-any") === "1"; } catch (e) { return false; } };  // 檢查腳本用：本機的假網頁也當成 AI
  const isAI = (url) => { try { return AI.test(new URL(url).hostname) || anyHost(); } catch (e) { return false; } };
  const views = new Set();
  let src = null;
  const guest = () => (src = src || fetch("/web/js/dock-guest.js?v=3").then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)))));
  const run = (v, code) => v.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 有「專案」的網站（新對話可以放進專案）；easyread-dockai-site 是檢查腳本用的：本機的假網頁當成哪一家
  const siteOf = (url) => {
    try { const h = new URL(url).hostname; if (/(^|\.)(chatgpt\.com|chat\.openai\.com)$/i.test(h)) return "chatgpt"; if (/(^|\.)claude\.ai$/i.test(h)) return "claude"; } catch (e) { return ""; }
    try { return (anyHost() && localStorage.getItem("easyread-dockai-site")) || ""; } catch (e) { return ""; }
  };

  /* ---------- 正在讀的那一份（外殼裡被選著的那一格；它是閱讀頁才算） ---------- */
  function doc() {
    const tabs = (PR.shell && PR.shell.tabs && PR.shell.tabs()) || [];
    const t = tabs.find((x) => x.on && /^\/read\//.test(x.url || ""));
    if (!t || !t.doc) return null;
    const win = PR.shell.frameOf("/read/" + t.doc), P = win && win.PR;
    if (!P || !P.state || !P.state.paper) return null;
    const meta = P.state.paper.meta || {};
    const page = P.pdfMain && P.pdfMain() && P.pdfPage ? P.pdfPage() : ((P.blockById || {})[P.readingBlock && P.readingBlock()] || {}).page || 1;
    let sel = "";
    try { sel = String(win.getSelection() || "").trim(); } catch (e) { sel = ""; }
    return { id: t.doc, title: (t.title || "").replace(/\s+/g, " ").trim(), page: page || 1, pages: (meta.pages || []).length, sel, win, P };
  }

  /* ---------- 顏色：FOLI 面板的底（外部工具欄的那一張紙）、強調色 ---------- */
  function rgbOf(color) {
    const probe = document.createElement("i");
    probe.style.color = color;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }
  function palette() {
    const body = document.querySelector("#dock .dock-body");
    const cs = getComputedStyle(document.documentElement);
    let base = body ? getComputedStyle(body).backgroundColor : "";
    if (!base || /rgba\(0, 0, 0, 0\)|transparent/.test(base)) base = rgbOf(cs.getPropertyValue("--sheet").trim() || "#222");
    return { base, dark: document.documentElement.dataset.theme === "dark", accent: rgbOf(cs.getPropertyValue("--accent").trim() || "#7c6cf0") };
  }
  const soft = (rgb, a) => rgb.replace(/^rgb\(([^)]+)\)$/, (m, inner) => "rgba(" + inner + ", " + a + ")");
  const markCss = (p) => "::highlight(foli-page){color:" + p.accent + ";background-color:" + soft(p.accent, p.dark ? 0.2 : 0.12) + ";text-decoration:underline dotted " + p.accent + " 1.5px;text-underline-offset:3px}" +
    "html.foli-hand,html.foli-hand *{cursor:pointer !important}" +
    "::selection{background-color:" + soft(p.accent, p.dark ? 0.38 : 0.24) + "}" +
    "*{scrollbar-width:thin;scrollbar-color:" + (p.dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.2)") + " transparent}" + toolsCss(p);
  /* 滑過訊息的兩顆小按鈕、「問這句」、書籤的那條線、跳過來時閃一下（dock-guest.js 放的元素；顏色跟著 FOLI） */
  const toolsCss = (p) => {
    const ink = p.dark ? "#ececec" : "#1d1d1f", ink2 = p.dark ? "rgba(236,236,236,.72)" : "rgba(29,29,31,.62)", line = p.dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.1)", hover = p.dark ? "rgba(255,255,255,.09)" : "rgba(0,0,0,.05)";
    const shadow = "box-shadow:0 0 0 .5px " + line + ",0 6px 18px rgba(0,0,0," + (p.dark ? ".38" : ".14") + ");";
    return "#foli-tools{position:fixed;z-index:2147483646;display:none;gap:2px;padding:3px;border-radius:10px;background:" + p.base + ";" + shadow + "}" +
      "#foli-tools.on{display:flex}" +
      "#foli-tools button{all:unset;box-sizing:border-box;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:" + ink2 + ";cursor:pointer}" +
      "#foli-tools button:hover{background:" + hover + ";color:" + ink + "}#foli-tools button.is-on{color:" + p.accent + "}" +
      "#foli-tools svg,#foli-ask svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;flex:none}" +
      "#foli-ask{all:unset;box-sizing:border-box;position:fixed;z-index:2147483646;display:none;align-items:center;gap:6px;height:30px;padding:0 12px 0 10px;border-radius:999px;font:500 12.5px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:" + ink + ";background:" + p.base + ";cursor:pointer;" + shadow + "}" +
      "#foli-ask.on{display:inline-flex}#foli-ask:hover{color:" + p.accent + "}" +
      "[data-foli-mark]{box-shadow:inset 3px 0 0 " + p.accent + " !important}" +
      "[data-foli-flash]{animation:foli-flash 1.7s ease}@keyframes foli-flash{0%,35%{background-color:" + soft(p.accent, p.dark ? 0.22 : 0.14) + "}100%{background-color:transparent}}";
  };

  /* 一個網頁一次只算一次：兩次疊在一起時，後一次會把前一次已經換上去的顏色當成網站原本的顏色 */
  function skin(v) {
    v._skinQ = (v._skinQ || Promise.resolve()).then(() => doSkin(v)).catch(() => {});
    return v._skinQ;
  }
  async function doSkin(v) {
    if (!v.isConnected || !v._foli) return;
    for (const k of v._skin || []) await v.removeInsertedCSS(k).catch(() => {});  // 先拿掉舊的：算的時候要看網站自己原本的顏色
    v._skin = [];
    const p = palette();
    try {
      v._skin.push(await v.insertCSS(markCss(p)));  // 頁碼的標示、選取的顏色：一直都有
      if (v._app && v._app.plain) return;  // 讀者選了用網站原本的配色（外部工具欄「⋯」裡的開關）
      const css = await run(v, "window.__foliGuest ? window.__foliGuest.skinCss(" + JSON.stringify(p) + ") : ''");
      if (css) v._skin.push(await v.insertCSS(css));
    } catch (e) { /* 網頁換頁中：下次載好會再來 */ }
  }
  async function setup(v) {
    v._foli = false;
    v._skin = [];  // 換頁了：之前放的 CSS 跟著舊頁面一起沒了
    v._warned = false;
    try {
      const code = await guest();
      const d = doc();
      const text = { mark: PR.t("加書籤"), unmark: PR.t("拿掉書籤"), note: PR.t("存成筆記"), ask: PR.t("問這句") };
      const icons = { mark: PR.icon("markadd", "sm"), markon: PR.icon("markon", "sm"), note: PR.icon("notebook", "sm"), ask: PR.icon("pip", "sm") };
      await run(v, code + "\n;window.__foliGuest && window.__foliGuest.init(" + JSON.stringify({ pages: d ? d.pages : 0, hold: !(v._app && v._app.noPage), site: siteOf(v._app && v._app.url), tools: true, aside: !v._float, text, icons }) + ")");
      v._foli = true;
      v._setups = (v._setups || 0) + 1;
      await skin(v);
      lookForProject(v);
      pushMarks(v);
    } catch (e) { console.warn("dock-ai", e); }
  }
  const TAG = "⁣foli:";
  function onMessage(v, e) {
    const m = String((e && e.message) || "");
    if (!m.startsWith(TAG)) return;
    let msg;
    try { msg = JSON.parse(m.slice(TAG.length)); } catch (err) { return; }
    if (msg.t === "reskin") skin(v);
    else if (msg.t === "page") goPage(+msg.page);
    else if (msg.t === "send") autoSend(v, msg);
    else if (msg.t === "mark") setMark(v, msg);
    else if (msg.t === "tonote") run(v, "window.__foliGuest && window.__foliGuest.take()").then((x) => x && toNote(v, x)).catch(() => {});
    else if (msg.t === "aside" && PR.dockFloat) PR.dockFloat.open(v._app, { quote: msg.text });
    else if (msg.t === "down" && !v._float && PR.dockFloat) PR.dockFloat.outside();  // 點了右邊的網頁：沒釘選的小視窗收起來
  }

  /* ---------- 書籤：每個網站各自記（這台電腦），哪段對話（網址）、哪一則（角色＋開頭的字）、那時候的對話標題 ---------- */
  const MARKS = "easyread-dock-marks";
  const allMarks = () => { const o = PR.ls.get(MARKS, {}); return o && typeof o === "object" ? o : {}; };
  const marksOf = (app) => (app && Array.isArray(allMarks()[app.id]) ? allMarks()[app.id] : []);
  const pathOf = (v) => { try { return new URL(v.getURL()).pathname; } catch (e) { return ""; } };
  function setMark(v, m) {
    const app = v._app;
    if (!app || !m.path) return;
    const o = allMarks(), list = (Array.isArray(o[app.id]) ? o[app.id] : []).filter((x) => !(x.path === m.path && x.role === m.role && x.snippet === m.snippet));
    if (m.on) list.push({ path: String(m.path).slice(0, 300), title: String(m.title || "").slice(0, 80), role: m.role === "user" ? "user" : "assistant", snippet: String(m.snippet || "").slice(0, 90), at: new Date().toISOString() });
    o[app.id] = list.slice(-200);
    PR.ls.set(MARKS, o);
    if (m.on) PR.toast(PR.t("加了書籤：上面的書籤可以跳回這一則"), null, 2500);
    if (PR.dock && PR.dock.repaint) PR.dock.repaint();
  }
  function pushMarks(v) {
    const path = pathOf(v), list = marksOf(v._app).filter((x) => x.path === path);
    run(v, "window.__foliGuest ? window.__foliGuest.setMarks(" + JSON.stringify(list) + ") : 0").catch(() => {});
  }
  async function readyAgain(v, since, ms) {  // 換頁之後等 dock-guest.js 重新放好
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if ((v._setups || 0) > since && v._foli) return true;
    return false;
  }
  async function jumpMark(a, m) {
    const v = a.v;
    if (pathOf(v) !== m.path) {
      const since = v._setups || 0;
      v.loadURL(originOf(a.app.url) + m.path).catch(() => {});
      if (!(await readyAgain(v, since, 15000))) return PR.toast(PR.t("那段對話打不開了"));
    }
    for (let k = 0; k < 25; k++) {  // 網站載好訊息
      const n = await run(v, "window.__foliGuest ? window.__foliGuest.count() : 0").catch(() => 0);
      if (n) break;
      await sleep(400);
    }
    const ok = await run(v, "window.__foliGuest ? window.__foliGuest.jumpTo(" + JSON.stringify(m) + ") : false").catch(() => false);
    if (!ok) PR.toast(PR.t("找不到那一則了：可能刪掉或改過"), null, 4000);
  }
  function marksMenu(at) {
    const a = active();
    if (!a) return;
    const here = pathOf(a.v), groups = new Map();
    const list = marksOf(a.app).slice().sort((x, y) => (x.path === here) - (y.path === here) || String(x.at).localeCompare(String(y.at))).reverse();
    for (const m of list) { if (!groups.has(m.path)) groups.set(m.path, []); groups.get(m.path).push(m); }
    const snip = (s) => (s.length > 34 ? s.slice(0, 33) + "…" : s);
    const items = [];
    for (const [path, ms] of groups) {
      if (items.length) items.push("-");
      items.push({ label: path === here ? PR.t("這段對話") : ms[0].title || PR.t("另一段對話"), icon: "chats", disabled: true });
      ms.sort((x, y) => String(x.at).localeCompare(String(y.at))).forEach((m) => items.push({ label: snip(m.snippet) || PR.t("（一則訊息）"), icon: m.role === "user" ? "l-message-circle" : "markon", fn: () => jumpMark(a, m) }));
    }
    if (groups.has(here)) items.push("-", { label: PR.t("拿掉這段對話的書籤"), icon: "trash", fn: () => { const o = allMarks(); o[a.app.id] = marksOf(a.app).filter((x) => x.path !== here); PR.ls.set(MARKS, o); pushMarks(a.v); if (PR.dock.repaint) PR.dock.repaint(); } });
    PR.menu(at, items);
  }

  /* ---------- 回答存成筆記：改寫成筆記的樣子，存進正在讀的那一頁（閱讀頁的 PR.addAnswerAsNote） ---------- */
  function toNote(v, x) {
    const d = doc();
    if (!d) return PR.toast(PR.t("先在左邊打開一份文件，回答才有地方存"));
    if (!x || !String(x.md || "").trim()) return PR.toast(PR.t("這一則是空的"));
    const by = (v._app && v._app.name) || "AI";
    if (d.P.addAnswerAsNote) return d.P.addAnswerAsNote({ title: x.question || "", body: x.md, page: d.page, by });
    return save(d, { question: x.question || "", answer: x.md, by });  // 舊的閱讀頁：存成提問紀錄
  }
  // FOLI 的主題、紙色、強調色換了：每一個 AI 網頁重新配色（根節點的 style 也會因為欄寬之類的改變：顏色沒變就不重算）
  let reskinT = 0, lastSig = "";
  new MutationObserver(() => {
    clearTimeout(reskinT);
    reskinT = setTimeout(() => { const sig = JSON.stringify(palette()); if (sig === lastSig) return; lastSig = sig; views.forEach((v) => skin(v)); }, 250);
  })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-paper", "data-accent", "data-skin", "style"] });

  /* ---------- 翻頁、存回來 ---------- */
  function goPage(n) {
    const d = doc();
    if (!d) return PR.toast(PR.t("先打開一份文件，回答裡的頁碼才連得過去"));
    if (!(n >= 1) || (d.pages && n > d.pages)) return PR.toast(PR.t("這份文件沒有第 {n} 頁", { n }));
    if (d.P.goToPage) d.P.goToPage(n);
  }
  async function save(d, item) {
    try {
      const r = await PR.api("/api/p/" + d.id + "/handoff", { method: "POST", body: Object.assign({ do: "qa", page: d.page }, item) });
      if (d.P.poll) d.P.poll();
      const id = r && r.note && r.note.id;
      PR.toast(PR.t("已存到第 {p} 頁的筆記", { p: d.page }), id && d.P.goToNote ? { label: PR.t("看看"), fn: () => d.P.goToNote(id) } : null, 4000);
    } catch (e) { PR.toast(PR.t("沒存成：{msg}", { msg: PR.esc(e.message) })); }
  }

  /* ---------- 把字放進它的輸入框（不送出） ---------- */
  async function typeInto(v, text) {
    v.focus();
    let at = null;
    try { at = await run(v, "window.__foliGuest && window.__foliGuest.focusComposer()"); } catch (e) { at = null; }
    if (!at) {
      await navigator.clipboard.writeText(text).catch(() => {});
      PR.toast(PR.t("找不到它的輸入框，已經複製好了：點它的輸入框貼上就可以"), null, 5000);
      return false;
    }
    await v.insertText((at.empty ? "" : " ") + text);
    return true;
  }
  function active() {
    const app = PR.dock && PR.dock.current && PR.dock.current();
    if (!app || app.kind === "app" || !isAI(app.url)) return null;
    const v = document.querySelector('#dock webview.dock-view[data-app="' + app.id + '"]');
    return v && v._foli ? { app, v } : null;
  }
  /* ---------- 新對話放進「FOLI」專案（ChatGPT、Claude） ---------- */
  // 找到就記在外部工具欄的設定裡（app.project = { path, name }）；之後打開它、在它那邊按「新對話」（網址回到 / 或 /new），
  // 都換到專案頁——在專案頁開始的對話就存在專案裡。換過去馬上又被送回首頁（專案刪掉了）：忘掉它，不要來回跳
  const originOf = (url) => { try { return new URL(url).origin; } catch (e) { return ""; } };
  const fresh = (url) => { try { const u = new URL(url); return (u.pathname === "/" || u.pathname === "/new") && !/temporary-chat/i.test(u.search); } catch (e) { return false; } };
  const home = (app) => (app && app.project && !app.noProject && siteOf(app.url) ? originOf(app.url) + app.project.path : "");
  function goHome(v) {
    const app = v._app, h = home(app);
    let cur = "";
    try { cur = v.getURL(); } catch (e) { return; }
    if (!h || !fresh(cur) || originOf(cur) !== originOf(h)) return;
    if (v._homing) {  // 剛換過去又回到首頁：專案不在了
      v._homing = false;
      PR.toast(PR.t("找不到「{name}」專案了：新對話先放在一般的對話裡", { name: PR.esc(app.project.name) }), null, 5000);
      app.project = null;
      if (PR.dock && PR.dock.saveApps) PR.dock.saveApps();
      return;
    }
    v._homing = true;
    v.loadURL(h).catch(() => {});
  }
  function arrived(v) {  // 到了專案頁（或別的不是首頁的地方）：換過去成功
    try { if (!fresh(v.getURL())) v._homing = false; } catch (e) { /* 網頁關了 */ }
  }
  async function lookForProject(v) {
    const app = v._app;
    if (!app || app.project || app.noProject || v._looked || !siteOf(app.url)) return;
    v._looked = true;
    await sleep(1500);  // 側邊欄載好
    let p = null;
    try { p = await run(v, "window.__foliGuest && window.__foliGuest.findProject('FOLI')"); } catch (e) { p = null; }
    if (!p || !p.path || app.project) return;
    app.project = { path: String(p.path), name: String(p.name || "FOLI").slice(0, 60) };
    if (PR.dock && PR.dock.saveApps) PR.dock.saveApps();
    goHome(v);
  }

  /* ---------- 附檔：FOLI 做好檔案（handoff.py），主程序交給它的上傳欄位 ---------- */
  // 每個 AI 網頁記得這段對話附過哪幾頁：同一頁接著問不再附；換到另一段對話、開了新對話就重新附。
  // 對話看網址：/c/…、/chat/…、/app/… 後面的編號；新對話送出第一則之後網址才有編號，從「沒有」變成「有」算同一段
  const convo = (path) => { const m = /\/(?:c|chat|app|search|conversation|thread)\/[\w-]{6,}/.exec(path || ""); return m ? m[0] : ""; };
  function given(v, path) {
    const g = v._given || (v._given = { key: "", has: new Set() });
    const k = convo(path);
    if (g.key && k !== g.key) g.has.clear();
    g.key = k;
    return g.has;
  }
  const keyOf = (d, kind) => d.id + ":" + (kind === "pdf" ? "pdf" : d.page);
  async function give(v, d, kind, path) {
    const file = await PR.api("/api/p/" + d.id + "/handoff", { method: "POST", body: { do: "file", kind, page: d.page } });
    v.focus();
    let at = null;
    try { at = await run(v, "window.__foliGuest && window.__foliGuest.focusComposer()"); } catch (e) { at = null; }
    const r = await window.easyreadDesktop.embedFiles(v.getWebContentsId(), [file.path], at);
    if (!r || !r.ok) throw new Error((r && r.error) || "");
    if (path == null) path = await run(v, "location.pathname").catch(() => "");
    given(v, path).add(keyOf(d, kind));
    return file;
  }
  // 讀者在它那邊按了送出（dock-guest.js 先攔下來）：這段對話還沒有這一頁就先附上，然後請它送出
  const WHOLE = /整份|整篇|這篇|全文|整本|整章|整個文件|全部內容|這份(?:文件|講義|投影片|論文|報告|資料)|whole|entire|full text|(?:this|the) (?:paper|document|article|deck|chapter|lecture)\b/i;  // i18n-ok 比對讀者的問題
  async function autoSend(v, msg) {
    if (v._sending) return;
    v._sending = true;
    run(v, "window.__foliGuest && window.__foliGuest.ack()").catch(() => {});
    let attached = false;
    try {
      const d = doc();
      if (v._float && (!d || !d.pages || (v._app && v._app.noPage))) { attached = await giveChat(v, given(v, msg.path), msg.path); return; }
      if (!d || !d.pages || (v._app && v._app.noPage)) return;
      const has = given(v, msg.path);
      if (v._float) attached = (await giveChat(v, has, msg.path)) || attached;  // 漂浮小視窗：先附上原本那段對話
      const want = (WHOLE.test(msg.q || "") ? ["pdf", "page"] : ["page"]).filter((k) => !has.has(keyOf(d, k)));
      for (const kind of want) {
        try { await give(v, d, kind, msg.path); attached = true; } catch (e) {
          if (!v._warned) { v._warned = true; PR.toast(PR.t("{name} 沒有收下正在讀的這一頁，問題照常送出", { name: PR.esc((v._app && v._app.name) || "AI") }), null, 5000); }
        }
      }
    } catch (e) { console.warn("dock-ai", e); }
    finally {
      v._sending = false;
      let r = null;
      try { r = await run(v, "window.__foliGuest ? window.__foliGuest.release(" + JSON.stringify({ attached, host: true }) + ") : null"); } catch (e) { r = null; }
      if (r && r.key) { v.focus(); for (const ev of [{ type: "keyDown", keyCode: "Return" }, { type: "char", keyCode: "\r" }, { type: "keyUp", keyCode: "Return" }]) v.sendInputEvent(ev); }
    }
  }
  /* 漂浮小視窗送出問題時：右邊原本那段對話（一則一則轉成 Markdown）當成檔案附上，這段小視窗的對話裡附過、內容也沒變就不再附 */
  const mainView = (app) => (app ? document.querySelector('#dock webview.dock-view[data-app="' + app.id + '"]') : null);
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  async function giveChat(v, has, path) {
    const main = mainView(v._app);
    if (!main || !main._foli) return false;
    let tr = null;
    try { tr = await run(main, "window.__foliGuest ? window.__foliGuest.transcript() : null"); } catch (e) { tr = null; }
    if (!tr || !tr.msgs || !tr.msgs.length) return false;
    const name = (v._app && v._app.name) || "AI";
    const md = PR.dockAI.chatMarkdown(tr, name);
    const key = "chat:" + hash(md);
    if (has.has(key)) return false;
    try {
      const file = await PR.api("/api/handoff/text", { method: "POST", body: { name: PR.t("原本的對話"), text: md } });
      v.focus();
      let at = null;
      try { at = await run(v, "window.__foliGuest && window.__foliGuest.focusComposer()"); } catch (e) { at = null; }
      const r = await window.easyreadDesktop.embedFiles(v.getWebContentsId(), [file.path], at);
      if (!r || !r.ok) throw new Error((r && r.error) || "");
      given(v, path).add(key);
      return true;
    } catch (e) {
      if (!v._warnedChat) { v._warnedChat = true; PR.toast(PR.t("{name} 沒有收下原本那段對話的檔案：這一問沒有接著原本的對話", { name: PR.esc(name) }), null, 5000); }
      return false;
    }
  }
  async function attach(kind) {
    const a = active(), d = doc();
    if (!a || !d) return;
    try { await give(a.v, d, kind); } catch (e) { return PR.toast(PR.t("{name} 沒有收下檔案：{msg}", { name: PR.esc(a.app.name), msg: PR.esc(e.message) }), null, 5000); }
    // 附上的同時在輸入框寫一句（還沒送出，可以改）：請它標頁碼，回答裡的頁碼這邊才點得回去
    const line = kind === "pdf" ? PR.t("附上的是我正在讀的《{title}》（共 {n} 頁）。回答時請標出處頁碼，寫成「第 N 頁」。", { title: d.title, n: d.pages })
      : PR.t("附上的是《{title}》第 {p} 頁。", { title: d.title, p: d.page });
    await typeInto(a.v, line);
  }
  async function saveLast() {
    const a = active(), d = doc();
    if (!a || !d) return;
    let ans = null;
    try { ans = await run(a.v, "window.__foliGuest && window.__foliGuest.lastAnswer()"); } catch (e) { ans = null; }
    if (!ans || !ans.md) return PR.toast(PR.t("認不出它最後一則回答：把要存的那段選起來，按右鍵「存成筆記」"), null, 6000);
    toNote(a.v, { md: ans.md, question: ans.question });
  }

  /* ---------- 給 dock.js、閱讀頁、主程序的入口 ---------- */
  PR.dockAI = {
    isAI,
    /* dock.js 建好一個 <webview> 就交過來：認得的 AI 網站才接上 */
    wire(v, app, o) {
      if (!desktop || v._wired || !isAI(app.url)) return;
      v._wired = true;
      v._app = app;
      v._float = !!(o && o.float);  // 漂浮小視窗（dock-float.js）
      views.add(v);
      v.addEventListener("dom-ready", () => setup(v));
      v.addEventListener("did-navigate", () => { arrived(v); goHome(v); });
      v.addEventListener("did-navigate-in-page", (e) => { if (e.isMainFrame !== false) { arrived(v); goHome(v); clearTimeout(v._marksT); v._marksT = setTimeout(() => pushMarks(v), 700); } });
      v.addEventListener("console-message", (e) => onMessage(v, e));
      v.addEventListener("destroyed", () => views.delete(v));
    },
    forget: (v) => views.delete(v),
    /* 漂浮小視窗附上的「原本的對話」：一則一則排好（tests/test_dock_ai.cjs） */
    chatMarkdown(tr, name) {
      const who = (r) => (r === "user" ? PR.t("我") : name);
      let body = (tr.msgs || []).map((m) => "## " + who(m.role) + "\n\n" + String(m.md || "").trim()).join("\n\n");
      if (body.length > 150000) body = "…\n\n" + body.slice(-150000);  // 很長的對話：留最後面的
      return "# " + PR.t("原本的對話：{title}", { title: tr.title || name }) + "\n\n" +
        PR.t("這是我在另一個視窗和 {name} 的對話。我現在另外問一個問題：請接著這段對話的內容回答，不用重講一遍。", { name }) + "\n\n" + body + "\n";
    },
    typeInto: (v, text) => typeInto(v, text),
    whenReady: (v, since, ms) => readyAgain(v, since == null ? -1 : since, ms || 15000),
    marksMenu,
    hasMarks: (app) => marksOf(app).length > 0,
    /* dock.js 建 <webview> 時先開哪裡：有「FOLI」專案就直接開專案頁 */
    home: (app) => home(app),
    reskin: (v, app) => { if (app) v._app = app; return skin(v); },
    /* 標題列上那顆迴紋針（dock.js 的 paintHead 放） */
    button: (app) => (desktop && app && app.kind !== "app" && isAI(app.url)
      ? (marksOf(app).length ? '<button class="btn icon" data-d="marks" title="' + PR.esc(PR.t("書籤：跳回標起來的那一則")) + '">' + PR.icon("mark", "sm") + "</button>" : "") +
        '<button class="btn icon" data-d="float" title="' + PR.esc(PR.t("開一個漂浮的小視窗另外問（接著這段對話）")) + '">' + PR.icon("pip", "sm") + "</button>" +
        '<button class="btn icon" data-d="ai" title="' + PR.esc(PR.t("讓 {name} 讀正在看的文件", { name: app.name })) + '">' + PR.icon("clip", "sm") + "</button>" : ""),
    async menu(at) {
      const a = active(), d = doc();
      if (!a) return PR.toast(PR.t("等它載好再試一次"));
      const none = !d, app = a.app;
      let here = null;
      if (siteOf(app.url)) { try { here = await run(a.v, "window.__foliGuest && window.__foliGuest.projectHere()"); } catch (e) { here = null; } }
      const proj = !siteOf(app.url) ? [] : [
        app.project ? { label: PR.t("新對話放進「{name}」專案", { name: app.project.name }), icon: "folder", checked: !app.noProject, fn: () => PR.dockAI.project(a.v, app, !!app.noProject) }
          : { label: PR.t("沒找到叫 FOLI 的專案（在 {name} 建一個就會自動用）", { name: app.name }), icon: "folder", disabled: true },
        here && here.path && (!app.project || app.project.path !== here.path)
          ? { label: PR.t("新對話改放進這個專案（「{name}」）", { name: here.name || "?" }), icon: "folder", fn: () => PR.dockAI.project(a.v, app, true, here) } : null,
      ];
      PR.menu(at, [
        { label: d ? PR.t("《{title}》", { title: d.title.length > 24 ? d.title.slice(0, 23) + "…" : d.title }) : PR.t("先在左邊打開一份文件"), disabled: true },
        { label: PR.t("附上整份 PDF"), icon: "pdf", disabled: none, fn: () => attach("pdf") },
        { label: d ? PR.t("附上這一頁（第 {p} 頁的圖）", { p: d.page }) : PR.t("附上這一頁"), icon: "image", disabled: none, fn: () => attach("page") },
        { label: PR.t("貼上在文件裡選的字"), icon: "quote", disabled: none || !d.sel, fn: () => d && ask(d.sel) },
        "-",
        { label: PR.t("把它最後一則回答存成筆記"), icon: "notebook", disabled: none, fn: saveLast },
        "-",
        { label: PR.t("問問題時附上正在讀的這一頁"), icon: "l-zap", checked: !a.app.noPage, fn: () => PR.dockAI.auto(a.v, a.app, !!a.app.noPage) },
      ].concat(proj));
    },
    /* 「新對話放進專案」開關；p：改用這個專案（{ path, name }） */
    project(v, app, on, p) {
      if (p && p.path) app.project = { path: String(p.path), name: String(p.name || "").slice(0, 60) };
      app.noProject = !on;
      if (v._app && v._app !== app) Object.assign(v._app, { project: app.project, noProject: app.noProject });
      if (PR.dock && PR.dock.saveApps) PR.dock.saveApps();
      if (on) goHome(v);
      return !!home(app);
    },
    /* 「問問題時附上正在讀的這一頁」開關：每個網頁各自記（存在外部工具欄的設定裡） */
    auto(v, app, on) {
      app.noPage = !on;
      if (v._app && v._app !== app) v._app.noPage = app.noPage;
      if (PR.dock && PR.dock.saveApps) PR.dock.saveApps();
      return run(v, "window.__foliGuest ? window.__foliGuest.hold(" + !!on + ") : false").catch(() => false);
    },
    /* 閱讀頁選字時那顆「問右邊的…」要不要出現、叫什麼 */
    target() { const a = active(); return a ? { name: a.app.name } : null; },
    /* 閱讀頁選了字按「問右邊的…」：選的字和出處貼進它的輸入框，讀者接著打問題 */
    async ask(quote, page) {
      const a = active(), d = doc();
      if (!a) return false;
      const q = String(quote || "").replace(/\s+/g, " ").trim();
      if (!q) return false;
      const where = d ? PR.t("（《{title}》第 {p} 頁）", { title: d.title, p: page || d.page }) : "";
      return typeInto(a.v, PR.t("「{q}」", { q: q.length > 1500 ? q.slice(0, 1500) + "…" : q }) + where + " ");
    },
  };
  const ask = (q) => PR.dockAI.ask(q);

  /* 在它的回答上選字按右鍵（main.cjs 的選單）：存到筆記、在文件裡找、跳頁 */
  if (desktop && window.easyreadDesktop.onEmbedAction) {
    window.easyreadDesktop.onEmbedAction(async (msg) => {
      const v = Array.from(views).find((x) => { try { return x.getWebContentsId() === msg.id; } catch (e) { return false; } });
      const d = doc();
      if (!v) return;
      if (msg.action === "page") return goPage(+msg.page);
      if (msg.action === "aside") return PR.dockFloat && PR.dockFloat.open(v._app, { quote: String(msg.text || "") });
      if (!d) return PR.toast(PR.t("先在左邊打開一份文件"));
      if (msg.action === "find") { if (d.P.openFind) d.P.openFind(String(msg.text || "").slice(0, 120)); return; }
      if (msg.action === "save") {
        let sel = null;
        try { sel = await run(v, "window.__foliGuest && window.__foliGuest.selection()"); } catch (e) { sel = null; }
        toNote(v, { question: (sel && sel.question) || "", md: (sel && sel.md) || String(msg.text || "") });
      }
    });
  }
})(window.PR);
