// 開發用：「加到筆記」（閱讀頁選字 → 摘錄到獨立筆記，帶出處）在外殼裡整條路走一遍：
//   PDF 上選字 → 工具列的筆記本 → 新筆記 → 筆記裡是一塊引文＋出處連結 → 把那份筆記並排開著再摘一次（直接出現在編輯器裡、也存進去了）→
//   點筆記裡的出處：閱讀頁回到那一頁 → 把一段摘錄「放」進筆記的某一塊前面（拖放的那一半）→ 筆記關掉之後再摘（走伺服器）→ 選著字開始拖時帶著摘錄。
//   node_modules/.bin/electron scripts/excerpt_check.cjs [--base http://localhost:8765] <有文字層的論文 id>
// 用開發的文獻庫：會建一份暫時的筆記，跑完刪掉（連回收站裡的）。每一項印 ok／FAIL，結束碼 0＝全過。
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
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 150000);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const api = async (path, body) => {
    const token = (await (await fetch(base + "/api/notes")).json()).token;
    const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: JSON.stringify(body) } : {});
    return r.json().catch(() => null);
  };
  const before = ((await api("/api/notes")) || { items: [] }).items.map((n) => n.id);
  const mine = async () => ((await api("/api/notes")) || { items: [] }).items.filter((n) => !before.includes(n.id));
  cleanup = async () => { for (const n of await mine()) { const d = await api("/api/notes/" + n.id + "/delete", {}); if (d && d.trash) await api("/api/trash", { action: "purge", name: d.trash }); } };
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame);
  const waitFrame = async (re, cond, what) => { for (let i = 0; i < 100; i++) { const f = frames().find((x) => re.test(x.url)); if (f && (await f.executeJavaScript("!!(" + cond + ")").catch(() => false))) return f; await sleep(100); } throw new Error("waited too long for " + what); };
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 700))); };

  step = "open";
  await win.loadURL(base + "/library").catch(() => {});
  await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); localStorage.removeItem("easyread-excerpt-note"); var p = JSON.parse(localStorage.getItem("easyread-prefs") || "{}"); p.layout = "pdf"; localStorage.setItem("easyread-prefs", JSON.stringify(p)); 1');
  await win.loadURL(base + "/").catch(() => {});
  await waitFrame(/\/library/, "window.PR && PR.lib && PR.token", "the library frame");
  await wc.executeJavaScript("window.easyreadOpen(" + JSON.stringify("/read/" + pid) + "); 1");
  const reader = await waitFrame(new RegExp("/read/" + pid), "window.PR && PR.state && PR.state.paper && PR.token && PR.pageNodes && PR.pageNodes().length && PR.excerptMenu", "the reader");
  await sleep(1200);
  // 翻到第 2 頁、等文字層鋪好，選一行的前 28 個字，像放開滑鼠那樣讓工具列出現
  const pick = (page, n) => '(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); PR.openPage(' + page + ', null, { instant: true }); for (let i = 0; i < 40 && !document.querySelector(\'.pv-page[data-n="' + page + '"] .pv-text > span\'); i++) await w(100); const spans = Array.from(document.querySelectorAll(\'.pv-page[data-n="' + page + '"] .pv-text > span\')).filter((s) => s.firstChild && s.firstChild.nodeType === 3 && s.textContent.trim().length >= 40 && !/[-\\u00ad]/.test(s.textContent.slice(0, 30))); const s = spans[' + n + ']; if (!s) return { err: "no span", spans: spans.length }; const r = document.createRange(); r.setStart(s.firstChild, 0); r.setEnd(s.firstChild, 28); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); await w(120); const bar = document.querySelector("#selbar"); return { open: bar.classList.contains("open"), btn: !!bar.querySelector(\'[data-s="excerpt"]\'), text: s.textContent.slice(0, 28) }; })()';
  const choose = (label) => '(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); document.querySelector(\'#selbar [data-s="excerpt"]\').click(); for (let i = 0; i < 30 && !document.querySelector("#ctxmenu.open"); i++) await w(50); const m = document.querySelector("#ctxmenu.open"); if (!m) return { err: "no menu" }; const items = Array.from(m.querySelectorAll("button.mi")); const labels = items.map((b) => b.textContent.trim()); const head = (m.querySelector(".menu-head") || {}).textContent || ""; const it = items.find((b) => b.textContent.trim().includes(' + JSON.stringify(label) + ')); if (it) it.click(); await w(500); return { head, labels, clicked: !!it, toast: (document.querySelector("#toast.open") || {}).textContent || "" }; })()';

  step = "excerpt to a new note";
  const sel1 = await reader.executeJavaScript(pick(2, 0));
  check("PDF 上選了字：工具列出現，上面有「加到筆記」那一顆", sel1.open && sel1.btn, sel1);
  const m1 = await reader.executeJavaScript(choose("新筆記"));
  const made = await mine();
  const note = made[0] && (await api("/api/notes/" + made[0].id));
  const link = note ? (note.body.match(/\]\((\/read\/[^)]+)\)/) || [])[1] || "" : "";
  check("選「新筆記」：建了一份筆記，裡面是一塊引文，下面一行出處（連結帶著第幾頁）", !!note && note.body.startsWith("> " + sel1.text.trim().split(/\s+/)[0]) && new RegExp("^/read/" + pid + "#page=2").test(link) && (note.papers || []).includes(pid) && /打開|開啟|Open/.test(m1.toast), { m1, body: note && note.body, link });
  if (!note) throw new Error("no note created");

  step = "excerpt into an open note";
  await wc.executeJavaScript("window.easyreadShell.open(" + JSON.stringify("/note/" + note.id) + ', "", true); 1');
  const nf = await waitFrame(new RegExp("/note/" + note.id), "window.PR && PR.note && PR.noteEd && document.body.classList.contains('note-ready')", "the note beside");
  await sleep(500);
  const count0 = await nf.executeJavaScript("PR.noteEd.count()");
  const sel2 = await reader.executeJavaScript(pick(3, 1));
  const m2 = await reader.executeJavaScript(choose(note.title.slice(0, 6)));
  await sleep(900);
  const live = await nf.executeJavaScript("({ count: PR.noteEd.count(), saved: document.querySelector('#noteState').dataset.s, links: document.querySelectorAll('#noteEd a.doclink').length, md: PR.noteEd.getValue() })");
  const onServer = await api("/api/notes/" + note.id);
  check("那份筆記並排開著時再摘一段：直接出現在編輯器裡（多一塊）、也存進去了；選單裡那份筆記排最前面", sel2.open && m2.clicked && m2.labels[1] === note.title && live.count === count0 + 1 && live.links === 2 && (onServer.body.match(/#page=3/g) || []).length === 1 && live.saved === "saved", { sel2, m2, live: { count: live.count, saved: live.saved, links: live.links }, count0 });

  step = "follow the source link";
  await reader.executeJavaScript("PR.openPage(7, null, { instant: true }); 1");
  await sleep(500);
  const at7 = await reader.executeJavaScript("PR.pdfPage()");
  await nf.executeJavaScript("document.querySelector('#noteEd a.doclink').click(); 1");
  await sleep(1300);
  const back = await reader.executeJavaScript("({ page: PR.pdfPage(), hash: location.hash, find: (document.querySelector('#findbar input') || {}).value || '', hits: document.querySelectorAll('.pv-hit').length })");
  const tabs = await wc.executeJavaScript("({ on: (document.querySelector('#tabs .tab.on') || {}).title || '', n: document.querySelectorAll('#tabs .tab:not(.out)').length })");
  check("點筆記裡的出處：閱讀頁回到那一頁（不多開分頁），PDF 上選的那句開頭被找出來標著", at7 === 7 && back.page === 2 && back.hash === "" && tabs.n === 3 && (back.hits > 0 || back.find === ""), { at7, back, tabs });

  step = "drop onto a block";
  const drop = await nf.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const md = "> 拖過來的一段\\n>\\n> —— [出處](/read/' + pid + '#page=4)"; const first = document.querySelector("#noteEd .bk-b"); const r = first.getBoundingClientRect(); const dt = new DataTransfer(); dt.setData("application/x-foli-excerpt", md); const ev = (type, y) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 80, clientY: y }); const over = ev("dragover", r.top + 3); first.dispatchEvent(over); const line = !!document.querySelector("#noteEd .bk-b.drop-before"); first.dispatchEvent(ev("drop", r.top + 3)); await w(700); const mdNow = PR.noteEd.getValue(); return { accepted: over.defaultPrevented, line, count: PR.noteEd.count(), firstIsDropped: mdNow.startsWith("> 拖過來的一段"), leftover: document.querySelectorAll(".drop-before, .drop-after").length }; })()');
  check("把一段摘錄放到第一塊的上緣：有插入線、放下後就插在那一塊前面", drop.accepted && drop.line && drop.count === count0 + 2 && drop.firstIsDropped && drop.leftover === 0, drop);

  step = "dragstart carries the excerpt";
  await reader.executeJavaScript(pick(2, 2));
  const drag = await reader.executeJavaScript('(() => { const dt = new DataTransfer(); const span = getSelection().anchorNode.parentElement; span.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt })); return dt.getData("application/x-foli-excerpt"); })()');
  check("選著字開始拖：帶著同一段摘錄（引文＋出處），筆記那邊才接得住", /^> /.test(drag) && drag.includes("/read/" + pid + "#page=2"), { drag });

  step = "append through the server when the note is closed";
  await nf.executeJavaScript("PR.note.flush(); 1");
  await sleep(700);
  await wc.executeJavaScript("(() => { const t = Array.from(document.querySelectorAll('#tabs .tab')).find((x) => x.querySelector('.x') && x.title === " + JSON.stringify(note.title) + "); if (t) t.querySelector('.x').click(); })()");
  await sleep(500);
  const sel3 = await reader.executeJavaScript(pick(4, 0));
  const m3 = await reader.executeJavaScript(choose(note.title.slice(0, 6)));
  await sleep(500);
  const final = await api("/api/notes/" + note.id);
  check("筆記關掉之後再摘：由伺服器接在最後（前面三段都還在），提示可以打開", sel3.open && m3.clicked && /打開|開啟|Open/.test(m3.toast) && (final.body.match(/^> —— \[/gm) || []).length === 4 && /#page=4[^\n]*\)\s*$/.test(final.body.trim()) && final.body.startsWith("> 拖過來的一段"), { m3, body: final.body });

  step = "cleanup";
  await cleanup();
  cleanup = null;
  check("收尾：暫時的筆記刪掉了", (await mine()).length === 0, await mine());
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); localStorage.removeItem("easyread-excerpt-note"); 1');
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy();
  app.exit(bad ? 1 : 0);
});
