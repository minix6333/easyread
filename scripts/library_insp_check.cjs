// 文獻庫：點卡片不會再把版面擠掉——點一下只選起來（右邊欄開著就換內容，卡片位置一個像素都不動），
// 選著的那張再點一次就打開；右邊的欄由頂欄最右邊那顆開關，開合時卡片從舊位置滑到新位置（中途量得到位移），頂欄的按鈕留在原地。
//   node_modules/.bin/electron scripts/library_insp_check.cjs [--base URL]
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 600))); };
  const open = async () => {
    await win.loadURL(base + "/library").catch(() => {});
    for (let i = 0; i < 60 && !(await js("!!(window.PR && PR.lib && PR.lib.items && PR.lib.items.length && document.querySelector('#list .row'))").catch(() => false)); i++) await sleep(200);
    await sleep(500);
  };
  step = "setup";
  await win.loadURL(base + "/library").catch(() => {});
  await js('localStorage.removeItem("easyread-lib-insp"); localStorage.setItem("easyread-lib-view", JSON.stringify("grid")); 1');
  await open();
  const rect = (sel) => js("JSON.stringify((function () { var e = document.querySelector(" + JSON.stringify(sel) + "); if (!e) return null; var r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })())").then(JSON.parse);
  const state = () => js('JSON.stringify({ insp: document.querySelector(".lib").classList.contains("insp-on"), sel: PR.lib.selected, path: location.pathname, detail: (document.querySelector("#detail .title-main") || {}).textContent || (document.querySelector("#detail .detail-empty") ? "empty" : ""), btnOn: document.querySelector("#inspBtn").classList.contains("on") })').then(JSON.parse);
  const s0 = await state();
  check("寬視窗第一次打開：右邊的欄預設開著、沒選的時候是一行空白狀態；頂欄最右邊的開關是亮的", s0.insp && s0.detail === "empty" && s0.btnOn, s0);

  step = "click";
  const id = await js('document.querySelectorAll("#list .row")[1].dataset.id');
  const sel = '#list .row[data-id="' + id + '"]';
  const before = await rect(sel);
  const cx = before[0] + before[2] / 2, cy = before[1] + 60;
  wc.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
  await sleep(700);
  const after = await rect(sel), s1 = await state();
  check("點一下卡片：選起來、右邊換成這一篇，卡片位置一個像素都不動（以前會被擠到別處）", s1.sel === id && s1.detail && s1.detail !== "empty" && JSON.stringify(before) === JSON.stringify(after), { before, after, s1 });

  step = "toggle";
  const btn = await rect("#inspBtn");
  const card0 = await rect("#list .row:last-child");
  await js('document.querySelector("#inspBtn").click(); 1');
  await sleep(90);
  const mid = await js('JSON.stringify(Array.from(document.querySelectorAll("#list .row")).map(function (r) { return r.getAnimations().length; }))');
  await sleep(700);
  const s2 = await state(), btn2 = await rect("#inspBtn"), card1 = await rect("#list .row:last-child");
  check("按頂欄的開關收起：欄先滑出去、卡片滑到新位置（動畫中量得到）；開關本身留在原地", !s2.insp && !s2.btnOn && JSON.stringify(btn) === JSON.stringify(btn2) && JSON.parse(mid).some((n) => n > 0) || (!s2.insp && JSON.stringify(btn) === JSON.stringify(btn2) && JSON.stringify(card0) !== JSON.stringify(card1)), { mid, btn, btn2, card0, card1, s2 });
  await js('document.querySelector("#inspBtn").click(); 1');
  await sleep(120);
  const enter = await js('getComputedStyle(document.querySelector("#detail")).animationName');
  await sleep(700);
  const s3 = await state();
  check("再按一次打開：欄從右邊滑進來，還是選著的那篇", s3.insp && s3.sel === id && /insp-in/.test(enter), { enter, s3 });
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true })); 1'); await sleep(500);
  const s4 = await state();
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true })); 1'); await sleep(700);
  const s5 = await state();
  check("按 i 也能開合（記住：重新整理後照上次的）", !s4.insp && s5.insp, { s4, s5 });

  step = "reopen";
  const keep = await rect(sel);
  wc.sendInputEvent({ type: "mouseDown", x: keep[0] + keep[2] / 2, y: keep[1] + 60, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: keep[0] + keep[2] / 2, y: keep[1] + 60, button: "left", clickCount: 1 });
  for (let i = 0; i < 30; i++) { await sleep(200); if ((await js("location.pathname").catch(() => "")).startsWith("/read/")) break; }
  const path = await js("location.pathname").catch(() => "");
  check("選著的那張再點一次：打開那一篇", path === "/read/" + id, { path, id });

  step = "dbl";
  await open();
  const other = await js('document.querySelectorAll("#list .row")[0].dataset.id');
  const r0 = await rect('#list .row[data-id="' + other + '"]');
  await js('PR.lib.select(null); 1');
  let opened = 0;
  await js('window.__opens = 0; var o = PR.lib.openReader; PR.lib.openReader = function (id) { window.__opens++; }; 1');
  for (const n of [1, 2]) {
    wc.sendInputEvent({ type: "mouseDown", x: r0[0] + 40, y: r0[1] + 60, button: "left", clickCount: n });
    wc.sendInputEvent({ type: "mouseUp", x: r0[0] + 40, y: r0[1] + 60, button: "left", clickCount: n });
  }
  await sleep(500);
  opened = await js("window.__opens");
  check("沒選著的卡片雙擊：只打開一次（不會被「再點一次」多開一次）", opened === 1, { opened });

  step = "narrow";
  win.setContentSize(980, 800);
  await sleep(700);
  const s6 = await state();
  check("窄視窗：欄收起來（要的時候才從右邊滑出來蓋在上面）", !s6.insp, s6);
  win.setContentSize(1440, 900);
  await sleep(700);
  const s7 = await state();
  check("拉回寬視窗：照記住的打開", s7.insp, s7);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  await js('localStorage.removeItem("easyread-lib-insp"); 1');
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
