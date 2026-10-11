// 開發用：用 Electron 把幾個頁面在指定的視窗大小、亮暗模式下截圖，檢查響應式排版。
//   node_modules/.bin/electron scripts/shots.cjs --out /tmp/shots --base http://localhost:8765 \
//     "library|/library|720x800|light" "reader|/read/<id>|1000x700|dark" ...
// 每個參數：名字|路徑|寬x高|light／dark（主題透過 localStorage 的 easyread-prefs 設）。
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = opt("--out", "/tmp/shots");
const base = opt("--base", "http://localhost:8765");
const wait = Number(opt("--wait", "1800"));
const js = opt("--js", "");
const pre = opt("--pre", "");  // --pre：進到要拍的頁面之前先跑的（改 localStorage 裡存的狀態之類）
// --wall：在最底下墊一張假的「桌面」（彩色漸層＋材質的灰），看透明的地方大概長什麼樣（真的毛玻璃是系統畫的，截不到）
const wall = argv.includes("--wall");
// --desktop：當成桌面版載入（有 window.easyreadDesktop、可以用 <webview>），看外部工具欄真的嵌網頁的樣子
const desktop = argv.includes("--desktop");
const WALL = (theme) => "html{background:" + (theme === "dark"
  ? "linear-gradient(rgba(40,40,42,.62),rgba(40,40,42,.62)),linear-gradient(125deg,#3b4a6b 0%,#7a5a8c 38%,#b0785a 68%,#2f5a52 100%)"
  : "linear-gradient(rgba(240,240,242,.66),rgba(240,240,242,.66)),linear-gradient(125deg,#7fa0d8 0%,#c79bd6 38%,#f0b48a 68%,#7fc2b0 100%)") + " fixed !important}";
const specs = argv.filter((a, i) => a.includes("|") && !["--js", "--pre", "--out", "--base", "--wait"].includes(argv[i - 1])).map((a) => {  // 選項的值裡可能也有「|」（--js 的程式碼）
  const [name, url, size, theme] = a.split("|");
  const [w, h] = (size || "1280x800").split("x").map(Number);
  return { name, url, w, h, theme: theme || "light" };
});

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const wins = [];
  for (const s of specs) {
    const win = new BrowserWindow({ width: s.w, height: s.h, show: false, useContentSize: true,
      webPreferences: Object.assign({ offscreen: false, backgroundThrottling: false }, desktop ? { webviewTag: true, preload: path.join(__dirname, "shots-preload.cjs") } : {}) });
    try {
      await win.loadURL(base + "/library").catch(() => {});  // 先到同源頁，才能寫 localStorage 的主題（頁面自己轉址會讓 loadURL 拒絕，不管它）
      await win.webContents.executeJavaScript(
        'try{var p=JSON.parse(localStorage.getItem("easyread-prefs")||"{}");p.theme=' + JSON.stringify(s.theme) +
        ';localStorage.setItem("easyread-prefs",JSON.stringify(p))}catch(e){}').catch(() => {});
      if (pre) await win.webContents.executeJavaScript(pre).catch((e) => console.log("pre fail", s.name, String(e)));
      await win.loadURL(base + s.url).catch(() => {});
      await new Promise((r) => setTimeout(r, wait));
      // 伺服器存的偏好會蓋掉 localStorage 的主題：載完再直接把主題掛到 <html> 上
      if (js) {  // --js：載完要跑的（開面板之類）；有回傳值就印出來（量位置、看狀態用，可以回傳 Promise）
        const r = await win.webContents.executeJavaScript(js).catch((e) => console.log("js fail", s.name, String(e)));
        if (r !== undefined && r !== null) console.log("js", s.name, JSON.stringify(r));
        await new Promise((r2) => setTimeout(r2, 900));
      }
      // 放在 --js 後面：改偏好會把主題套回去。外殼裡每一格都是自己的文件，要一格一格改；localStorage 也寫，免得哪一格存偏好時又被套回去
      const force = '(function(t){try{var p=JSON.parse(localStorage.getItem("easyread-prefs")||"{}");p.theme=t;localStorage.setItem("easyread-prefs",JSON.stringify(p))}catch(e){}' +
        'try{if(window.PR&&PR.prefs)PR.prefs.theme=t}catch(e){}document.documentElement.dataset.theme=t})(' + JSON.stringify(s.theme) + ')';
      for (const f of win.webContents.mainFrame.framesInSubtree) await f.executeJavaScript(force).catch(() => {});
      if (wall) { await win.webContents.insertCSS(WALL(s.theme)).catch(() => {}); await win.webContents.executeJavaScript('document.documentElement.classList.add("framed")').catch(() => {}); }  // 像在外殼裡：頁面自己不上底色
      await new Promise((r) => setTimeout(r, 500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, s.name + ".png"), img.toPNG());
      console.log("shot", s.name, win.webContents.getURL());
      await win.loadURL("about:blank").catch(() => {});  // 拍完就清空：留著的頁面之後存偏好，會把下一個視窗的主題改回去
    } catch (e) { console.log("fail", s.name, String(e)); }
    wins.push(win);  // 最後一起關：中途 destroy 會讓下一個視窗跟著死
  }
  wins.forEach((w) => { try { w.destroy(); } catch (e) {} });
  app.quit();
});
