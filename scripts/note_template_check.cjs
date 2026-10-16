// 新筆記「從範本…」：主頁「新筆記」卡片下面那顆打開選單（五個範本），點「實驗紀錄」：建一份筆記、開到筆記頁，
// 標題帶今天的日期、圖示顏色封面都配好、段落和表格照範本；點空白的「新筆記」照舊是空的。跑完把建出來的筆記刪掉（移到回收站）。
//   node_modules/.bin/electron scripts/note_template_check.cjs [--base URL]
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", token = null, before = null;
const api = async (path, body) => (await fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Token": token || "" }, body: body ? JSON.stringify(body) : undefined })).json();
const cleanup = async () => {
  if (!before) return;
  const now = ((await api("/api/notes").catch(() => ({}))).items || []).map((n) => n.id).filter((id) => !before.has(id));
  for (const id of now) await api("/api/notes/" + id + "/delete", {}).catch(() => {});
  before = null;
};
process.on("unhandledRejection", async (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); await cleanup(); app.exit(2); });
setTimeout(async () => { console.log("TIMEOUT at " + step); await cleanup(); app.exit(3); }, 120000);
app.whenReady().then(async () => {
  const first = await api("/api/notes");
  token = first.token;
  before = new Set((first.items || []).map((n) => n.id));
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 500))); };
  step = "library";
  await win.loadURL(base + "/library").catch(() => {});
  for (let i = 0; i < 60 && !(await js("!!(window.PR && PR.lib && PR.lib.templateMenu && document.querySelector('#list .row'))").catch(() => false)); i++) await sleep(200);
  await js('PR.lib.view = "notes"; PR.lib.tag = null; PR.lib.render(); 1'); await sleep(500);
  await js('document.querySelector("[data-note-tpl]").click(); 1'); await sleep(500);
  const items = await js('JSON.stringify(Array.from(document.querySelectorAll("#ctxmenu.open .menu-list > button")).map(function (b) { return b.textContent.trim(); }))').then(JSON.parse);
  check("「新筆記」卡片下面的「從範本…」：五個範本", items.join(",") === "論文閱讀筆記,課堂筆記,會議記錄,實驗紀錄,研究想法", items);
  step = "create";
  await js('Array.from(document.querySelectorAll("#ctxmenu .menu-list > button")).find(function (b) { return b.textContent.indexOf("實驗紀錄") >= 0; }).click(); 1');
  for (let i = 0; i < 60 && !(await js("location.pathname.indexOf('/note/') === 0 && !!(window.PR && PR.note && PR.note.st && PR.note.st.note && document.body.classList.contains('note-ready'))").catch(() => false)); i++) await sleep(200);
  await sleep(600);
  const st = await js('JSON.stringify({ path: location.pathname, title: document.querySelector("#noteTitle").value, banner: document.querySelector("#noteBanner").className, hidden: document.querySelector("#noteBanner").hidden, heads: Array.from(document.querySelectorAll("#noteEd .bk-h2")).map(function (h) { return h.textContent.trim(); }), table: !!document.querySelector("#noteEd table") })').then(JSON.parse);
  const d = new Date(), today = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  const id = (st.path.match(/\/note\/([^/?#]+)/) || [])[1];
  const n = id ? await api("/api/notes/" + id) : {};
  const note = n.note || n;
  check("點「實驗紀錄」：建一份新的、開到筆記頁；標題帶今天的日期、封面森林、段落和結果表照範本", st.title === "實驗紀錄 " + today && /nb-forest/.test(st.banner) && !st.hidden &&
    st.heads.join(",") === "目的,設定,結果,觀察,下一步" && st.table && note.icon === "flask-conical" && note.color === "green" && note.banner === "forest", { st, icon: note.icon, color: note.color, banner: note.banner });
  step = "blank";
  await win.loadURL(base + "/library").catch(() => {});
  for (let i = 0; i < 60 && !(await js("!!(window.PR && PR.lib && document.querySelector('#list .row'))").catch(() => false)); i++) await sleep(200);
  await js('PR.lib.view = "notes"; PR.lib.tag = null; PR.lib.render(); 1'); await sleep(400);
  await js('document.querySelector("#list [data-newnote]").click(); 1');
  for (let i = 0; i < 60 && !(await js("location.pathname.indexOf('/note/') === 0 && !!(window.PR && PR.note && PR.note.st && PR.note.st.note)").catch(() => false)); i++) await sleep(200);
  await sleep(500);
  const blank = await js('JSON.stringify({ title: document.querySelector("#noteTitle").value, hidden: document.querySelector("#noteBanner").hidden, body: PR.note.st.note.body || "" })').then(JSON.parse);
  check("點空白的「新筆記」：照舊是一份空的（沒有封面、沒有內容）", !blank.title && blank.hidden && !blank.body.trim(), blank);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  await cleanup();
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
