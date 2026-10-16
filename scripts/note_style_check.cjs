// 筆記的封面、紙張、專注模式：更多選單「加上封面」放一張和筆記顏色搭的漸層、封面上的鈕可以換、拿掉；檢閱器 → 樣式的封面色塊、紙張；
// 存在這份筆記上（重新整理還在）、文獻庫的筆記卡片上面也是那張封面；⌘⇧F 進專注模式（兩欄收起、頂欄藏起來），Esc 出來、兩欄照原樣打開。
// 用一份暫時的筆記，跑完刪掉（移到回收站）。
//   node_modules/.bin/electron scripts/note_style_check.cjs [--base URL]
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", nid = null, token = null;
const api = async (path, body) => (await fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Token": token || "" }, body: body ? JSON.stringify(body) : undefined })).json();
const cleanup = async () => { if (nid) { await api("/api/notes/" + nid + "/delete", {}).catch(() => {}); nid = null; } };
process.on("unhandledRejection", async (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); await cleanup(); app.exit(2); });
setTimeout(async () => { console.log("TIMEOUT at " + step); await cleanup(); app.exit(3); }, 120000);
app.whenReady().then(async () => {
  token = (await api("/api/notes")).token;
  const n = await api("/api/notes", { title: "封面測試", body: "第一段。\n\n第二段。\n\n第三段。" });
  nid = n.id;
  await api("/api/notes/" + nid, { color: "teal" });
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 500))); };
  const open = async () => {
    await win.loadURL(base + "/note/" + nid).catch(() => {});
    for (let i = 0; i < 60 && !(await js("!!(window.PR && PR.note && PR.note.st && PR.note.st.note && document.body.classList.contains('note-ready') && PR.noteBanner)").catch(() => false)); i++) await sleep(200);
    await sleep(500);
  };
  const saved = async () => { await sleep(900); const r = await api("/api/notes/" + nid); return r.note || r; };
  const banner = () => js('JSON.stringify({ hidden: document.querySelector("#noteBanner").hidden, cls: document.querySelector("#noteBanner").className, h: Math.round(document.querySelector("#noteBanner").getBoundingClientRect().height), body: document.body.classList.contains("has-banner") })').then(JSON.parse);
  step = "open";
  await open();
  const b0 = await banner();
  check("沒設封面：紙上沒有那一塊", b0.hidden && !b0.body, b0);
  step = "add";
  await js('document.querySelector("#noteMore").click(); 1'); await sleep(400);
  const items = await js('JSON.stringify(Array.from(document.querySelectorAll("#ctxmenu .menu-list > button")).map(function (b) { return b.textContent.trim(); }))').then(JSON.parse);
  await js('Array.from(document.querySelectorAll("#ctxmenu .menu-list > button")).find(function (b) { return b.textContent.indexOf("加上封面") >= 0; }).click(); 1');
  await sleep(400);
  const b1 = await banner(), s1 = await saved();
  check("更多選單「加上封面」：放一張和筆記顏色搭的漸層（青綠 → 海鹽），存在這份筆記上", items.some((t) => t.includes("加上封面")) && !b1.hidden && /nb-sea/.test(b1.cls) && b1.h >= 140 && s1.banner === "sea", { items, b1, banner: s1.banner });
  step = "pick";
  await js('document.querySelector("#noteBanner [data-nb=pick]").click(); 1'); await sleep(400);
  const sw = await js('document.querySelectorAll("#bannerPop.open .nb-sw").length');
  await js('document.querySelector(\'#bannerPop [data-b="dusk"]\').click(); 1'); await sleep(300);
  const b2 = await banner(), s2 = await saved();
  check("封面上的「換封面」：挑選的小框有十組漸層，點了馬上換", sw === 10 && /nb-dusk/.test(b2.cls) && s2.banner === "dusk", { sw, b2, banner: s2.banner });
  await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 1'); await sleep(200);
  step = "style";
  if (!(await js('document.body.classList.contains("in-open")'))) { await js('document.querySelector("#inspBtn").click(); 1'); await sleep(700); }
  await js('(function () { var t = document.querySelector(\'#noteInsp [data-ni-tab="style"]\'); if (t) t.click(); })(); 1'); await sleep(400);
  const row = await js('JSON.stringify({ sw: document.querySelectorAll("#noteInsp .ni-banners .nb-sw").length, on: (document.querySelector("#noteInsp .ni-banners .nb-sw.on") || {}).dataset ? document.querySelector("#noteInsp .ni-banners .nb-sw.on").dataset.banner : null, paper: Array.from(document.querySelectorAll("#noteInsp .ni-paper button")).map(function (b) { return b.textContent + (b.classList.contains("on") ? "*" : ""); }) })').then(JSON.parse);
  await js('document.querySelector(\'#noteInsp [data-paper="dots"]\').click(); 1'); await sleep(300);
  const paper = await js('JSON.stringify({ attr: document.body.dataset.paper || "", bg: getComputedStyle(document.querySelector("#noteMain")).backgroundImage.slice(0, 40) })').then(JSON.parse);
  const s3 = await saved();
  check("檢閱器 → 樣式：封面一排（沒有＋十組＋自己的圖）、紙張（空白／方格／點陣）；選點陣馬上鋪上、存起來", row.sw === 12 && row.on === "dusk" && row.paper.join(",") === "空白*,方格,點陣" && paper.attr === "dots" && /radial-gradient/.test(paper.bg) && s3.paper === "dots", { row, paper, saved: s3.paper });
  step = "reload";
  await open();
  const b4 = await banner(), p4 = await js('document.body.dataset.paper || ""');
  check("重新整理：封面、紙張都還在", /nb-dusk/.test(b4.cls) && !b4.hidden && p4 === "dots", { b4, p4 });
  step = "library";
  const lib = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  await lib.loadURL(base + "/library").catch(() => {});
  for (let i = 0; i < 60 && !(await lib.webContents.executeJavaScript("!!(window.PR && PR.lib && PR.lib.notes && PR.lib.notes.length)").catch(() => false)); i++) await sleep(200);
  await lib.webContents.executeJavaScript('PR.lib.view = "notes"; PR.lib.tag = null; PR.lib.render(); 1'); await sleep(500);
  const card = await lib.webContents.executeJavaScript('(function () { var c = document.querySelector(\'.ncard[data-note="' + nid + '"] .nc-banner\'); return c ? c.className : ""; })()');
  check("文獻庫的筆記卡片：上面一條是那張封面", /nb-dusk/.test(card), card);
  lib.destroy();
  step = "remove";
  const r = JSON.parse(await js('JSON.stringify(document.querySelector("#noteBanner").getBoundingClientRect())'));
  wc.sendInputEvent({ type: "mouseMove", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); await sleep(300);
  await js('document.querySelector("#noteBanner [data-nb=off]").click(); 1'); await sleep(300);
  const b5 = await banner(), s5 = await saved();
  check("封面上的「拿掉」：那一塊不見、存成沒有封面", b5.hidden && !b5.body && s5.banner === "", { b5, banner: s5.banner });
  step = "focus";
  if (!(await js('document.body.classList.contains("in-open")'))) { await js('document.querySelector("#inspBtn").click(); 1'); await sleep(700); }
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true, bubbles: true })); 1'); await sleep(900);
  const f1 = await js('JSON.stringify({ on: document.body.classList.contains("focus-mode"), insp: document.body.classList.contains("in-open"), bar: getComputedStyle(document.querySelector(".topbar")).opacity, ai: getComputedStyle(document.querySelector(".note-ai")).opacity })').then(JSON.parse);
  check("⌘⇧F 專注模式：檢閱器收起、頂欄和「問 AI」藏起來", f1.on && !f1.insp && +f1.bar < 0.05 && +f1.ai < 0.05, f1);
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1'); await sleep(900);
  const f2 = await js('JSON.stringify({ on: document.body.classList.contains("focus-mode"), insp: document.body.classList.contains("in-open"), bar: getComputedStyle(document.querySelector(".topbar")).opacity })').then(JSON.parse);
  check("Esc 離開：頂欄回來、檢閱器照原來打開", !f2.on && f2.insp && +f2.bar > 0.95, f2);
  if (await js('document.body.classList.contains("in-open")')) { await js('document.querySelector("#inspBtn").click(); 1'); await sleep(500); }
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  await cleanup();
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
