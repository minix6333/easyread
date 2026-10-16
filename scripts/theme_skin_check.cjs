// 主題（設定 → 外觀 → 主題）：選一個主題，所有開著的頁面一起換（另一個視窗的閱讀頁靠 storage 事件跟上）、存到伺服器；
// 強調色回到主題自己的、背景跟著主題；自訂主題的滑桿拉了就換；重新整理後一開頭就是那個顏色（不先閃別的顏色）；
// 換主題是整個畫面淡入淡出（View Transitions），拉滑桿不是；「恢復預設外觀」回到原色。跑完把開發用的外觀改回去（原色、背景霧）。
//   node_modules/.bin/electron scripts/theme_skin_check.cjs [--base URL] <paper id>
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0] || "4cf6b1e1a402";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", restore = null;
process.on("unhandledRejection", async (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); if (restore) await restore().catch(() => {}); app.exit(2); });
setTimeout(async () => { console.log("TIMEOUT at " + step); if (restore) await restore().catch(() => {}); app.exit(3); }, 150000);
app.whenReady().then(async () => {
  const lib = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const rd = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const L = (c) => lib.webContents.executeJavaScript(c), R = (c) => rd.webContents.executeJavaScript(c);
  const errors = [];
  for (const w of [lib, rd]) w.webContents.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 600))); };
  const ready = async (w, js) => { for (let i = 0; i < 80 && !(await w.webContents.executeJavaScript(js).catch(() => false)); i++) await sleep(200); await sleep(500); };
  await lib.loadURL(base + "/library").catch(() => {});
  await ready(lib, "!!(window.PR && PR.setSkin && PR.openSettings && document.querySelector('#list .row'))");
  const before = await L('JSON.stringify(PR.look())').then(JSON.parse);
  restore = async () => { await L('PR.setLook("skin", ""); PR.setLook("accent", ' + JSON.stringify(before.accent) + '); PR.setLook("backdrop", "mist"); 1').catch(() => {}); await sleep(1500); };
  await L('PR.setLook("skin", ""); PR.setLook("backdrop", "mist"); localStorage.setItem("easyread-theme-test", "1"); 1');
  await rd.loadURL(base + "/read/" + id).catch(() => {});
  await ready(rd, "!!(window.PR && PR.state && PR.state.paper && PR.applyLook)");
  const look = (w) => w.webContents.executeJavaScript('JSON.stringify((function () { var d = document.documentElement, c = getComputedStyle(d); return { skin: d.dataset.skin || "", accent: d.dataset.accent || "", backdrop: d.dataset.backdrop || "", theme: d.dataset.theme, sheet: c.getPropertyValue("--sheet").trim(), ink: c.getPropertyValue("--ink").trim(), acc: c.getPropertyValue("--accent").trim(), skc: c.getPropertyValue("--skc-l-sheet").trim() }; })())').then(JSON.parse);
  const rgb = (w, v) => w.webContents.executeJavaScript('(function () { var e = document.createElement("i"); e.style.color = "var(' + v + ')"; document.body.append(e); var c = getComputedStyle(e).color; e.remove(); return c; })()');

  step = "pick";
  await L('window.__vt = 0; var o = document.startViewTransition; if (o) document.startViewTransition = function (f) { window.__vt++; return o.call(document, f); }; PR.openSettings("look"); 1');
  await sleep(700);
  const cards = await L('JSON.stringify(Array.from(document.querySelectorAll(".skin-card")).map(function (b) { return b.dataset.skinPick + (b.classList.contains("on") ? "*" : ""); }))').then(JSON.parse);
  check("外觀裡有主題畫廊：原色（選著）＋十個主題＋自訂", cards.length === 12 && cards[0] === "*" && cards.includes("paper") && cards[cards.length - 1] === "custom", cards);
  await L('document.querySelector(\'.skin-card[data-skin-pick="paper"]\').click(); 1');
  await sleep(1200);
  const a = await look(lib), b = await look(rd);
  const theme = a.theme;
  const sheetA = await rgb(lib, "--sheet"), sheetB = await rgb(rd, "--sheet");
  const want = theme === "dark" ? "rgb(37, 33, 27)" : "rgb(252, 248, 241)";
  check("點「紙本」：這一頁換成紙本的紙色（" + theme + "）、強調色是主題自己的、背景跟著主題；整個畫面淡入淡出換過去", a.skin === "paper" && !a.accent && a.backdrop === "auto" && sheetA === want && (await L("window.__vt")) >= 1, { a, sheetA, want, vt: await L("window.__vt") });
  check("另一個視窗的閱讀頁也跟著換（不用重新整理）", b.skin === "paper" && sheetB === want, { b, sheetB });
  const saved = await L('fetch("/api/prefs").then(function (r) { return r.json(); }).then(function (p) { return JSON.stringify(p.reader || {}); })').then(JSON.parse);
  check("存到伺服器（換台電腦、換瀏覽器都還在）", saved.skin === "paper" && saved.backdrop === "auto", { skin: saved.skin, backdrop: saved.backdrop });

  step = "custom";
  const why = await L('(function () { try { var c = document.querySelector(\'.skin-card[data-skin-pick="custom"]\'); if (!c) return "no card; dialog open=" + document.querySelector("#settingsDlg").classList.contains("open"); c.click(); return ""; } catch (e) { return String(e && e.stack || e).slice(0, 300); } })()');
  if (why) console.log("custom click: " + why);
  await sleep(1000);
  const vt0 = await L("window.__vt");
  const sliders = await L('document.querySelectorAll("input[data-skin-custom]").length');
  await L('(function () { var r = document.querySelector(\'input[data-skin-custom="h"]\'); r.value = 30; r.dispatchEvent(new Event("input", { bubbles: true })); })(); 1');
  await sleep(600);
  const c1 = await look(lib), c2 = await look(rd), vt1 = await L("window.__vt");
  check("自訂：出現三條滑桿；拉色調馬上換（這一頁和另一個視窗），拉的時候不做淡入淡出", sliders === 3 && c1.skin === "custom" && /oklch\(0\.985 [\d.]+ 30\)/.test(c1.skc) && c2.skin === "custom" && /oklch\(0\.985 [\d.]+ 30\)/.test(c2.skc) && vt1 === vt0, { sliders, c1: c1.skc, c2: c2.skc, vt0, vt1 });

  step = "reload";
  await rd.reload();
  // 一開頭（頁面自己的程式還沒跑）就已經是自訂的顏色：<head> 那一小段從 localStorage 套上
  let early = null;
  for (let i = 0; i < 50 && !early; i++) { early = await R('document.documentElement && document.documentElement.dataset.skin ? JSON.stringify({ skin: document.documentElement.dataset.skin, skc: document.documentElement.style.getPropertyValue("--skc-l-sheet"), util: !!(window.PR && PR.applyLook) }) : ""').catch(() => ""); if (!early) await sleep(20); }
  early = JSON.parse(early || "{}");
  check("重新整理：<head> 一開始就套上自訂主題（還沒載入其餘程式之前），不會先閃原色", early.skin === "custom" && /oklch\(0\.985 [\d.]+ 30\)/.test(early.skc || ""), early);

  step = "reset";
  await ready(rd, "!!(window.PR && PR.state && PR.state.paper)");
  await L('document.querySelector("[data-look-reset]").click(); 1');
  await sleep(1000);
  const r1 = await look(lib), r2 = await look(rd);
  check("恢復預設外觀：回到原色（兩個視窗都是）", !r1.skin && !r2.skin && !r1.skc, { r1, r2 });
  await restore();
  restore = null;
  const end = await L('fetch("/api/prefs").then(function (r) { return r.json(); }).then(function (p) { return JSON.stringify(p.reader || {}); })').then(JSON.parse);
  check("跑完改回開發用的外觀（原色、背景霧）", !end.skin && end.backdrop === "mist", { skin: end.skin, backdrop: end.backdrop });
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  lib.destroy(); rd.destroy(); app.exit(bad ? 1 : 0);
});
