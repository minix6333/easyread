// 開發用：重現／檢查「換主題之後整個視窗一直閃」。
// 桌面版換主題會一起改系統外觀（nativeTheme.themeSource，視窗材質要跟著亮暗），每一格都會收到「系統外觀變了」；
// 以前每個閱讀分頁收到就把自己記著的主題套回去、還存檔，兩個分頁記的不一樣就互相蓋個沒完。
// 這支在藏起來的視窗裡開外殼＋兩份文件，讓其中一格換主題，數接下來幾秒系統外觀被改了幾次、偏好被存了幾次。
//   node_modules/.bin/electron scripts/theme_loop_check.cjs [--base http://localhost:8765] [--only 關鍵字] <paperId1> <paperId2>
// 每個情境印一行：ok＝換過去就停、每一格顏色一致；LOOP＝系統外觀一直被改（畫面在閃）；SPLIT＝停了但有的格深有的格淺。
// 結束碼 0＝全部 ok。
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require("electron");
const path = require("path");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const only = opt("--only", "");
const ids = argv.filter((a, i) => !a.startsWith("--") && !["--base", "--only"].includes(argv[i - 1]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每個情境：在哪一格（reader0 / reader1 / library）做什麼。都是使用者會做的事
const SCENARIOS = [
  ["閱讀頁的 Aa 換成淺色", "reader0", 'PR.setPref("theme", "light")'],
  ["文獻庫的「⋯ → 換成淺色」", "library", "PR.toggleTheme()"],
  ["設定 → 外觀 → 淺色", "library", 'PR.setTheme ? PR.setTheme("light") : PR.toggleTheme()'],
  ["設定 → 外觀 → 跟隨系統", "library", 'PR.setTheme ? PR.setTheme("auto") : 0'],
  ["背景的那一格重新套用設定（縮放、改字級之後都會）", "reader1", "PR.applyPrefs()"],
  ["某一格記的主題和大家不一樣（舊版就是這樣開始互相蓋的）", "reader1", 'PR.prefs.theme = "light"; PR.applyPrefs()'],
  ["系統外觀自己變了（日落自動變深色那種），主題是自己選的深色", "main", "light"],
  ["先換淺色、馬上又換回深色", "reader0", 'PR.setPref("theme", "light"); PR.setPref("theme", "dark")'],
  // 設定對話框：先看過「閱讀」那一頁（它會記下當時的偏好），再到「外觀」換淺色、按完成。舊版按完成時把記下的舊主題寫回去
  ["設定：看過「閱讀」分頁 → 「外觀」換淺色 → 完成", "library", '(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const q = (s) => document.querySelector("#settingsDlg " + s); await PR.openSettings("reading"); await w(300); q(\'[data-set-tab="look"]\').click(); await w(200); const b = q(\'[data-look-theme="light"]\'); if (b) b.click(); else { const sel = q("#themeSel"); if (sel) { sel.value = "light"; sel.dispatchEvent(new Event("change", { bubbles: true })); } } await w(200); q("#setSave").click(); })()'],
  ["設定：同上，在閱讀頁裡開的設定", "reader0", '(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const q = (s) => document.querySelector("#settingsDlg " + s); await PR.openSettings("reading"); await w(300); q(\'[data-set-tab="look"]\').click(); await w(200); q(\'[data-look-theme="light"]\').click(); await w(200); q("#setSave").click(); })()'],
];

let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at step: " + step + " — " + String(e && e.message || e).slice(0, 200)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 240000);
app.whenReady().then(async () => {
  let flips = 0, saves = 0;
  ipcMain.handle("easyread:theme", (_e, theme) => {  // 和 electron/main.cjs 一樣
    const next = theme === "dark" || theme === "light" ? theme : "system";
    if (nativeTheme.themeSource !== next) flips++;
    nativeTheme.themeSource = next;
    return nativeTheme.shouldUseDarkColors;
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://*/api/prefs*"] }, (d, cb) => { if (d.method === "POST") saves++; cb({}); });
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "shots-preload.cjs") } });
  const reset = 'var p = JSON.parse(localStorage.getItem("easyread-prefs") || "{}"); p.theme = "dark"; localStorage.setItem("easyread-prefs", JSON.stringify(p)); 1';
  // 等頁面上某件事成立（loadURL 回來時腳本不一定都跑完了）
  const waitFor = async (frame, cond, what) => {
    for (let i = 0; i < 60; i++) { if (await frame.executeJavaScript("!!(" + cond + ")").catch(() => false)) return; await sleep(250); }
    throw new Error("waited too long for " + what);
  };
  let bad = 0;
  for (const [name, where, code] of SCENARIOS) {
    if (only && !name.includes(only)) continue;
    // 每個情境都從頭來：主題深色（伺服器存的也是）、外殼開著文獻庫和兩份文件
    step = name + " / reset";
    nativeTheme.themeSource = "dark";
    await win.loadURL(base + "/library").catch(() => {});
    await win.webContents.executeJavaScript('localStorage.removeItem("easyread-shell"); ' + reset);
    await waitFor(win.webContents, "window.PR && PR.token", "the library page's token");
    await win.webContents.executeJavaScript('PR.api("/api/prefs", { method: "POST", body: { reader: { theme: "dark" } } }).then(() => 1)');
    step = name + " / open shell";
    await win.loadURL(base + "/").catch(() => {});
    await waitFor(win.webContents, 'typeof window.easyreadOpen === "function"', "the shell");
    await sleep(800);
    step = name + " / open readers";
    for (const id of ids) {
      const r = await win.webContents.executeJavaScript("(function () { try { window.easyreadOpen(" + JSON.stringify("/read/" + id) + "); return 'opened'; } catch (e) { return 'error: ' + location.href + ' ' + String(e && e.stack || e).slice(0, 300); } })()");
      if (r !== "opened") throw new Error(r);
      await sleep(600);
    }
    step = name + " / wait for readers";
    for (let i = 0; i < 60 && win.webContents.mainFrame.framesInSubtree.filter((f) => /\/read\//.test(f.url)).length < ids.length; i++) await sleep(250);
    for (const f of win.webContents.mainFrame.framesInSubtree.filter((x) => /\/read\//.test(x.url))) await waitFor(f, "window.PR && PR.prefs && PR.state && PR.state.paper && PR.token", "a reader tab");
    await sleep(1200);  // 開好之後各自從伺服器拿偏好、套用，等它們靜下來
    const all = () => win.webContents.mainFrame.framesInSubtree;
    const readers = () => all().filter((f) => /\/read\//.test(f.url));
    const frameOf = (w) => (w === "library" ? all().find((f) => /\/library/.test(f.url)) : readers()[+w.slice(-1)]);
    const targets = () => [["shell", win.webContents.mainFrame], ["library", frameOf("library")], ["reader0", readers()[0]], ["reader1", readers()[1]]].filter((t) => t[1]);
    // 每一格數自己的 data-theme 被改了幾次
    for (const [, f] of targets()) await f.executeJavaScript('window.__n = 0; new MutationObserver(() => { window.__n++; }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); 1').catch(() => {});
    flips = 0; saves = 0;
    step = name + " / trigger in " + where;
    if (where === "main") nativeTheme.themeSource = code;  // 不是 App 改的：直接動系統外觀
    else await frameOf(where).executeJavaScript(code + "; 1");
    step = name + " / observe";
    await sleep(5000);
    const state = {};
    let most = 0;
    for (const [n, f] of targets()) {
      const r = await f.executeJavaScript('[document.documentElement.dataset.theme, window.PR && PR.prefs ? PR.prefs.theme : "", window.__n]').catch(() => ["?", "", 0]);
      state[n] = r[0] + (r[1] ? "(記著 " + r[1] + ")" : "") + " 改了" + r[2] + "次";
      most = Math.max(most, r[2]);
    }
    const stored = await win.webContents.executeJavaScript('JSON.parse(localStorage.getItem("easyread-prefs") || "{}").theme');
    const shown = new Set(Object.values(state).map((v) => v.split(/[( ]/)[0]));
    const looping = flips > 4 || most > 20, split = shown.size > 1;  // 主題屬性幾秒內被改幾十次以上＝畫面在閃
    if (looping || split) bad++;
    console.log((looping ? "LOOP " : split ? "SPLIT" : "ok   ") + " " + name + "：系統外觀改了 " + flips + " 次、存偏好 " + saves + " 次、localStorage 是 " + stored + "、" + JSON.stringify(state));
  }
  // 留下乾淨的狀態（開發用的偏好檔會被這支改到）
  await win.loadURL(base + "/library").catch(() => {});
  await waitFor(win.webContents, "window.PR && PR.token", "the library page's token").catch(() => {});
  await win.webContents.executeJavaScript(reset + '; PR.api("/api/prefs", { method: "POST", body: { reader: { theme: "dark" } } }).then(() => 1)').catch(() => {});
  await sleep(300);
  win.destroy();
  app.exit(bad ? 1 : 0);
});
