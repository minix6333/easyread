// 閱讀頁的浮層（第三次大更新）：打開文件時不先露出空的紙和沒有圖示的頂欄；選字工具列的「在這份文件裡找」；
// 便利貼（筆記）有標題列；問 AI 的「找對話」和「回到最新」。只看、只點，不寫任何資料（便利貼按 Esc 收起，空的不存）。
//   node_modules/.bin/electron scripts/reader_ui_check.cjs [--base URL] <有對話、有譯文的論文 id>
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0] || "4cf6b1e1a402";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 120000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 500))); };
  step = "load";
  // 一開始（程式還沒跑）：<body class="rd-loading">，紙和頂欄都還看不到
  let first = null;
  wc.once("dom-ready", async () => { first = await js('JSON.stringify({ cls: document.body.className, paper: getComputedStyle(document.querySelector("#paper")).visibility, bar: getComputedStyle(document.querySelector("#bar")).opacity })').catch(() => null); });
  await win.loadURL(base + "/read/" + id).catch(() => {});
  for (let i = 0; i < 80 && !(await js("!!(window.PR && PR.pageNodes && PR.pageNodes().length && PR.toggleChat)").catch(() => false)); i++) await sleep(200);
  await sleep(800);
  const after = await js('JSON.stringify({ cls: document.body.className.indexOf("rd-loading") >= 0, bar: getComputedStyle(document.querySelector("#bar")).opacity })').then(JSON.parse);
  first = first ? JSON.parse(first) : null;
  check("打開文件：一開始紙和頂欄先藏著（讀取中），畫好了才出來", first && /rd-loading/.test(first.cls) && first.paper === "hidden" && after.cls === false && +after.bar === 1, { first, after });
  step = "select";
  await js("PR.sideMotion = false; PR.toggleInspector(false); PR.openPage(1, null, { instant: true }); 1"); await sleep(1200);
  const word = await js(`(function () {
    var page = document.querySelector('.pv-page[data-n="1"]'); var s = Array.from(page.querySelectorAll('.pv-text > span')).find(function (x) { return /learning/.test(x.textContent); });
    if (!s) return ''; var t = s.firstChild, i = t.textContent.indexOf('learning'); var r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 8);
    var g = getSelection(); g.removeAllRanges(); g.addRange(r); s.scrollIntoView({ block: 'center' });
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return t.textContent.slice(i, i + 8); })()`);
  await sleep(600);
  const bar = await js('JSON.stringify({ open: document.querySelector("#selbar").classList.contains("open"), btns: Array.from(document.querySelectorAll("#selbar > button[data-s]")).map(function (b) { return b.dataset.s; }) })').then(JSON.parse);
  await js('document.querySelector("#selbar [data-s=find]").click(); 1'); await sleep(900);
  const find = await js('JSON.stringify({ open: PR.findOpen(), value: (document.querySelector("#findbar input") || {}).value, n: (document.querySelector("#findbar .n") || {}).textContent })').then(JSON.parse);
  check("選字工具列多一顆「在這份文件裡找」：點了搜尋列打開、拿選的字來找", word === "learning" && bar.open && bar.btns.includes("find") && find.open && find.value === "learning" && /\d/.test(find.n || ""), { word, bar, find });
  await js("PR.closeFind(); 1");
  step = "sticky";
  await js(`(function () { var page = document.querySelector('.pv-page[data-n="1"]'); var s = Array.from(page.querySelectorAll('.pv-text > span')).find(function (x) { return /learning/.test(x.textContent); });
    var t = s.firstChild, i = t.textContent.indexOf('learning'); var r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 8); var g = getSelection(); g.removeAllRanges(); g.addRange(r);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })(); 1`);
  await sleep(500);
  await js('document.querySelector("#selbar [data-s=note]").click(); 1'); await sleep(700);
  const st = await js('JSON.stringify((function () { var c = document.querySelector(".pv-sticky .card"); if (!c) return null; var h = c.querySelector(":scope > .hd"), cs = getComputedStyle(c); return { hd: h ? getComputedStyle(h).display : "", lbl: h && h.querySelector(".lbl") ? getComputedStyle(h.querySelector(".lbl")).display : "", outline: cs.boxShadow.indexOf("1.5px") >= 0 }; })())').then(JSON.parse);
  check("便利貼（新筆記）：上面有一排標題（圖示、「我的筆記」），沒有粗的彩色外框", st && st.hd === "flex" && st.lbl !== "none" && !st.outline, st);
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1'); await sleep(500);
  const left = await js('!!document.querySelector(".pv-sticky")');
  check("Esc 收起：空的便利貼不留下來", !left, left);
  step = "chat";
  await js("PR.toggleChat(true); 1"); await sleep(1500);
  const n = await js('PR.$$ ? 0 : 0; (function () { document.querySelector("[data-c=list]").click(); return document.querySelectorAll("#chatpanel .ch-thread[data-t]").length; })()');
  await sleep(300);
  const hasFind = await js('!!document.querySelector("#chatpanel .ch-find input") && document.activeElement === document.querySelector("#chatpanel .ch-find input")');
  await js('(function () { var i = document.querySelector("#chatpanel .ch-find input"); i.value = "導讀"; i.dispatchEvent(new Event("input", { bubbles: true })); })(); 1'); await sleep(200);
  const shown = await js('Array.from(document.querySelectorAll("#chatpanel .ch-thread[data-t]")).filter(function (r) { return !r.hidden; }).map(function (r) { return r.querySelector(".tt").textContent; })');
  check("問 AI 的對話清單：超過六串有「找對話」（打開就能打字），打字只留標題對得上的", n > 6 && hasFind && shown.length >= 1 && shown.length < n && shown.every((t) => t.includes("導讀")), { n, hasFind, shown });
  // 選一串很長的對話，捲到最上面：出現「回到最新」，點了回到底
  // 一串串點，找一串長到要捲的（開發用的文獻庫裡有）
  let longest = null;
  for (let k = 0; k < 8 && !longest; k++) {
    if (k) { await js('document.querySelector("[data-c=list]").click(); 1'); await sleep(300); }
    const t = await js('(function () { var rows = Array.from(document.querySelectorAll("#chatpanel .ch-thread[data-t]")); rows.forEach(function (r) { r.hidden = false; }); var r = rows[' + k + ']; if (!r) return ""; r.click(); return r.dataset.t; })()');
    await sleep(1000);
    if (await js('(function () { var b = document.querySelector("#chatList"); return !!b && b.scrollHeight > b.clientHeight + 300; })()')) longest = t;
  }
  await js('(function () { var b = document.querySelector("#chatList"); b.scrollTop = 0; b.dispatchEvent(new Event("scroll")); })(); 1'); await sleep(300);
  const j1 = await js('JSON.stringify({ tall: document.querySelector("#chatList").scrollHeight > document.querySelector("#chatList").clientHeight + 300, on: document.querySelector(".ch-jump").classList.contains("on") })').then(JSON.parse);
  await js('document.querySelector(".ch-jump").click(); 1'); await sleep(1200);
  const j2 = await js('JSON.stringify((function () { var b = document.querySelector("#chatList"); return { gap: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), on: document.querySelector(".ch-jump").classList.contains("on") }; })())').then(JSON.parse);
  check("長的對話往上捲：出現「回到最新」，點了回到最底、鈕收起來", !!longest && j1.tall && j1.on && j2.gap < 4 && !j2.on, { longest, j1, j2 });
  await js("PR.toggleChat(false); 1"); await sleep(400);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
