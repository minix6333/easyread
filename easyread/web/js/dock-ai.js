/* 右邊外部工具欄裡的 AI（ChatGPT、Claude、Gemini…）讀得到、碰得到正在讀的文件。dock.js 建 <webview> 時交給這裡接上：
   - 載好就放進 dock-guest.js：底色換成 FOLI 面板的顏色；回答裡的頁碼（第 5 頁、p. 5）變成可以點、點了這邊翻到那一頁；
   - 標題列多一顆迴紋針：附上整份 PDF、附上這一頁（那一頁的圖）、貼上在文件裡選的字、把最後一則回答存成筆記；
   - 閱讀頁選字時多一顆「問右邊的 ChatGPT」：選的字和出處貼進它的輸入框；
   - 在它的回答上選字按右鍵：存到這份文件的筆記、在文件裡找這段、跳到第 N 頁（選單在 main.cjs，做的事在這裡）。
   附檔：主程序用 DevTools 協定把檔案交給它的上傳欄位，沒有合用的欄位就模擬把檔案拖進輸入框（main.cjs 的 easyread:embed-files）。
   什麼都不會自己送出去：附上、貼上之後要不要送、怎麼問，讀者自己決定。存回來的回答排成提問紀錄（handoff.py），署名是哪個 AI。
   只對認得的 AI 網站這樣做；別的網站（Notion、翻譯…）照舊只是放在那裡。 */
(function (PR) {
  "use strict";
  const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|aistudio\.google\.com|notebooklm\.google\.com|perplexity\.ai|copilot\.microsoft\.com|chat\.deepseek\.com|grok\.com|poe\.com|chat\.mistral\.ai|kimi\.com|chat\.qwen\.ai)$/i;
  const desktop = !!(window.easyreadDesktop && window.easyreadDesktop.isElectron);
  const anyHost = () => { try { return localStorage.getItem("easyread-dockai-any") === "1"; } catch (e) { return false; } };  // 檢查腳本用：本機的假網頁也當成 AI
  const isAI = (url) => { try { return AI.test(new URL(url).hostname) || anyHost(); } catch (e) { return false; } };
  const views = new Set();
  let src = null;
  const guest = () => (src = src || fetch("/web/js/dock-guest.js?v=1").then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)))));
  const run = (v, code) => v.executeJavaScript(code);

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
    "*{scrollbar-width:thin;scrollbar-color:" + (p.dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.2)") + " transparent}";

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
    try {
      const code = await guest();
      const d = doc();
      await run(v, code + "\n;window.__foliGuest && window.__foliGuest.init(" + JSON.stringify({ pages: d ? d.pages : 0 }) + ")");
      v._foli = true;
      await skin(v);
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
  async function attach(kind) {
    const a = active(), d = doc();
    if (!a || !d) return;
    let file;
    try { file = await PR.api("/api/p/" + d.id + "/handoff", { method: "POST", body: { do: "file", kind, page: d.page } }); } catch (e) { return PR.toast(PR.t("沒附上：{msg}", { msg: PR.esc(e.message) })); }
    a.v.focus();
    let at = null;
    try { at = await run(a.v, "window.__foliGuest && window.__foliGuest.focusComposer()"); } catch (e) { at = null; }
    let r = null;
    try { r = await window.easyreadDesktop.embedFiles(a.v.getWebContentsId(), [file.path], at); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) return PR.toast(PR.t("{name} 沒有收下檔案：{msg}", { name: PR.esc(a.app.name), msg: PR.esc((r && r.error) || "") }), null, 5000);
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
    if (!ans || !ans.md) return PR.toast(PR.t("認不出它最後一則回答：把要存的那段選起來，按右鍵「存到這份文件的筆記」"), null, 6000);
    save(d, { question: ans.question, answer: ans.md, by: a.app.name });
  }

  /* ---------- 給 dock.js、閱讀頁、主程序的入口 ---------- */
  PR.dockAI = {
    isAI,
    /* dock.js 建好一個 <webview> 就交過來：認得的 AI 網站才接上 */
    wire(v, app) {
      if (!desktop || v._wired || !isAI(app.url)) return;
      v._wired = true;
      v._app = app;
      views.add(v);
      v.addEventListener("dom-ready", () => setup(v));
      v.addEventListener("console-message", (e) => onMessage(v, e));
      v.addEventListener("destroyed", () => views.delete(v));
    },
    forget: (v) => views.delete(v),
    reskin: (v, app) => { if (app) v._app = app; return skin(v); },
    /* 標題列上那顆迴紋針（dock.js 的 paintHead 放） */
    button: (app) => (desktop && app && app.kind !== "app" && isAI(app.url) ? '<button class="btn icon" data-d="ai" title="' + PR.esc(PR.t("讓 {name} 讀正在看的文件", { name: app.name })) + '">' + PR.icon("clip", "sm") + "</button>" : ""),
    menu(at) {
      const a = active(), d = doc();
      if (!a) return PR.toast(PR.t("等它載好再試一次"));
      const none = !d;
      PR.menu(at, [
        { label: d ? PR.t("《{title}》", { title: d.title.length > 24 ? d.title.slice(0, 23) + "…" : d.title }) : PR.t("先在左邊打開一份文件"), disabled: true },
        { label: PR.t("附上整份 PDF"), icon: "pdf", disabled: none, fn: () => attach("pdf") },
        { label: d ? PR.t("附上這一頁（第 {p} 頁的圖）", { p: d.page }) : PR.t("附上這一頁"), icon: "image", disabled: none, fn: () => attach("page") },
        { label: PR.t("貼上在文件裡選的字"), icon: "quote", disabled: none || !d.sel, fn: () => d && ask(d.sel) },
        "-",
        { label: PR.t("把它最後一則回答存成筆記"), icon: "notebook", disabled: none, fn: saveLast },
      ]);
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
      if (!d) return PR.toast(PR.t("先在左邊打開一份文件"));
      if (msg.action === "find") { if (d.P.openFind) d.P.openFind(String(msg.text || "").slice(0, 120)); return; }
      if (msg.action === "save") {
        let sel = null;
        try { sel = await run(v, "window.__foliGuest && window.__foliGuest.selection()"); } catch (e) { sel = null; }
        const app = (PR.dock && PR.dock.current && PR.dock.current()) || {};
        save(d, { question: (sel && sel.question) || "", answer: (sel && sel.md) || String(msg.text || ""), by: app.name || "AI" });
      }
    });
  }
})(window.PR);
