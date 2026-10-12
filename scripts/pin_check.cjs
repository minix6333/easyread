// 開發用：「釘住一塊」和「設為封面」在真的閱讀頁裡走一遍：
//   框選一塊 → 草稿上方出現兩顆小鈕 → 圖釘：那一塊浮在 PDF 這一格的角落（對到的是框的那一塊）、沒有多存一則筆記 →
//   往下捲兩頁它還在原位 → 拖位置、拉大小 → 點頁碼回到那一頁 → × 收掉 →
//   再框一塊「設為封面」→ 文獻庫清單上的封面換了（網址的版本變了、圖拿得到）→ 改回自動的。
//   node_modules/.bin/electron scripts/pin_check.cjs [--base http://localhost:8765] <論文 id>
// 會暫時改那篇論文的封面，跑完改回自動的。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const pid = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!pid) { console.log("要給一篇論文的 id"); process.exit(2); }

let step = "start", cleanup = null;
process.on("unhandledRejection", async (e) => {
  console.log("FAILED at step: " + step + " — " + String((e && e.stack) || e).slice(0, 500));
  if (cleanup) await cleanup().catch(() => {});
  app.exit(2);
});
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 120000);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const api = async (path, body) => {
    const token = (await (await fetch(base + "/api/notes")).json()).token;
    const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: JSON.stringify(body) } : {});
    return r.json().catch(() => null);
  };
  const item = async () => ((await api("/api/library")) || { items: [] }).items.find((i) => i.id === pid) || {};
  cleanup = async () => { await api("/api/p/" + pid + "/item", { cover: null }); };
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 700))); };

  step = "open";
  await win.loadURL(base + "/library").catch(() => {});
  await wc.executeJavaScript('var p = JSON.parse(localStorage.getItem("easyread-prefs") || "{}"); p.layout = "pdf"; p.pdfZoom = 1; localStorage.setItem("easyread-prefs", JSON.stringify(p)); 1');
  await win.loadURL(base + "/read/" + pid).catch(() => {});
  for (let i = 0; i < 80 && !(await wc.executeJavaScript("!!(window.PR && PR.state && PR.state.paper && PR.pageNodes && PR.pageNodes().length && PR.pinRegion)").catch(() => false)); i++) await sleep(150);
  await sleep(1200);
  const notes0 = await wc.executeJavaScript("Object.values(PR.state.reader.notes || {}).filter((n) => !n.deleted).length");
  // 像使用者那樣：按框選、在第 2 頁上從 (20%, 15%) 拖到 (80%, 42%)
  const region = (page, a, b) => '(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); PR.openPage(' + page + ', null, { instant: true }); await w(350); PR.toggleRegion(true); const node = PR.pageNodes()[' + (page - 1) + '].node, r = node.getBoundingClientRect(); const at = (fx, fy) => ({ bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }); node.dispatchEvent(new MouseEvent("mousedown", at(' + a[0] + ', ' + a[1] + '))); document.dispatchEvent(new MouseEvent("mousemove", at(' + (a[0] + b[0]) / 2 + ', ' + (a[1] + b[1]) / 2 + '))); document.dispatchEvent(new MouseEvent("mouseup", at(' + b[0] + ', ' + b[1] + '))); await w(350); const st = document.querySelector(".pv-sticky"); return { sticky: !!st, extras: st ? Array.from(st.querySelectorAll(".st-extras [data-rx]")).map((x) => x.dataset.rx) : [] }; })()';

  step = "pin";
  const r1 = await wc.executeJavaScript(region(2, [0.2, 0.15], [0.8, 0.42]));
  check("框選一塊：草稿上方有「釘住」和「設為封面」兩顆", r1.sticky && r1.extras.join() === "pin,cover", r1);
  await wc.executeJavaScript('document.querySelector(\'.st-extras [data-rx="pin"]\').click(); 1');
  await sleep(500);
  const p1 = await wc.executeJavaScript('(() => { const el = document.querySelector("#pageview > .pin"); if (!el) return null; const r = el.getBoundingClientRect(), img = el.querySelector(".pin-img"), cs = getComputedStyle(img), ir = img.getBoundingClientRect(); return { n: PR.pinCount(), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), ratio: +(ir.width / ir.height).toFixed(2), size: cs.backgroundSize, pos: cs.backgroundPosition, bg: /page-002/.test(cs.backgroundImage), label: el.querySelector("[data-pin=go]").textContent.trim(), sticky: !!document.querySelector(".pv-sticky"), notes: Object.values(PR.state.reader.notes || {}).filter((n) => !n.deleted).length, inView: r.right <= innerWidth && r.top >= 0 }; })()');
  const pm = await wc.executeJavaScript("(() => { const m = PR.state.paper.meta.pages[1]; return (0.6 * m.w) / (0.27 * m.h); })()");
  check("按圖釘：那一塊浮在 PDF 這一格的角落，畫的是第 2 頁框的那一塊（比例對、位置對），草稿收掉、沒多存筆記", !!p1 && p1.n === 1 && p1.bg && Math.abs(p1.ratio - pm) < 0.06 && Math.abs(parseFloat(p1.size) - 166.7) < 1.5 && Math.abs(parseFloat(p1.pos) - 50) < 1.5 && Math.abs(parseFloat(p1.pos.split(" ")[1]) - 20.5) < 1.5 && /2/.test(p1.label) && !p1.sticky && p1.notes === notes0 && p1.inView, { p1, want: +pm.toFixed(2) });

  step = "stays while scrolling";
  await wc.executeJavaScript("PR.openPage(5, null, { instant: true }); 1");
  await sleep(500);
  const p2 = await wc.executeJavaScript('(() => { const r = document.querySelector("#pageview > .pin").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), page: PR.pdfPage() }; })()');
  check("翻到第 5 頁：釘住的那一塊還在原來的位置", p2.page === 5 && p2.x === p1.x && p2.y === p1.y, { p1: [p1.x, p1.y], p2 });

  step = "drag and resize";
  const moved = await wc.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const el = document.querySelector("#pageview > .pin"), hd = el.querySelector(".pin-hd .grow"); const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX: x, clientY: y }); let r = hd.getBoundingClientRect(); const x0 = r.left + 10, y0 = r.top + 10; hd.dispatchEvent(ev("pointerdown", x0, y0)); document.dispatchEvent(ev("pointermove", x0 - 140, y0 + 90)); document.dispatchEvent(ev("pointerup", x0 - 140, y0 + 90)); await w(60); const a = el.getBoundingClientRect(); const sz = el.querySelector(".pin-size"); r = sz.getBoundingClientRect(); sz.dispatchEvent(ev("pointerdown", r.left + 8, r.top + 8)); document.dispatchEvent(ev("pointermove", r.left + 8 + 120, r.top + 8)); document.dispatchEvent(ev("pointerup", r.left + 8 + 120, r.top + 8)); await w(60); const b = el.getBoundingClientRect(), ir = el.querySelector(".pin-img").getBoundingClientRect(); return { x: Math.round(a.left), y: Math.round(a.top), w0: Math.round(a.width), w1: Math.round(b.width), ratio: +(ir.width / ir.height).toFixed(2), dragging: el.classList.contains("dragging") }; })()');
  check("抓標題列拖：跟著走；拉右下角：變寬、圖的比例不變", moved.x === p1.x - 140 && moved.y === p1.y + 90 && moved.w1 === moved.w0 + 120 && Math.abs(moved.ratio - pm) < 0.06 && !moved.dragging, { moved, p1: [p1.x, p1.y] });

  step = "jump back and close";
  await wc.executeJavaScript('document.querySelector("#pageview > .pin [data-pin=go]").click(); 1');
  await sleep(1300);
  const backTo = await wc.executeJavaScript("PR.pdfPage()");
  await wc.executeJavaScript('document.querySelector("#pageview > .pin [data-pin=x]").click(); 1');
  await sleep(400);
  const gone = await wc.executeJavaScript('({ pins: document.querySelectorAll("#pageview > .pin").length, n: PR.pinCount() })');
  check("點頁碼：回到第 2 頁；按 ×：收掉", backTo === 2 && gone.pins === 0 && gone.n === 0, { backTo, gone });

  step = "set cover";
  const before = await item();
  const r2 = await wc.executeJavaScript(region(2, [0.1, 0.1], [0.9, 0.45]));
  await wc.executeJavaScript('document.querySelector(\'.st-extras [data-rx="cover"]\').click(); 1');
  await sleep(700);
  const after = await item();
  const img = await fetch(base + after.cover).then(async (r) => ({ code: r.status, type: r.headers.get("content-type"), bytes: (await r.arrayBuffer()).byteLength, etag: !!r.headers.get("etag") })).catch((e) => ({ err: String(e) }));
  const toast = await wc.executeJavaScript('(document.querySelector("#toast.open") || {}).textContent || ""');
  check("再框一塊「設為封面」：文獻庫清單上那一篇的封面換了（網址的版本變了、圖拿得到），閱讀頁說一聲", r2.sticky && !before.cover_custom && after.cover_custom === true && after.cover !== before.cover && img.code === 200 && /webp/.test(img.type || "") && img.bytes > 2000 && img.etag && /封面|cover/i.test(toast), { before: before.cover, after: after.cover, img, toast });
  await api("/api/p/" + pid + "/item", { cover: null });
  const reset = await item();
  check("改回自動的：網址回到原來那一版", reset.cover === before.cover && reset.cover_custom === false, { reset: reset.cover, before: before.cover });
  cleanup = null;
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy();
  app.exit(bad ? 1 : 0);
});
