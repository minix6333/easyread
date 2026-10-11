// 開發用：每一種頁面都載入一遍、把主要的面板都開一次，收集主控台的錯誤和沒接住的例外。
// 發版前一定跑（2.1.0-tw.5 的教訓：單頁截圖都好好的，主控台其實一直在報錯）。
//   node_modules/.bin/electron scripts/console_check.cjs [--base http://localhost:8765] <論文 id> [<投影片 id>] [<筆記 id>]
// 每一頁印一行 ok／ERRORS；結束碼 0＝都沒有錯誤。會暫時把閱讀版面換成文章優先再換回 PDF 優先（開發用的偏好最後是 layout pdf）。
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const ids = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base");
const [paper, slides, note] = ids;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = "const w = (ms) => new Promise((r) => setTimeout(r, ms));";

// 每一頁：網址、載完之後要做的事（把面板都開一遍；回傳的東西會印出來）
const PAGES = [
  ["/library", "(async () => { " + W + " PR.lib.view = 'notes'; PR.lib.render(); await w(200); const cards = document.querySelectorAll('.ncard').length; PR.lib.view = 'all'; PR.lib.render(); await PR.openSettings(); await w(400); const tabs = document.querySelectorAll('#settingsDlg [data-tab]').length; document.querySelector('#settingsDlg').classList.remove('open'); return { cards, tabs }; })()"],
  paper && ["/read/" + paper, "(async () => { " + W + " const out = {}; for (const t of ['page', 'notes', 'paper']) { PR.toggleNotesPanel(true, t); await w(350); out[t] = document.querySelectorAll('#notespanel .card, #notespanel .bk-b').length; } PR.toggleChat && PR.toggleChat(true); await w(350); PR.toggleInfo && PR.toggleInfo(true); await w(300); PR.toggleNav && PR.toggleNav(); await w(300); PR.toggleNav && PR.toggleNav(); PR.openSide && PR.openSide(null); await w(200); return out; })()"],
  paper && ["/read/" + paper + "#article", "(async () => { " + W + " PR.setPref('layout', 'article'); await w(900); PR.renderMargin(); await w(300); const out = { layout: PR.prefs.layout, cards: document.querySelectorAll('#margin .card, .inline-notes .card').length, pins: document.querySelectorAll('.note-pin').length }; PR.toggleNotesPanel(true, 'notes'); await w(400); out.panel = document.querySelectorAll('#notespanel .card').length; PR.openSide(null); PR.setPref('layout', 'pdf'); await w(700); out.back = PR.prefs.layout; return out; })()"],
  slides && ["/read/" + slides, "(async () => { " + W + " PR.toggleNotesPanel(true, 'page'); await w(400); PR.openSide(null); return { pages: ((PR.state.paper.meta || {}).pages || []).length }; })()"],
  note && ["/note/" + note, "(async () => { " + W + " await PR.note.ready; const out = {}; document.querySelector('#outlineBtn').click(); if (!document.body.classList.contains('in-open')) document.querySelector('#inspBtn').click(); await w(300); for (const t of Array.from(document.querySelectorAll('#noteInsp [data-ni-tab]'))) { t.click(); await w(150); out[t.dataset.niTab] = document.querySelectorAll('#noteInsp .ni-body > *').length; } PR.noteEd.select(0); await w(100); PR.noteEd.menuFor({ x: 300, y: 300 }); await w(200); out.menu = document.querySelectorAll('#ctxmenu .mi').length; PR.closeMenu(); document.querySelector('#outlineBtn').click(); document.querySelector('#inspBtn').click(); return out; })()"],
  ["/", "(async () => { " + W + " await w(1200); return { frames: document.querySelectorAll('iframe').length, tabs: document.querySelectorAll('#tabs .tab').length }; })()"],
].filter(Boolean);

app.whenReady().then(async () => {
  ipcMain.handle("easyread:theme", () => true);
  const wins = [];
  let bad = 0;
  for (const [url, code] of PAGES) {
    const errors = [];
    const win = new BrowserWindow({ width: 1360, height: 880, show: false, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "shots-preload.cjs") } });
    win.webContents.on("console-message", (e) => {
      if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push(String(e.message).slice(0, 200) + " @" + String(e.sourceId || "").replace(base, "") + ":" + e.lineNumber);
    });
    await win.loadURL(base + url.replace(/#.*/, "")).catch(() => {});
    await sleep(2600);
    let info = "";
    try { info = JSON.stringify(await win.webContents.executeJavaScript(code)); } catch (e) { errors.push("腳本丟出：" + String(e).slice(0, 200)); }
    await sleep(500);
    if (errors.length) bad++;
    console.log((errors.length ? "ERRORS " : "ok     ") + url + " " + info + (errors.length ? " :: " + errors.slice(0, 4).join(" | ") : ""));
    await win.loadURL("about:blank").catch(() => {});
    wins.push(win);  // 最後一起關：中途 destroy 會讓下一個視窗跟著死
  }
  wins.forEach((w) => { try { w.destroy(); } catch (e) {} });
  app.exit(bad ? 1 : 0);
});
