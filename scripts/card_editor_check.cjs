// 閱讀頁裡寫筆記（便利貼、筆記面板的卡片）也是所見即所得：在 PDF 上選字 → 筆記 → 直接打字、⌘B、開頭「－ 」變清單、
// 底下一排按鈕加公式；Esc 存好收起，存的是 Markdown；再打開還是排好的樣子。最後把這條筆記刪掉。
//   node_modules/.bin/electron scripts/card_editor_check.cjs [--base URL] <論文 id>
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0] || "4cf6b1e1a402";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", made = null;
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 150000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 500))); };
  const key = async (keyCode, modifiers) => { wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers || [] }); if (keyCode === "Return" && !(modifiers || []).length) wc.sendInputEvent({ type: "char", keyCode: "\r" }); wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers || [] }); await sleep(80); };
  const type = async (text) => { for (const ch of text) { await wc.insertText(ch); await sleep(15); } await sleep(80); };
  const CMD = process.platform === "darwin" ? "meta" : "control";
  step = "load";
  await win.loadURL(base + "/read/" + id).catch(() => {});
  for (let i = 0; i < 80 && !(await js("!!(window.PR && PR.pageNodes && PR.pageNodes().length && PR.mountCardEditor)").catch(() => false)); i++) await sleep(200);
  await js("PR.sideMotion = false; PR.toggleInspector && PR.toggleInspector(false); PR.openPage(1, null, { instant: true }); 1"); await sleep(1500);
  wc.focus();
  step = "sticky";
  // 選「learning」→ 工具列的「筆記」
  await js(`(function () { const page = document.querySelector('.pv-page[data-n="1"]'); const s = Array.from(page.querySelectorAll('.pv-text > span')).find((x) => /learning/.test(x.textContent));
    const t = s.firstChild, i = t.textContent.indexOf('learning'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 8); s.scrollIntoView({ block: 'center' });
    const g = getSelection(); g.removeAllRanges(); g.addRange(r); document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })(); 1`);
  await sleep(500);
  await js('document.querySelector("#selbar [data-s=note]").click(); 1');
  await sleep(700);
  const s0 = await js(`JSON.stringify({ host: !!document.querySelector(".pv-sticky .md-rich-host.bk"), strip: !!document.querySelector(".pv-sticky .bk-strip"), focused: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".pv-sticky .bk-rich")) })`).then(JSON.parse);
  check("便利貼裡是所見即所得的編輯器（底下一排按鈕），一打開游標就在裡面", s0.host && s0.strip && s0.focused, s0);
  await type("這是重點");
  await key("Home", ["shift"]);
  await key("B", [CMD]);
  await key("End");
  await key("Return");
  await type("－ 第一點");
  const mid = await js(`JSON.stringify({ html: (document.querySelector(".pv-sticky .md-rich-host") || {}).innerHTML || "", src: (document.querySelector(".pv-sticky textarea[data-rich]") || {}).value })`).then(JSON.parse);
  check("⌘B 變粗、「－ 」變清單；看不見的輸入框一直拿著 Markdown", /<(b|strong)>這是重點<\/(b|strong)>/.test(mid.html) && /l-bullet/.test(mid.html) && mid.src === "**這是重點**\n\n- 第一點", { src: mid.src });
  // 底下的「公式」：插一塊公式
  await js('document.querySelector(".pv-sticky .bk-strip [data-sb=math]").click(); 1'); await sleep(300);
  await type("x^2");
  await key("Escape");  // 公式是輸入框：Esc 收起便利貼
  await sleep(600);
  const saved = await js(`JSON.stringify((function () { const ns = Object.values((PR.state.reader || {}).notes || {}).filter((n) => !n.deleted && /這是重點/.test(n.body || "")); return ns.map((n) => ({ id: n.id, body: n.body })); })())`).then(JSON.parse);
  made = saved[0] && saved[0].id;
  check("Esc 存好收起：存的是 Markdown（粗體、清單、公式）", saved.length === 1 && /^\*\*這是重點\*\*\n\n- 第一點\n\n\$\$\nx\^2\n\$\$$/.test(saved[0].body), saved);
  step = "reopen";
  if (made) {
    await js(`PR.openSticky(${JSON.stringify(made)}, { edit: true }); 1`); await sleep(700);
    const again = await js(`JSON.stringify({ html: (document.querySelector(".pv-sticky .md-rich-host") || {}).innerHTML || "" })`).then(JSON.parse);
    check("再打開來改：還是排好的樣子（粗體、清單、公式），不是一堆記號", /<strong>這是重點<\/strong>|<b>這是重點<\/b>/.test(again.html) && /katex/.test(again.html) && !/\*\*這是重點/.test(again.html), again.html.slice(0, 300));
    await key("Escape"); await sleep(400);
    await js(`PR.commit({ op: "note_del", id: ${JSON.stringify(made)} }); PR.applyMarks && PR.applyMarks(); 1`); await sleep(400);
  }
  // 便利貼裡打 @3：連到這一篇的第 3 頁（存成 [p.3](/read/…#page=3)）
  step = "mention";
  await js(`(function () { const page = document.querySelector('.pv-page[data-n="1"]'); const s = Array.from(page.querySelectorAll('.pv-text > span')).find((x) => /sampling/i.test(x.textContent));
    const t = s.firstChild, i = t.textContent.toLowerCase().indexOf('sampling'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 8); s.scrollIntoView({ block: 'center' });
    const g = getSelection(); g.removeAllRanges(); g.addRange(r); document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })(); 1`);
  await sleep(500);
  await js('document.querySelector("#selbar [data-s=note]").click(); 1');
  await sleep(700);
  await type("定義在 @3");
  let shown = false;
  for (let k = 0; k < 30 && !shown; k++) { await sleep(100); shown = await js("!!document.querySelector('.pv-sticky .bk-mention.open .bk-mi')"); }
  await key("Return");  // 放進去
  // 清單開著時按 Esc：只收清單，便利貼還開著（字留著）
  await type(" @");
  let again = false;
  for (let k = 0; k < 30 && !again; k++) { await sleep(100); again = await js("!!document.querySelector('.pv-sticky .bk-mention.open')"); }
  await key("Escape");
  await sleep(200);
  const mid2 = await js("JSON.stringify({ open: !!document.querySelector('.pv-sticky .bk-mention.open'), sticky: !!document.querySelector('.pv-sticky .md-rich-host'), src: (document.querySelector('.pv-sticky textarea[data-rich]') || {}).value || '' })").then(JSON.parse);
  await key("Backspace"); await key("Backspace");
  await key("Escape");  // 這次才收起便利貼
  await sleep(600);
  const ment = await js(`JSON.stringify(Object.values((PR.state.reader || {}).notes || {}).filter((n) => !n.deleted && /定義在/.test(n.body || "")).map((n) => ({ id: n.id, body: n.body })))`).then(JSON.parse);
  check("便利貼裡打 @3：連到這一篇的第 3 頁，存成 [p.3](/read/…#page=3)", shown && ment.length === 1 && ment[0].body === "定義在 [p.3](/read/" + id + "#page=3)", { shown, mid2, ment });
  check("「@」的清單開著時按 Esc：只收清單，便利貼還開著", again && !mid2.open && mid2.sticky && /@$/.test(mid2.src), { again, mid2 });
  for (const n of ment) await js(`PR.commit({ op: "note_del", id: ${JSON.stringify(n.id)} }); PR.applyMarks && PR.applyMarks(); 1`);
  await sleep(300);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
