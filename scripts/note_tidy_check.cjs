// 寫得很亂的筆記按「整理」：AI 只動排版（小標題、條列、表格），先放成建議，按「採用」才換上。
// 閱讀頁筆記面板的「本頁」（寫的時候底下那排按鈕、筆記 AI 那一欄的「整理」）、筆記頁（問 AI 的「整理」）各走一遍；
// 要接假的 AI（scratchpad 的 fakecodex，提示詞裡有「只動排版」就回一份排好的），不花額度：
//   node_modules/.bin/electron scripts/note_tidy_check.cjs --base http://localhost:8794 [論文 id]
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8794");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0] || "4cf6b1e1a402";
const TIDIED = "## 取樣和微調\n\n- 取樣幫上微調\n- 遺忘來自離線資料\n\n| 方法 | 結果 |\n| --- | --- |\n| SFT | 會忘 |\n| RL | 不太忘 |";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
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
  // 真的用滑鼠點（按下、放開）：底下那排按下去時不能讓正在寫的那一塊失焦
  const click = async (sel) => {
    const r = await js("(function () { const b = document.querySelector(" + JSON.stringify(sel) + "); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const q = b.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()");
    if (!r) throw new Error("沒有 " + sel);
    wc.sendInputEvent({ type: "mouseDown", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(60);
    wc.sendInputEvent({ type: "mouseUp", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(120);
  };
  const waitFor = async (expr, ms) => { for (let i = 0; i < (ms || 15000) / 100; i++) { if (await js(expr).catch(() => false)) return true; await sleep(100); } return false; };

  step = "reader";
  await win.loadURL(base + "/read/" + id).catch(() => {});
  await waitFor("!!(window.PR && PR.pageNodes && PR.pageNodes().length && PR.toggleNotesPanel && PR.notesAi)", 20000);
  await js("PR.sideMotion = false; PR.toggleInspector && PR.toggleInspector(false); PR.openPage(1, null, { instant: true }); 1"); await sleep(800);
  wc.focus();
  const page = await js("PR.pdfPage ? PR.pdfPage() : 1");
  const orig = await js("(((PR.state.reader.page_notes || {})[" + page + "] || {}).body || '')");
  await js("PR.toggleNotesPanel(true, 'page'); 1"); await sleep(500);
  await js("PR.notesEditor('page').setValue(''); PR.focusPageNote(); 1"); await sleep(400);
  await type("取樣幫上微調");
  await key("Return");
  await type("遺忘來自離線資料");
  const s0 = await js(`JSON.stringify((function () { const r = document.querySelector("#npPageEd"), s = r && r.querySelector(".bk-strip"); return { writing: !!(r && r.classList.contains("writing")), shown: !!s && getComputedStyle(s).display === "flex", btns: s ? s.querySelectorAll("button").length : 0 }; })())`).then(JSON.parse);
  check("本頁筆記寫的時候，底下出現一排按鈕（標題、清單、編號、待辦、公式、表格、圖片）", s0.writing && s0.shown && s0.btns >= 7, s0);
  // 底下那排的「清單」：游標所在那一塊變成項目清單，游標還在裡面
  await click("#npPageEd .bk-strip [data-sb=bullet]");
  const s1 = await js(`JSON.stringify({ md: PR.notesEditor("page").getValue(), focused: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest("#npPageEd .bk-b.editing")) })`).then(JSON.parse);
  check("按底下的「清單」：這一塊變成項目清單，還在寫（沒有失焦）", s1.md === "取樣幫上微調\n\n- 遺忘來自離線資料" && s1.focused, s1);
  await click("#npPageEd .bk-strip [data-sb=bullet]");  // 再按一次換回一般的段落
  step = "tidy";
  await click("#notespanel .nai [data-nai=tidy]");  // 筆記 AI 那一欄的「整理」：剛剛在寫的那一塊不算選了，整份
  const started = await waitFor("!!document.querySelector('#npPageEd .bk-preview')", 5000);
  const label = await js("(document.querySelector('#npPageEd .bk-pv-head b') || {}).textContent || ''");
  check("按「整理」：整份送去，AI 的版本先放成建議（標題寫著「AI 整理的版本」）", started && /整理/.test(label), { started, label });
  const done = await waitFor("!!document.querySelector('#npPageEd [data-bk=pv-accept]')", 20000);
  const pv = await js("JSON.stringify({ html: (document.querySelector('#npPageEd .bk-pv-body') || {}).innerHTML || '', md: PR.notesEditor('page').getValue() })").then(JSON.parse);
  check("建議裡是排好的樣子（小標題、條列、表格），原本的筆記還沒動", done && /class="md-h"|<h\d/.test(pv.html) && /<li/.test(pv.html) && /<table/.test(pv.html) && pv.md === "取樣幫上微調\n\n遺忘來自離線資料", { done, md: pv.md, html: pv.html.slice(0, 200) });
  await click("#npPageEd [data-bk=pv-accept]");
  await sleep(700);
  const saved = await js("(((PR.state.reader.page_notes || {})[" + page + "] || {}).body || '')");
  check("按「採用」：整份換成排好的，存進這一頁的筆記", saved === TIDIED, saved);
  // 收拾：這一頁的筆記換回原本的
  await js("PR.notesEditor('page').setValue(" + JSON.stringify(orig) + "); PR.commit(Object.assign({ op: 'page_note', page: " + page + ", body: " + JSON.stringify(orig) + " })); 1");
  await sleep(600);
  const back = await js("(((PR.state.reader.page_notes || {})[" + page + "] || {}).body || '')");
  check("（收拾）這一頁的筆記換回原本的", back === orig, back);
  await sleep(400);
  const strip = await js("(function () { const s = document.querySelector('#npPageEd .bk-strip'); return s ? getComputedStyle(s).display : ''; })()");
  check("沒在寫的時候，底下那排收起來", strip === "none", strip);

  step = "note page";
  const nid = await js("PR.api('/api/notes', { method: 'POST', body: { title: '整理測試', body: '取樣幫上微調\\n\\n遺忘來自離線資料' } }).then((n) => n.id)");
  await win.loadURL(base + "/note/" + nid).catch(() => {});
  await waitFor("!!(window.PR && PR.noteEd)", 15000);
  await sleep(500);
  await click("#noteAi [data-nai=open]");
  await sleep(300);
  const hasTidy = await js("!!document.querySelector('#noteAi [data-nai=tidy]')");
  check("筆記頁的問 AI 也有「整理」", hasTidy, hasTidy);
  if (hasTidy) {
    await click("#noteAi [data-nai=tidy]");
    const ok = await waitFor("!!document.querySelector('#noteEd [data-bk=pv-accept]')", 20000);
    const md0 = await js("PR.noteEd.getValue()");
    await click("#noteEd [data-bk=pv-accept]");
    await sleep(900);
    const after = await js("PR.noteEd.getValue()");
    const stored = await js("fetch('/api/notes/' + " + JSON.stringify(nid) + ").then((r) => r.json()).then((n) => n.body)");
    check("筆記頁按「整理」再「採用」：沒選幾塊就整份整理，存進去了", ok && md0 === "取樣幫上微調\n\n遺忘來自離線資料" && after === TIDIED && stored === TIDIED, { ok, md0, after, stored });
  }
  await js("PR.api('/api/notes/' + " + JSON.stringify(nid) + " + '/delete', { method: 'POST', body: {} }); 1");
  await sleep(300);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
