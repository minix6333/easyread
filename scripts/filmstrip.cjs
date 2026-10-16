// 把一個動作的過程拍成一排畫格（看動畫有沒有在跳、有沒有瞬間換位置）：動作之後每 interval 毫秒拍一張，拼成一張圖。
//   node_modules/.bin/electron scripts/filmstrip.cjs --url /library --ready "JS" --act "JS" [--frames 8] [--interval 60] [--size 1440x900] [--crop x,y,w,h] [--tw 480] [--cols 4] --out file.png
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765"), url = opt("--url", "/library");
const ready = opt("--ready", "true"), act = opt("--act", ""), pre = opt("--pre", "");
const frames = +opt("--frames", "8"), interval = +opt("--interval", "60");
const [W, H] = opt("--size", "1440x900").split("x").map(Number);
const crop = opt("--crop", "");
const out = opt("--out", "/tmp/film.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => { console.log("FAILED " + String((e && e.stack) || e).slice(0, 300)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 90000);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  await win.loadURL(base + url).catch(() => {});
  for (let i = 0; i < 80 && !(await js(ready).catch(() => false)); i++) await sleep(200);
  if (pre) await js(pre);
  await sleep(900);
  const rect = crop ? (([x, y, w, h]) => ({ x, y, width: w, height: h }))(crop.split(",").map(Number)) : undefined;
  const shots = [await wc.capturePage(rect)];
  const t0 = Date.now();
  js(act + "; 1");
  for (let i = 1; i < frames; i++) {
    await sleep(Math.max(0, i * interval - (Date.now() - t0)));
    shots.push(await wc.capturePage(rect));
  }
  // 拼起來：一排四張（--cols），縮成每張 480 寬（--tw）
  const tw = +opt("--tw", "480"), sz = shots[0].getSize(), th = Math.round(sz.height * tw / sz.width), cols = Math.min(+opt("--cols", "4"), shots.length), rows = Math.ceil(shots.length / cols);
  const canvas = Buffer.alloc(cols * tw * rows * th * 4, 255);
  shots.forEach((img, k) => {
    const small = img.resize({ width: tw, height: th }).toBitmap();
    const ox = (k % cols) * tw, oy = Math.floor(k / cols) * th;
    for (let y = 0; y < th; y++) small.copy(canvas, ((oy + y) * cols * tw + ox) * 4, y * tw * 4, (y + 1) * tw * 4);
  });
  const big = nativeImage.createFromBitmap(canvas, { width: cols * tw, height: rows * th });
  fs.writeFileSync(out, big.toPNG());
  console.log("saved " + out + " (" + shots.length + " frames, " + interval + "ms apart)");
  win.destroy(); app.exit(0);
});
