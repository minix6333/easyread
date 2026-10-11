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
const specs = argv.filter((a) => a.includes("|")).map((a) => {
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
      webPreferences: { offscreen: false, backgroundThrottling: false } });
    try {
      await win.loadURL(base + "/library").catch(() => {});  // 先到同源頁，才能寫 localStorage 的主題（頁面自己轉址會讓 loadURL 拒絕，不管它）
      await win.webContents.executeJavaScript(
        'try{var p=JSON.parse(localStorage.getItem("easyread-prefs")||"{}");p.theme=' + JSON.stringify(s.theme) +
        ';localStorage.setItem("easyread-prefs",JSON.stringify(p))}catch(e){}').catch(() => {});
      await win.loadURL(base + s.url).catch(() => {});
      await new Promise((r) => setTimeout(r, wait));
      // 伺服器存的偏好會蓋掉 localStorage 的主題：載完再直接把主題掛到 <html> 上
      await win.webContents.executeJavaScript('document.documentElement.dataset.theme=' + JSON.stringify(s.theme)).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, s.name + ".png"), img.toPNG());
      console.log("shot", s.name, win.webContents.getURL());
    } catch (e) { console.log("fail", s.name, String(e)); }
    wins.push(win);  // 最後一起關：中途 destroy 會讓下一個視窗跟著死
  }
  wins.forEach((w) => { try { w.destroy(); } catch (e) {} });
  app.quit();
});
