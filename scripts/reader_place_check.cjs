// 開發用：檢查「改設定、換版面時 PDF 不會被捲走」。
// 2.1.0-tw.7 以前：在閱讀頁的 Aa 裡換主題、字體、夜間頁面、邊注…任何一項，PDF 都會被重新「對」一次——
// 沒有譯文的文件（投影片、還沒翻的 PDF）找不到段落，就從正在看的那一頁一路滑回第 1 頁，沿途每一頁的圖都重新要一次，
// 畫面一路閃、讀到哪也丟了；有譯文的被捲到上次對到的那一段。換版面也是用滑的。
// 這支在藏起來的視窗裡開外殼＋兩份文件（一份沒有譯文、一份有），PDF 捲到中間，照使用者那樣按，量 PDF 的位置、頁碼、捲了幾次、圖重載幾次。
//   node_modules/.bin/electron scripts/reader_place_check.cjs [--base http://localhost:8765] [--only 關鍵字] <沒有譯文的文件 id> <有譯文的論文 id>
// 每個情境印一行 ok／FAIL，結束碼 0＝全過。會動到開發用的偏好（主題、版面…），跑完改回來。
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("path");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const only = opt("--only", "");
const ids = argv.filter((a, i) => !a.startsWith("--") && !["--base", "--only"].includes(argv[i - 1]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (ids.length < 2) { console.log("要給兩個 id：一份沒有譯文的文件、一篇有譯文的論文"); process.exit(2); }

const W = "var w = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };";
const aa = (p, v) => '(function () { var s = document.querySelector("#settings"); if (!s.classList.contains("open")) document.querySelector(\'[data-act="settings"]\').click(); var b = s.querySelector(\'[data-p="' + p + '"][data-v="' + v + '"]\'); if (!b) return "no button"; b.click(); return "clicked"; })()';
const layoutBtn = 'document.querySelector(\'[data-act="layout"]\').click()';
// [名字, 哪一份（0＝沒有譯文、1＝有譯文）, 第幾頁（比例，0–1）, 事前準備, 動作, 怎樣算過]
//   still：PDF 的位置、頁碼都不變，捲動事件最多 1 次（版面寬度變了時照原處對一次）、圖不重載
const SCENARIOS = [
  ["Aa 換成淺色（沒有譯文的文件）", 0, 0.5, "", aa("theme", "light"), "still"],
  ["Aa 換回深色", 0, 0.5, 'PR.setPref("theme", "light")', aa("theme", "dark"), "still"],
  ["Aa 夜間頁面換成反相", 0, 0.5, "", aa("night", "invert"), "still"],
  ["Aa 字體換成明體", 0, 0.5, "", aa("font", "serif"), "still"],
  ["Aa 邊注收起", 0, 0.5, "", aa("margin", "false"), "still"],
  ["Aa 拉字級的滑桿", 0, 0.5, "", '(function () { var s = document.querySelector("#settings"); if (!s.classList.contains("open")) document.querySelector(\'[data-act="settings"]\').click(); var r = s.querySelector(\'[data-r="fs"]\'); r.value = 24; r.dispatchEvent(new Event("input", { bubbles: true })); return "slid"; })()', "still"],
  ["設定 → 外觀：強調色、紙張", 0, 0.5, "", 'PR.setLook("accent", "blue"); PR.setLook("paper", "warm"); "set"', "still"],
  ["Aa 換主題（有譯文的論文，譯文收著）", 1, 0.4, "", aa("theme", "light"), "still"],
  ["Aa 換主題（譯文開在右邊）", 1, 0.4, "PR.toggleArticle(true)", aa("theme", "light"), "still"],
  ["版面：換成文章優先、馬上換回來", 1, 0.4, "", "(async function () { " + W + layoutBtn + "; await w(1400); " + layoutBtn + "; await w(300); return 'round trip'; })()", "still-layout"],
  ["版面：在譯文裡往下讀了兩頁再換回 PDF", 1, 0.4, "", "(async function () { " + W + layoutBtn + "; await w(1400); window.scrollBy(0, 5200); await w(700); var id = PR.readingBlock(), b = PR.blockById[id], loc = PR.state.layout[id]; " + layoutBtn + "; await w(300); return (loc ? loc.page : b && b.page) || 0; })()", "follows"],
  ["跳到很遠的一頁（導覽欄的縮圖、目錄都走這條）", 0, 0.5, "", "PR.openPage(2); 'jump'", "far"],
];

let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 300000);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  ipcMain.handle("easyread:theme", (_e, theme) => { nativeTheme.themeSource = theme === "dark" || theme === "light" ? theme : "system"; return nativeTheme.shouldUseDarkColors; });
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "shots-preload.cjs") } });
  const wc = win.webContents;
  const waitFor = async (frame, cond, what) => { for (let i = 0; i < 80; i++) { if (await frame.executeJavaScript("!!(" + cond + ")").catch(() => false)) return; await sleep(250); } throw new Error("waited too long for " + what); };
  const RESET = { theme: "dark", layout: "pdf", night: "none", font: "sans", margin: true, pdfZoom: 1, fs: 21, accent: "violet", paper: "white" };
  let saved = null;
  const reset = async (vals) => {
    await win.loadURL(base + "/library").catch(() => {});
    await waitFor(wc, "window.PR && PR.token", "the library page");
    if (!saved) saved = await wc.executeJavaScript('PR.api("/api/prefs").then((p) => p.reader || {})');
    await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); localStorage.removeItem("easyread-dock"); var p = JSON.parse(localStorage.getItem("easyread-prefs") || "{}"); Object.assign(p, ' + JSON.stringify(vals) + '); localStorage.setItem("easyread-prefs", JSON.stringify(p)); PR.api("/api/prefs", { method: "POST", body: { reader: ' + JSON.stringify(vals) + " } }).then(() => 1)");
  };
  const readers = () => ids.map((id) => wc.mainFrame.framesInSubtree.find((f) => f.url.includes("/read/" + id)));
  const SNAP = 'JSON.stringify((function () { var sc = document.querySelector(".pv-scroll"); return { top: Math.round(sc.scrollTop), page: PR.pdfPage(), pdf: PR.pdfMain(), theme: document.documentElement.dataset.theme }; })())';
  let bad = 0;
  for (const [name, which, at, prep, code, rule] of SCENARIOS) {
    if (only && !name.includes(only)) continue;
    step = name + " / open";
    nativeTheme.themeSource = "dark";
    await reset(RESET);
    await win.loadURL(base + "/").catch(() => {});
    await waitFor(wc, 'typeof window.easyreadOpen === "function"', "the shell");
    await sleep(500);
    for (const id of ids) { await wc.executeJavaScript("window.easyreadOpen(" + JSON.stringify("/read/" + id) + "); 1"); await sleep(800); }
    for (let i = 0; i < 60 && readers().some((f) => !f); i++) await sleep(250);
    for (const f of readers()) await waitFor(f, "window.PR && PR.prefs && PR.state && PR.state.paper && PR.token && PR.pageNodes && PR.pageNodes().length", "a reader tab");
    await sleep(1300);
    const f = readers()[which];
    await wc.executeJavaScript('(function () { var fr = Array.from(document.querySelectorAll("#frames iframe")); var i = fr.findIndex(function (x) { return x.contentWindow.location.pathname === ' + JSON.stringify("/read/" + ids[which]) + '; }); document.querySelectorAll("#tabs .tab")[i].click(); })()');
    await sleep(500);
    step = name + " / scroll";
    const place = '(function () { var sc = document.querySelector(".pv-scroll"), nodes = PR.pageNodes(); var node = nodes[Math.max(0, Math.round((nodes.length - 1) * ' + at + '))].node; sc.scrollTop = node.offsetTop + node.offsetHeight * 0.35; sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true })); })()';
    await f.executeJavaScript(place);
    await sleep(1100);
    if (prep) { await f.executeJavaScript(prep + "; 1"); await sleep(1300); await f.executeJavaScript(place); await sleep(1100); }
    const before = JSON.parse(await f.executeJavaScript(SNAP));
    await f.executeJavaScript('(function () { var sc = document.querySelector(".pv-scroll"); var w = window.__w = { scrolls: 0, src: 0, far: 0 }; var t0 = sc.scrollTop; sc.addEventListener("scroll", function () { w.scrolls++; w.far = Math.max(w.far, Math.abs(sc.scrollTop - t0)); }, { passive: true }); new MutationObserver(function (ms) { ms.forEach(function (m) { if (m.attributeName === "src") w.src++; }); }).observe(sc, { attributes: true, subtree: true, attributeFilter: ["src"] }); })()');
    step = name + " / act";
    const did = await f.executeJavaScript(code);
    await sleep(2300);
    const after = JSON.parse(await f.executeJavaScript(SNAP));
    const w = JSON.parse(await f.executeJavaScript("JSON.stringify(window.__w)"));
    let ok = false, why = "";
    if (rule === "still") { ok = did !== "no button" && Math.abs(after.top - before.top) <= 2 && after.page === before.page && w.scrolls <= 1 && w.src === 0; why = "PDF 應該一格都不動"; }
    else if (rule === "still-layout") { ok = after.pdf && Math.abs(after.top - before.top) <= 2 && after.page === before.page && w.scrolls <= 3; why = "換過去又換回來，PDF 應該停在原處，而且是直接到位"; }
    else if (rule === "follows") { ok = after.pdf && Number(did) > 0 && after.page === Number(did) && w.scrolls <= 3; why = "PDF 應該直接翻到譯文讀到的那一頁（第 " + did + " 頁），不是用滑的"; }
    else if (rule === "far") { ok = after.page === 2 && w.src <= 8 && w.scrolls <= 60; why = "應該到第 2 頁，而且只載目的地附近的圖（不是沿途每一頁）"; }
    if (!ok) bad++;
    console.log((ok ? "ok    " : "FAIL  ") + name + "：頁 " + before.page + "→" + after.page + "、位置 " + before.top + "→" + after.top + "、捲動 " + w.scrolls + " 次（最遠 " + Math.round(w.far) + "px）、圖重載 " + w.src + " 張" + (ok ? "" : "  ← " + why));
  }
  step = "restore prefs";
  nativeTheme.themeSource = "dark";
  await reset(Object.assign({}, RESET, saved || {}));
  await sleep(300);
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy();
  app.exit(bad ? 1 : 0);
});
