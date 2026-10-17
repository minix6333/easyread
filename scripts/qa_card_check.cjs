// 提問卡片排成一篇短文（margin.js 的 qa）＋打開閱讀（qa-read.js）：
// 問題是標題、沒有問號圖示、回答沒有框；長的回答收著，「繼續閱讀」和右上角的書本打開整篇；Esc 關掉、開著的時候方向鍵不翻 PDF。
// 畫面上放一張假的提問和回答（不存：PR.commit 攔下來，最後確認一次都沒送）。
//   node_modules/.bin/electron scripts/qa_card_check.cjs <論文 id> [--base URL]
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765"), pid = argv.find((a) => /^[0-9a-f]{6,}$/.test(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
const fail = (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 500)); app.exit(2); };
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error("TIMEOUT")), 120000);
if (!pid) { console.log("FAILED — 要給一篇論文的 id"); process.exit(2); }
const LONG = Array.from({ length: 24 }, (_, i) => "第 " + (i + 1) + " 段：期望值是把每個可能的值乘上它出現的機率再加起來，連續的時候加總變成積分。").join("\n\n");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 860, show: false, webPreferences: { backgroundThrottling: false, partition: "qa-" + Date.now() } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "")) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (cond, what) => { for (let i = 0; i < 100; i++) { if (await js("!!(" + cond + ")").catch(() => false)) return; await sleep(100); } throw new Error("waited too long for " + what); };
  const move = async (p) => { wc.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y }); await sleep(200); };
  const click = async (p) => { await move(p); wc.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 }); await sleep(400); };
  const key = async (k) => { wc.sendInputEvent({ type: "keyDown", keyCode: k }); wc.sendInputEvent({ type: "keyUp", keyCode: k }); await sleep(300); };
  const at = (sel) => js("(() => { const e = document.querySelector(" + JSON.stringify(sel) + "); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
  step = "open reader";
  await win.loadURL(base + "/read/" + pid).catch(() => {});
  await waitFor("window.PR && PR.state && PR.state.reader && PR.renderNotesPanel && PR.openQa", "the reader");
  await sleep(700);
  wc.focus();
  await js("window.__commits = []; PR.commit = (op) => { window.__commits.push(op); return Promise.resolve(); }; 1");
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 600))); };
  step = "fake question";
  await js("(" + function (long) {
    const S = PR.state, now = new Date().toISOString(), page = PR.pdfPage ? PR.pdfPage() : 1;
    S.reader.notes.__qa = { id: "__qa", kind: "question", side: "pdf", page, anchor: "page:" + page, quote: "Continuous random variable", body: "連續的隨機變數，期望值為什麼要用積分？", created: now, updated: now };
    S.reader.notes.__qb = { id: "__qb", kind: "question", side: "pdf", page, anchor: "page:" + page, quote: "", body: "還沒問的問題", created: now, updated: now };
    S.discussion.entries = (S.discussion.entries || []).concat([{ id: "__qa_r", reply_to: "__qa", by: "GPT-6.1-Sol", at: now, body: long }]);
    PR.toggleNotesPanel(true, "notes");
    return 1;
  } + ")(" + JSON.stringify(LONG) + ")");
  await waitFor("document.querySelector('#notespanel .card[data-note=\"__qa\"]')", "the card");
  await js("document.querySelector('#notespanel .card[data-note=\"__qa\"]').scrollIntoView({ block: 'start' }); document.querySelector('#notespanel .np-list').scrollTop -= 30; 1");
  await sleep(300);
  const look = await js("(" + function () {
    const c = document.querySelector('#notespanel .card[data-note="__qa"]'), r = c.querySelector(".reply");
    const p = document.querySelector('#notespanel .card[data-note="__qb"]');
    return {
      qa: c.classList.contains("qa"), title: (c.querySelector(".hd .qa-t") || {}).textContent || "", icon: !!c.querySelector(".hd .ic"),
      box: r ? getComputedStyle(r).backgroundColor : "", by: (c.querySelector(".rft .who") || {}).textContent || "", day: (c.querySelector(".rft .meta") || {}).textContent || "",
      more: (c.querySelector('.more[data-a="read"]') || {}).textContent || "", actsHidden: getComputedStyle(c.querySelector(".hd .acts")).opacity === "0",
      pending: !!(p && p.querySelector('.qa-wait [data-a="ask"]')), helpIcon: document.querySelectorAll('#notespanel .card.k-question .hd .ic').length,
    };
  } + ")()");
  check("提問排成短文：問題是標題、沒有問號圖示、回答沒有框，底下一行是模型和日期",
    look.qa && /期望值為什麼要用積分/.test(look.title) && !look.icon && !look.helpIcon && /rgba\(0, 0, 0, 0\)|transparent/.test(look.box) && look.by === "GPT-6.1-Sol" && /\d/.test(look.day), look);
  check("動作平常藏著；長的回答收著，有「繼續閱讀」；還沒回答的有「讓 AI 回答」", look.actsHidden && look.more.length > 0 && look.pending, look);
  step = "continue reading";
  await click(await at('#notespanel .card[data-note="__qa"] .more[data-a="read"]'));
  const sheet = await js("(() => { const q = document.querySelector('#qar'); return q && { h1: q.querySelector('h1').textContent, paras: q.querySelectorAll('.qar-ans p').length, quote: (q.querySelector('.qar-q') || {}).textContent || '', by: (q.querySelector('.qar-by') || {}).textContent || '', focus: document.activeElement && document.activeElement.className }; })()");
  check("「繼續閱讀」打開整篇：標題、原文、整段回答（沒有收起來）、署名", !!sheet && /期望值為什麼要用積分/.test(sheet.h1) && sheet.paras === 24 && /Continuous/.test(sheet.quote) && /GPT-6\.1-Sol/.test(sheet.by), sheet);
  step = "keys while open";
  // 從頁邊的卡片打開時，PDF 那邊算是有焦點（PR.pdfFocus）：← → PageDown 平常會翻頁
  await js("PR.pdfFocus = true; 1");
  const page0 = await js("PR.pdfPage ? PR.pdfPage() : 0");
  await key("Down"); await key("Right"); await key("PageDown");
  await sleep(500);
  const page1 = await js("PR.pdfPage ? PR.pdfPage() : 0");
  const scrolled = await js("document.querySelector('.qar-body').scrollTop");
  check("開著的時候方向鍵、PageDown 捲這篇，不翻後面的 PDF", page0 === page1 && scrolled > 0, { page0, page1, scrolled });
  await key("Escape");
  check("Esc 關掉", !(await js("!!document.querySelector('#qar')")), {});
  await js("PR.pdfFocus = true; 1");
  await key("Right");
  await sleep(700);
  const page2 = await js("PR.pdfPage ? PR.pdfPage() : 0");
  check("（對照）關掉之後 → 照常翻頁", page2 !== page0, { page0, page2 });
  await key("Left");
  await sleep(500);
  step = "book button";
  await move(await at('#notespanel .card[data-note="__qa"] .qa-t'));
  const shown = await js("getComputedStyle(document.querySelector('#notespanel .card[data-note=\"__qa\"] .hd .acts')).opacity");
  await click(await at('#notespanel .card[data-note="__qa"] [data-a="read"]:not(.more)'));
  check("滑過去右上角出現動作，書本那顆也打開整篇", shown === "1" && (await js("!!document.querySelector('#qar')")), { shown });
  await click({ x: 30, y: 430 });  // 點紙外面
  check("點紙外面關掉", !(await js("!!document.querySelector('#qar')")), {});
  step = "cleanup";
  await js("(() => { const S = PR.state; delete S.reader.notes.__qa; delete S.reader.notes.__qb; S.discussion.entries = S.discussion.entries.filter((e) => e.id !== '__qa_r'); PR.renderNotesPanel(); return 1; })()");
  check("只是看：一次都沒有存", (await js("window.__commits.length")) === 0, await js("window.__commits"));
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  app.exit(bad ? 1 : 0);
});
