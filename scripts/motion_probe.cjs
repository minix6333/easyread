// 量動畫順不順：在真的頁面上做一個動作（開合面板、換分頁…），動作後 900 毫秒內每一幀的間隔、超過 50 毫秒的長工作、
// 還有「版面重排」花的時間（PerformanceObserver 拿不到 layout，用 rAF 間隔判斷：超過 25ms 的幀算掉幀）。
//   node_modules/.bin/electron scripts/motion_probe.cjs [--base URL] [--scale 2]
// 印出每個動作：幀數、最慢一幀、掉幀數（>25ms）、長工作總時間。
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const only = opt("--only", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => { console.log("FAILED " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 240000);
app.commandLine.appendSwitch("force-device-scale-factor", opt("--scale", "2"));
const ACTIONS = [
  // [名字, 網址, 準備（等它好）, 動作（回傳後開始量）, 還原]
  ["主頁：收合側欄", "/library", "!!document.querySelector('#list .row')", 'document.querySelector("#sideBtn").click()', 'document.querySelector("#sideBtn").click()'],
  ["主頁：開合詳細資訊欄", "/library", "!!document.querySelector('#list .row')", 'document.querySelector("#inspBtn").click()', 'document.querySelector("#inspBtn").click()'],
  ["主頁：格子⇄清單", "/library", "!!document.querySelector('#list .row')", 'document.querySelector(\'[data-lv="list"]\').click()', 'document.querySelector(\'[data-lv="grid"]\').click()'],
  ["閱讀頁：開右側面板", "/read/4cf6b1e1a402", "!!(window.PR && PR.toggleInspector && PR.pageNodes && PR.pageNodes().length)", "PR.toggleInspector()", "PR.toggleInspector()"],
  ["閱讀頁：開右側面板（不用 View Transitions，比較用）", "/read/4cf6b1e1a402", "!!(window.PR && PR.toggleInspector && PR.pageNodes && PR.pageNodes().length)", "PR.sideMotion = false; PR.toggleInspector()", "PR.toggleInspector(); PR.sideMotion = true"],
  ["閱讀頁：開左側目錄", "/read/4cf6b1e1a402", "!!(window.PR && PR.toggleNav && PR.pageNodes && PR.pageNodes().length)", "PR.toggleNav()", "PR.toggleNav()"],
  ["筆記頁：開檢閱器", "/note/c9abd3a8bc47", "!!(window.PR && PR.note && PR.note.st && PR.note.st.note)", 'document.querySelector("#inspBtn").click()', 'document.querySelector("#inspBtn").click()'],
  ["筆記頁：開目錄", "/note/c9abd3a8bc47", "!!(window.PR && PR.note && PR.note.st && PR.note.st.note)", 'document.querySelector("#outlineBtn").click()', 'document.querySelector("#outlineBtn").click()'],
  ["設定：開對話框", "/library", "!!(window.PR && PR.openSettings)", 'PR.openSettings("look")', 'document.querySelector("#settingsDlg").classList.remove("open")'],
];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  let cur = "";
  for (const [name, url, ready, act, undo] of ACTIONS) {
    if (only && !name.includes(only)) continue;
    if (cur !== url) { await win.loadURL(base + url).catch(() => {}); cur = url; }
    for (let i = 0; i < 80 && !(await js(ready).catch(() => false)); i++) await sleep(200);
    await sleep(900);
    const run = async (code) => js('new Promise(function (done) { var t = [], lt = 0, ob; try { ob = new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { lt += e.duration; }); }); ob.observe({ entryTypes: ["longtask"] }); } catch (e) {} var t0 = performance.now(), last = t0; (function f(now) { t.push(now - last); last = now; if (now - t0 < 900) requestAnimationFrame(f); else { if (ob) ob.disconnect(); t.shift(); done(JSON.stringify({ n: t.length, max: Math.round(Math.max.apply(null, t)), drop: t.filter(function (x) { return x > 25; }).length, long: Math.round(lt) })); } })(t0); ' + code + "; })").then(JSON.parse);
    const a = await run(act);
    await sleep(500);
    const b = await run(undo);
    await sleep(600);
    console.log(name.padEnd(16, "　") + "  開：" + a.n + " 幀、最慢 " + a.max + "ms、掉 " + a.drop + "、長工作 " + a.long + "ms" + "  ｜  收：" + b.n + " 幀、最慢 " + b.max + "ms、掉 " + b.drop + "、長工作 " + b.long + "ms");
  }
  win.destroy(); app.exit(0);
});
