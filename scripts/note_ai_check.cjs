// 筆記 AI 照讀者的話改筆記（common/note-ai.js、notehelp.py 的 auto）、回答收進筆記（asnote）、問 AI 的書籤：在真的畫面上用滑鼠鍵盤走一遍。
// - 本頁筆記：在一塊裡反白幾個字 → 點筆記 AI 的輸入框（範圍沒有因為失焦而不見）→「加粗」只改那一塊；用把手選兩塊 →「改成待辦」；
//   × 拿掉範圍 →「整份排好」→ 捨棄；游標在第一塊 →「寫一段總結」插在它後面；選一塊 →「刪掉」。
// - 獨立筆記：選兩塊 → 問 AI「改成待辦」→ 採用、存進去。
// - 回答收進筆記：「加入筆記」→ 本頁筆記、分類；提問紀錄「改成筆記」——都是筆記的樣子（主題當小標題，沒有「好問題」）。
// - 問 AI 的書籤：在回答上加書籤、開新對話、從書籤跳回那一則。
// 要接假的 AI（scratchpad 的 fakecodex：提示詞裡有 @@ do: 就照讀者的要求回 @@ 指令；有「改寫成筆記」就回一份筆記），不花額度：
//   node_modules/.bin/electron scripts/note_ai_check.cjs --base http://localhost:8794 [論文 id] [--log 假 codex 的記錄檔]
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8794"), logFile = opt("--log", "");
const id = argv.filter((a, i) => !a.startsWith("--") && !["--base", "--log", "--shots"].includes(argv[i - 1]))[0] || "4cf6b1e1a402";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 500)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 240000);
const lastLog = (key) => {  // 假 codex 記下的最後一筆（看伺服器送了什麼範圍）
  if (!logFile) return null;
  const rows = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && x[key]);
  return rows[rows.length - 1] || null;
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1360, height: 920, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop/.test(e.message || "")) errors.push("[" + step + "] " + (e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 700))); };
  const key = async (keyCode, modifiers) => { wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers || [] }); if (keyCode === "Return" && !(modifiers || []).length) wc.sendInputEvent({ type: "char", keyCode: "\r" }); wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers || [] }); await sleep(80); };
  const type = async (text) => { for (const ch of text) { await wc.insertText(ch); await sleep(12); } await sleep(80); };
  const at = async (sel) => {
    const r = await js("(function () { const b = document.querySelector(" + JSON.stringify(sel) + "); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const q = b.getBoundingClientRect(); return { x: Math.round(q.left + Math.min(q.width / 2, 40)), y: Math.round(q.top + q.height / 2) }; })()");
    if (!r) throw new Error("沒有 " + sel);
    return r;
  };
  const click = async (sel) => {  // 真的滑鼠（按下、放開）：按下去那一刻，筆記 AI 要記住選了哪裡
    const r = await at(sel);
    wc.sendInputEvent({ type: "mouseMove", x: r.x, y: r.y });
    wc.sendInputEvent({ type: "mouseDown", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(60);
    wc.sendInputEvent({ type: "mouseUp", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(150);
  };
  const waitFor = async (expr, ms) => { for (let i = 0; i < (ms || 15000) / 100; i++) { if (await js(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const ED = "PR.notesEditor('page')";
  const val = () => js(ED + ".getValue()");
  const chip = () => js("(document.querySelector('#notespanel .nai-scope') || {}).textContent || ''");
  const ask = async (text) => { await type(text); await key("Return"); };
  const settle = async (box) => {  // 等建議出來（有「採用」）；回傳 { label, body, old（淡掉的幾塊）}
    const ok = await waitFor("!!document.querySelector('" + box + " [data-bk=pv-accept]')", 20000);
    return Object.assign({ ok }, await js("({ label: (document.querySelector('" + box + " .bk-pv-head b') || {}).textContent || '', body: (document.querySelector('" + box + " .bk-pv-body') || {}).textContent || '', old: [...document.querySelectorAll('" + box + " .bk-b.pv-old')].map((e) => e.textContent.trim()) })"));
  };

  step = "reader";
  await win.loadURL(base + "/read/" + id).catch(() => {});
  await waitFor("!!(window.PR && PR.pageNodes && PR.pageNodes().length && PR.toggleNotesPanel && PR.notesAi && PR.noteAi)", 20000);
  await js("PR.sideMotion = false; PR.toggleInspector && PR.toggleInspector(false); PR.openPage(1, null, { instant: true }); 1"); await sleep(800);
  wc.focus();
  const page = await js("PR.pdfPage ? PR.pdfPage() : 1");
  const orig = await js("(((PR.state.reader.page_notes || {})[" + page + "] || {}).body || '')");
  const START = "# 我的筆記\n\n梯度下降每次走一小步\n\n學習率要小\n\n太大會發散";
  await js("PR.toggleNotesPanel(true, 'page'); 1"); await sleep(500);
  await js(ED + ".setValue(" + JSON.stringify(START) + "); PR.commit({ op: 'page_note', page: " + page + ", body: " + JSON.stringify(START) + " }); 1"); await sleep(500);
  const cleanup = async () => { await js(ED + ".setValue(" + JSON.stringify(orig) + "); PR.commit({ op: 'page_note', page: " + page + ", body: " + JSON.stringify(orig) + " }); 1"); await sleep(500); };

  step = "picked words";
  // 點第二塊開始編輯，反白「一小步」
  await click("#npPageEd .bk-b:nth-child(2)");
  await waitFor("!!document.querySelector('#npPageEd .bk-b.editing')", 3000);
  const picked = await js(`(function () {
    const f = document.querySelector('#npPageEd .bk-b.editing .bk-in'); if (!f) return '';
    const w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const i = n.nodeValue.indexOf('一小步'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 3); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s); } }
    return '';
  })()`);
  await click("#notespanel .nai-in");  // 點輸入框：編輯器失焦，但範圍要先記住
  const c1 = await chip();
  check("在一塊裡反白幾個字、再點筆記 AI 的輸入框：範圍記著（「選的字：一小步」），那一塊亮著", picked === "一小步" && /一小步/.test(c1) && (await js("!!document.querySelector('#npPageEd .bk-b.sel')")), { picked, c1 });
  await ask("把這幾個字加粗");
  const p1 = await settle("#npPageEd");
  const log1 = lastLog("auto");
  check("AI 說它理解成什麼（「AI 的建議：粗體」），建議只換那一塊，換掉的那一塊淡掉", p1.ok && /粗體/.test(p1.label) && /一小步/.test(p1.body) && p1.old.length === 1 && /梯度下降/.test(p1.old[0]) &&
    (!logFile || (log1 && log1.picked === "一小步" && log1.scope[0] === 2 && log1.scope[1] === 2)), { p1, log1 });
  await click("#npPageEd [data-bk=pv-accept]");
  await sleep(500);
  check("按「採用」：只有那幾個字變粗體，其他不動", (await val()) === "# 我的筆記\n\n梯度下降每次走**一小步**\n\n學習率要小\n\n太大會發散", await val());

  step = "blocks";
  await js(ED + ".selectSpan(2, 3); 1");
  await sleep(200);
  await click("#notespanel .nai-in");
  const c2 = await chip();
  await ask("改成待辦");
  const p2 = await settle("#npPageEd");
  check("選兩塊（「第 3–4 塊」）→「改成待辦」：建議是待辦清單，只換那兩塊", /第 3–4 塊/.test(c2) && p2.ok && /轉成待辦/.test(p2.label) && p2.old.length === 2, { c2, p2 });
  if (opt("--shots", "")) {  // --shots 資料夾：建議出來的樣子截一張（給人看）
    await sleep(400);
    const b = await js("(() => { const r = document.querySelector('#notespanel').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    fs.mkdirSync(opt("--shots", ""), { recursive: true });
    fs.writeFileSync(require("path").join(opt("--shots", ""), "notes-ai.png"), (await wc.capturePage({ x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.w), height: Math.ceil(b.h) })).toPNG());
  }
  await click("#npPageEd [data-bk=pv-accept]");
  await sleep(500);
  check("採用：那兩塊變成待辦", (await val()) === "# 我的筆記\n\n梯度下降每次走**一小步**\n\n- [ ] 學習率要小\n- [ ] 太大會發散", await val());

  step = "whole note";
  await js(ED + ".selectSpan(1, 1); 1");
  await sleep(150);
  await click("#notespanel .nai-in");
  await click("#notespanel [data-nai=unscope]");  // × 拿掉：整份
  const c3 = await chip();
  await ask("把整份排版排好");
  const p3 = await settle("#npPageEd");
  const log3 = lastLog("auto");
  check("× 拿掉範圍（「整份筆記」）→「把整份排版排好」：整份送去，建議換掉每一塊", /整份筆記/.test(c3) && p3.ok && /整理/.test(p3.label) && p3.old.length === 4 && (!logFile || (log3 && log3.scope[0] === null)), { c3, p3, log3 });
  const before3 = await val();
  await click("#npPageEd [data-bk=pv-reject]");
  await sleep(400);
  check("按「捨棄」：筆記照舊", (await val()) === before3 && !(await js("!!document.querySelector('#npPageEd .bk-preview')")), await val());

  step = "write new";
  await click("#npPageEd .bk-b:nth-child(1)");  // 游標在第一塊（標題）
  await waitFor("!!document.querySelector('#npPageEd .bk-b.editing')", 3000);
  await key("End");
  await click("#notespanel .nai-in");
  await ask("幫我寫一段總結");
  const p4 = await settle("#npPageEd");
  check("游標在第一塊、沒有反白 →「寫一段總結」：新的一段放在它後面，不換掉任何一塊", p4.ok && /寫一段新的/.test(p4.label) && p4.old.length === 0 && /總結/.test(p4.body), p4);
  await click("#npPageEd [data-bk=pv-accept]");
  await sleep(500);
  const v4 = await val();
  check("採用：總結接在標題後面", v4.startsWith("# 我的筆記\n\n### 總結\n\n- 取樣讓微調少忘一點\n- 第 5 頁有演算法\n\n梯度下降"), v4);

  step = "delete";
  const n5 = await js(ED + ".count()");
  await js(ED + ".selectSpan(" + (n5 - 1) + ", " + (n5 - 1) + "); 1");
  await sleep(150);
  await click("#notespanel .nai-in");
  await ask("刪掉這一塊");
  const p5 = await settle("#npPageEd");
  check("選最後一塊 →「刪掉」：建議寫著「刪掉這幾塊」，那一塊淡掉", p5.ok && /刪除/.test(p5.label) && /刪掉這幾塊/.test(p5.body) && p5.old.length === 1, p5);
  await click("#npPageEd [data-bk=pv-accept]");
  await sleep(500);
  check("採用：最後一塊不見了", (await js(ED + ".count()")) === n5 - 1 && !/太大會發散/.test(await val()), await val());

  step = "toolbar ai";
  await click("#npPageEd .bk-b:nth-child(1)");
  await waitFor("!!document.querySelector('#npPageEd .bk-b.editing')", 3000);
  await js(`(function () { const f = document.querySelector('#npPageEd .bk-b.editing .bk-in'); const w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 2); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); return 1; })()`);
  await sleep(400);
  const toolOn = await waitFor("(function () { const t = document.querySelector('#npPageEd .bk-tools'); return !!t && getComputedStyle(t).display !== 'none' && t.getBoundingClientRect().width > 0; })()", 3000);
  await click("#npPageEd .bk-tools [data-t=ai]");
  const c6 = await chip();
  check("格式工具列的 AI（反白了字再按）：範圍是那幾個字（失焦前就交出來）", toolOn && /選的字：「我的」/.test(c6), { toolOn, c6 });
  await cleanup();

  step = "note page";
  const nid = await js("PR.api('/api/notes', { method: 'POST', body: { title: '筆記 AI 測試', body: '甲\\n\\n乙\\n\\n丙' } }).then((n) => n.id)");
  await win.loadURL(base + "/note/" + nid).catch(() => {});
  await waitFor("!!(window.PR && PR.noteEd && PR.noteAi)", 15000);
  await sleep(500);
  await js("PR.noteEd.selectSpan(1, 2); 1");
  await sleep(150);
  await click("#noteAi [data-nai=open]");
  await sleep(300);
  const c7 = await js("(document.querySelector('#noteAi .nai-scope') || {}).textContent || ''");
  await click("#noteAi .nai-in");
  await ask("改成待辦");
  const p7 = await settle("#noteEd");
  await click("#noteEd [data-bk=pv-accept]");
  await sleep(900);
  const stored = await js("fetch('/api/notes/' + " + JSON.stringify(nid) + ").then((r) => r.json()).then((n) => n.body)");
  check("獨立筆記：選兩塊（「第 2–3 塊」）→ 問 AI「改成待辦」→ 採用，存進去", /第 2–3 塊/.test(c7) && p7.ok && /轉成待辦/.test(p7.label) && stored === "甲\n\n- [ ] 乙\n- [ ] 丙", { c7, p7, stored });
  await js("PR.api('/api/notes/' + " + JSON.stringify(nid) + " + '/delete', { method: 'POST', body: {} }); 1");

  step = "answer to note";
  await win.loadURL(base + "/read/" + id).catch(() => {});
  await waitFor("!!(window.PR && PR.pageNodes && PR.pageNodes().length && PR.noteAddMenu && PR.qaToNote)", 20000);
  await js("PR.openPage(1, null, { instant: true }); 1"); await sleep(600);
  wc.focus();
  const pn0 = await js("(((PR.state.reader.page_notes || {})[3] || {}).body || '')"), paper0 = await js("((PR.state.reader.paper_note || {}).body || '')");  // 「本頁筆記」是那個問題所在的第 3 頁
  const ITEM = { title: "取樣怎麼幫上微調？", body: "好問題！簡單來說，取樣讓微調更接近基礎模型。\n\n希望這樣有幫助！", page: 3 };
  await js("(function () { const b = document.createElement('button'); b.id = 'tn'; b.textContent = '加入筆記'; b.style.cssText = 'position:fixed;left:400px;top:300px;z-index:99'; document.body.append(b); b.onclick = () => PR.noteAddMenu(b, " + JSON.stringify(ITEM) + "); return 1; })()");
  await click("#tn");
  await sleep(300);
  await js("(function () { const it = [...document.querySelectorAll('#ctxmenu .mi')].find((x) => /本頁筆記/.test(x.textContent)); it.id = 'pick'; return 1; })()");
  await click("#pick");
  const got = await waitFor("/取樣怎麼幫上微調/.test(((PR.state.reader.page_notes || {})[3] || {}).body || '')", 20000);
  const pn1 = await js("(((PR.state.reader.page_notes || {})[3] || {}).body || '')");
  check("問 AI 的回答「加入筆記」→ 本頁筆記：改寫成筆記的樣子（主題當小標題、條列），沒有「好問題」「希望有幫助」", got && /### 取樣怎麼幫上微調/.test(pn1) && !/好問題|希望這樣有幫助/.test(pn1) && pn1.startsWith(pn0.trim() ? pn0.trim() : "###"), pn1.slice(0, 300));
  await click("#tn");
  await sleep(300);
  await js("(function () { const it = [...document.querySelectorAll('#ctxmenu .mi')].find((x) => /定義/.test(x.textContent)); it.id = 'pick2'; return 1; })()");
  await click("#pick2");
  await waitFor("/取樣怎麼幫上微調/.test((PR.state.reader.paper_note || {}).body || '')", 20000);
  const paper1 = await js("((PR.state.reader.paper_note || {}).body || '')");
  check("加到總結的分類：放在「## 定義」底下，小標題帶頁碼", /## 定義\n\n### 取樣怎麼幫上微調（第 3 頁）/.test(paper1), paper1.slice(-300));
  await js("PR.commit({ op: 'page_note', page: 3, body: " + JSON.stringify(pn0) + " }); PR.commit({ op: 'paper_note', body: " + JSON.stringify(paper0) + " }); document.getElementById('tn').remove(); 1");
  await sleep(400);

  step = "qa to note";
  const qa = await js("PR.api('/api/p/" + id + "/handoff', { method: 'POST', body: { do: 'qa', page: 2, question: '為什麼 SFT 會忘？', answer: '好的！因為離線資料離基礎模型太遠。', by: 'MockAI' } })");
  await js("PR.poll && PR.poll()"); await sleep(1200);
  const qid = qa && qa.note && qa.note.id;
  await waitFor("!!(PR.state.reader.notes || {})[" + JSON.stringify(qid) + "] && PR.repliesTo(" + JSON.stringify(qid) + ").length", 8000);
  await js("window.__before = new Set(Object.keys(PR.state.reader.notes || {})); PR.qaToNote(" + JSON.stringify(qid) + "); 1");
  const NEW = "Object.values(PR.state.reader.notes || {}).filter((n) => !window.__before.has(n.id) && n.kind === 'note' && !n.deleted && n.page === 2)";
  await waitFor(NEW + ".length > 0 && (PR.state.reader.notes || {})[" + JSON.stringify(qid) + "].deleted", 20000);
  const conv = await js("JSON.stringify({ old: (PR.state.reader.notes || {})[" + JSON.stringify(qid) + "], made: " + NEW + ".map((n) => ({ id: n.id, body: n.body })) })").then(JSON.parse);
  check("提問紀錄「改成筆記」：問答合成一張筆記（筆記的樣子），原本的提問收起來", conv.old && conv.old.deleted === true && conv.made.length === 1 && /^### /.test(conv.made[0].body), conv);
  // 收拾：做出來的筆記、提問、回答都刪掉
  for (const nid2 of [qid].concat(conv.made.map((x) => x.id))) await js("PR.api('/api/p/" + id + "/ops', { method: 'POST', body: { ops: [{ op: 'note_del', id: " + JSON.stringify(nid2) + ", at: PR.nowIso() }] } }).catch(() => 0)");
  const rids = await js("(PR.state.discussion.entries || []).filter((e) => e.reply_to === " + JSON.stringify(qid) + ").map((e) => e.id)");
  for (const rid of rids) await js("PR.api('/api/p/" + id + "/discussion_del', { method: 'POST', body: { id: " + JSON.stringify(rid) + " } }).catch(() => 0)");

  step = "chat bookmarks";
  await js("PR.toggleChat && PR.toggleChat(true); 1"); await sleep(600);
  await js("(function () { const b = document.querySelector('#chatpanel [data-c=new]'); if (b) b.click(); return 1; })()"); await sleep(300);
  const sendQ = async (q) => {
    await js("(function () { const t = document.getElementById('chatInput'); t.focus(); return 1; })()");
    await type(q);
    await key("Return");
    await waitFor("!!document.querySelector('#chatpanel .cm.ai[data-id] [data-c=copy]') && !document.querySelector('#chatpanel .cm.ai .spin')", 20000);
    await sleep(300);
  };
  await sendQ("書籤測試：第一個問題");
  const firstId = await js("(document.querySelector('#chatpanel .cm.ai[data-id]') || {}).dataset.id");
  await click('#chatpanel .cm.ai[data-id="' + firstId + '"] [data-c=mark]');
  await waitFor("!!document.querySelector('#chatpanel [data-c=marks]')", 5000);
  const marked = await js("JSON.stringify({ btn: !!document.querySelector('#chatpanel [data-c=marks]'), ribbon: !!document.querySelector('#chatpanel .cm.ai.marked .cm-mark') })").then(JSON.parse);
  check("問 AI：在回答上按書籤 → 那一則有記號，標題列多一顆書籤", marked.btn && marked.ribbon, marked);
  const tid1 = await js("PR.chatCurrent()");
  await js("(function () { const b = document.querySelector('#chatpanel [data-c=new]'); b.click(); return 1; })()"); await sleep(300);
  await sendQ("另一段對話的問題");
  const tid2 = await js("PR.chatCurrent()");
  await click("#chatpanel [data-c=marks]");
  await sleep(300);
  const items = await js("[...document.querySelectorAll('#ctxmenu .mi')].map((b) => b.textContent.trim() + (b.disabled ? ' (head)' : ''))");
  await js("(function () { const it = [...document.querySelectorAll('#ctxmenu .mi:not([disabled])')].find((x) => /第一個問題/.test(x.textContent)); it.id = 'jm'; return 1; })()");
  await click("#jm");
  await sleep(900);
  const jumped = await js("JSON.stringify({ cur: PR.chatCurrent(), flash: !!document.querySelector('#chatpanel .cm.ai.flash[data-id=\"" + firstId + "\"]') })").then(JSON.parse);
  check("換到別的對話後，從書籤跳回：切回那段對話、捲到那一則（閃一下）", tid1 && tid2 && tid1 !== tid2 && jumped.cur === tid1 && jumped.flash && items.some((x) => /第一個問題/.test(x)), { tid1, tid2, jumped, items });
  // 收拾：刪掉這兩段對話
  for (const t of [tid1, tid2]) await js("PR.api('/api/p/" + id + "/chat/delete', { method: 'POST', body: { thread: " + JSON.stringify(t) + " } }).catch(() => 0)");

  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
