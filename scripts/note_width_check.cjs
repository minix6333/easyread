// 筆記頁寫字那一欄的寬度：拖紙的右邊會變寬（兩邊一起、紙一直置中）、靠近常用寬度會吸過去、放開存在這份筆記上，
// 重新整理還在；雙擊把手回到預設；檢閱器的「版面寬度」四個選項；窄視窗不出現把手。用一份暫時的筆記，跑完刪掉。
//   node_modules/.bin/electron scripts/note_width_check.cjs [--base URL]
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", nid = null, token = null;
const api = async (path, body, method) => (await fetch(base + path, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", "X-Token": token || "" }, body: body ? JSON.stringify(body) : undefined })).json();
const cleanup = async () => { if (nid) { await api("/api/notes/" + nid + "/delete", {}).catch(() => {}); nid = null; } };  // 刪掉暫時的筆記（POST /delete：移到回收站）
process.on("unhandledRejection", async (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); await cleanup(); app.exit(2); });
setTimeout(async () => { console.log("TIMEOUT at " + step); await cleanup(); app.exit(3); }, 120000);
app.whenReady().then(async () => {
  token = (await api("/api/notes")).token;
  const n = await api("/api/notes", { title: "寬度測試", body: "第一段文字，夠長才看得出寬窄。".repeat(12) + "\n\n第二段。" });
  nid = n.id;
  const win = new BrowserWindow({ width: 1500, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 500))); };
  const open = async () => {
    await win.loadURL(base + "/note/" + nid).catch(() => {});
    for (let i = 0; i < 60 && !(await js("!!(window.PR && PR.note && PR.note.st && PR.note.st.note && PR.noteWidth && document.querySelector('.nw-grip.nw-r'))").catch(() => false)); i++) await sleep(200);
    await sleep(600);
  };
  const box = () => js('JSON.stringify((function () { var r = document.querySelector("#noteMain").getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), cx: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200) }; })())').then(JSON.parse);
  step = "open";
  await open();
  const b0 = await box();
  check("預設寬度 820（沒設過的筆記）", Math.abs(b0.w - 820) <= 2, b0);
  step = "drag";
  // 拖右邊的把手往外 150px：寬度 +300 → 1120，不在吸附範圍；再拖到 1040 附近會吸到 1040
  const grip = { x: b0.r, y: b0.y };
  wc.sendInputEvent({ type: "mouseMove", x: grip.x, y: grip.y });
  await sleep(120);
  wc.sendInputEvent({ type: "mouseDown", x: grip.x, y: grip.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 10; i++) { wc.sendInputEvent({ type: "mouseMove", x: grip.x + i * 15, y: grip.y, modifiers: ["leftButtonDown"] }); await sleep(16); }
  await sleep(120);
  const mid = await js('JSON.stringify({ tip: document.querySelector(".nw-tip").textContent, dragging: document.body.classList.contains("nw-dragging"), w: Math.round(document.querySelector("#noteMain").getBoundingClientRect().width), anim: getComputedStyle(document.querySelector("#noteMain")).transitionDuration })').then(JSON.parse);
  check("拖的時候：跟著手（沒有動畫）、上面顯示寬度", mid.dragging && Math.abs(mid.w - 1120) <= 4 && mid.tip === String(mid.w) && /^0s/.test(mid.anim), mid);
  wc.sendInputEvent({ type: "mouseMove", x: b0.cx + 523, y: grip.y, modifiers: ["leftButtonDown"] });  // 1046 → 吸到 1040
  await sleep(80);
  wc.sendInputEvent({ type: "mouseUp", x: b0.cx + 523, y: grip.y, button: "left", clickCount: 1 });
  await sleep(1500);
  const b1 = await box();
  const saved = await api("/api/notes/" + nid);
  check("放開：吸到 1040、紙還是置中、存在這份筆記上", Math.abs(b1.w - 1040) <= 2 && Math.abs(b1.cx - b0.cx) <= 2 && ((saved.note || saved).width === 1040), { b1, width: (saved.note || saved).width });
  step = "reload";
  await open();
  const b2 = await box();
  check("重新整理後還是 1040", Math.abs(b2.w - 1040) <= 2, b2);
  step = "dbl";
  const r = await box();
  wc.sendInputEvent({ type: "mouseMove", x: r.r, y: r.y });
  await sleep(100);
  for (const c of [1, 2]) { wc.sendInputEvent({ type: "mouseDown", x: r.r, y: r.y, button: "left", clickCount: c }); wc.sendInputEvent({ type: "mouseUp", x: r.r, y: r.y, button: "left", clickCount: c }); }
  await sleep(1200);
  const b3 = await box();
  check("雙擊把手：回到預設 820", Math.abs(b3.w - 820) <= 2, b3);
  step = "insp";
  if (!(await js('document.body.classList.contains("in-open")'))) { await js('document.querySelector("#inspBtn").click(); 1'); await sleep(500); }
  await js('(function () { var t = document.querySelector(\'#noteInsp [data-ni-tab="style"]\'); if (t) t.click(); })(); 1'); await sleep(400);
  const seg = await js('JSON.stringify(Array.from(document.querySelectorAll("#noteInsp .ni-width button")).map(function (b) { return b.textContent + (b.classList.contains("on") ? "*" : ""); }))').then(JSON.parse);
  await js('document.querySelector(\'#noteInsp .ni-width [data-width="-1"]\').click(); 1'); await sleep(900);
  const full = await box();
  const room = await js("(function () { var s = document.querySelector('#noteShell'), c = getComputedStyle(s); return s.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight); })()");
  await js('document.querySelector(\'#noteInsp .ni-width [data-width="640"]\').click(); 1'); await sleep(900);
  const narrow = await box();
  check("檢閱器的版面寬度：窄／標準／寬／滿版，點了馬上變", seg.join(",") === "窄,標準*,寬,滿版" && full.w >= room - 40 && Math.abs(narrow.w - 640) <= 2, { seg, full: full.w, room, narrow: narrow.w });
  step = "narrow";
  win.setContentSize(800, 800); await sleep(600);
  const hidden = await js('getComputedStyle(document.querySelector(".nw-grip")).display');
  check("窄視窗（紙已經佔滿）：沒有把手", hidden === "none", hidden);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  await cleanup();
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
