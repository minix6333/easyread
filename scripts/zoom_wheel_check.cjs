// PDF 縮放：Windows 的滑鼠滾輪按著 Ctrl 轉一格（一次 100 像素）只能變一階（10%），不能一下跳到 400%；
// 觸控板捏合（一連串很小的 deltaY）照舊跟手。用真的滾輪事件打在閱讀頁的 PDF 上，量 pdfZoom。
//   node_modules/.bin/electron scripts/zoom_wheel_check.cjs [--base URL] <paper id>
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail))); };
  await win.loadURL(base + "/read/" + id).catch(() => {});
  for (let i = 0; i < 80 && !(await js("!!(window.PR && PR.setPdfZoom && PR.pdfMain && PR.pdfMain() && PR.pageNodes && PR.pageNodes().length)").catch(() => false)); i++) await sleep(200);
  const before = await js("(PR.prefs || {}).pdfZoom || 1");
  const zoom = () => js("(PR.prefs || {}).pdfZoom || 1");
  const reset = async () => { await js("PR.setPdfZoom(1); 1"); await sleep(400); };
  const box = JSON.parse(await js('JSON.stringify((function () { var r = document.querySelector(".pv-scroll").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })())'));
  // Electron 的 deltaY 和網頁的正負相反：正的是往上（網頁裡 deltaY < 0，放大）
  const wheel = async (dy, precise) => { wc.sendInputEvent({ type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: dy, wheelTicksY: precise ? 0 : Math.sign(dy), modifiers: ["control"], canScroll: true, hasPreciseScrollingDeltas: !!precise }); };

  step = "notch";
  await reset();
  await wheel(100, false); await sleep(450);
  const one = await zoom();
  check("Windows 滾輪按著 Ctrl 往上轉一格：放大一階（約 110%），不是一下跳到 400%", one >= 1.08 && one <= 1.12, { one });
  for (let i = 0; i < 4; i++) { await wheel(100, false); await sleep(60); }
  await sleep(450);
  const five = await zoom();
  check("連轉五格：約 1.1⁵ ≈ 161%（每一格一階，越轉越大但不會暴衝）", five >= 1.5 && five <= 1.72, { five });
  await wheel(-100, false); await sleep(450);
  const back = await zoom();
  check("往下轉一格：縮小一階", back < five && back > five / 1.13, { five, back });
  step = "burst";
  await reset();
  for (let i = 0; i < 3; i++) await wheel(120, false);  // 同一幀裡來了好幾格（舊式觸控板模擬捏合就是這樣）
  await sleep(500);
  const burst = await zoom();
  check("同一幀擠進三格 120：還是三階（約 133%）", burst >= 1.25 && burst <= 1.4, { burst });
  step = "pinch";
  await reset();
  for (let i = 0; i < 30; i++) { await wheel(2, true); await sleep(16); }
  await sleep(450);
  const pinch = await zoom();
  check("觸控板捏合（30 個很小的事件）照舊跟手：約 200%", pinch >= 1.8 && pinch <= 2.25, { pinch });
  for (let i = 0; i < 40; i++) { await wheel(1, true); await sleep(16); }
  await sleep(450);
  const slow = await zoom();
  check("慢慢捏（一次只差一點點）也會動，不會被四捨五入吃掉", slow > pinch + 0.3, { pinch, slow });
  step = "cap";
  for (let i = 0; i < 40; i++) { await wheel(100, false); await sleep(30); }
  await sleep(450);
  const cap = await zoom();
  await wheel(-100, false); await sleep(450);
  const fromCap = await zoom();
  check("最多 400%；在最大時往回轉一格馬上縮小（沒有卡著要先「還」回去）", cap === 4 && fromCap < 4, { cap, fromCap });
  check("函式：一格 100（Windows）→ ×1.1；一格三行（deltaMode 1）→ ×1.1；捏合的小事件 → 照比例", Math.abs(await js("PR.pinchFactor(-100, 0)") - 1.1) < 1e-9 && Math.abs(await js("PR.pinchFactor(-3, 1)") - 1.1) < 1e-9 && Math.abs(await js("PR.pinchFactor(-2, 0)") - Math.exp(0.024)) < 1e-9, {});
  await js("PR.setPdfZoom(" + JSON.stringify(before) + "); 1");
  await sleep(600);
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
