// 開發用：外殼（分頁列）的鍵盤和快速開啟，用真的按鍵走一遍——單元測試只測得到狀態的純操作，這些要在真的視窗裡才看得到：
//   焦點在某一格（iframe）裡按 ⌘K → 面板開在外殼、輸入框拿到焦點 → 打字找文件、Enter 開過去 →
//   找內文裡的詞 → 開到那一頁、把詞標出來（而且那個「這次跳到哪」不會記在分頁上）→ ⌘Enter 並排開 →
//   ⌘W 關分頁、⌘⇧T 開回來 → 分頁的右鍵選單 → 面板裡「新筆記」。
//   node_modules/.bin/electron scripts/shell_check.cjs [--base http://localhost:8765] <論文 id> <另一份文件 id>
// 用開發的文獻庫：會建一份暫時的筆記，跑完刪掉（連回收站裡的）。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const ids = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (ids.length < 2) { console.log("要給兩個文件 id"); process.exit(2); }

let step = "start", cleanup = null;
process.on("unhandledRejection", async (e) => {
  console.log("FAILED at step: " + step + " — " + String((e && e.stack) || e).slice(0, 500));
  if (cleanup) await cleanup().catch(() => {});
  app.exit(2);
});
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 150000);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const api = async (path, body) => {
    const token = (await (await fetch(base + "/api/notes")).json()).token;
    const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: JSON.stringify(body) } : {});
    return r.json().catch(() => null);
  };
  const notesBefore = ((await api("/api/notes")) || { items: [] }).items.map((n) => n.id);
  cleanup = async () => {
    for (const n of ((await api("/api/notes")) || { items: [] }).items) if (!notesBefore.includes(n.id)) { const d = await api("/api/notes/" + n.id + "/delete", {}); if (d && d.trash) await api("/api/trash", { action: "purge", name: d.trash }); }
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const key = async (keyCode, mods, char) => {
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: mods || [] });
    if (char) wc.sendInputEvent({ type: "char", keyCode: char, modifiers: mods || [] });
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: mods || [] });
    await sleep(60);
  };
  const type = async (text) => { for (const ch of text) { wc.sendInputEvent({ type: "char", keyCode: ch }); await sleep(25); } await sleep(120); };
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame);
  const waitFrame = async (re, cond, what) => { for (let i = 0; i < 100; i++) { const f = frames().find((x) => re.test(x.url)); if (f && (await f.executeJavaScript("!!(" + cond + ")").catch(() => false))) return f; await sleep(100); } throw new Error("waited too long for " + what); };
  const shell = () => wc.executeJavaScript("(() => { const s = JSON.parse(localStorage.getItem('easyread-shell') || '{}'); const p = document.querySelector('#palette'); return { tabs: Array.from(document.querySelectorAll('#tabs .tab:not(.out)')).map((t) => t.title), on: (document.querySelector('#tabs .tab.on') || {}).title || '', urls: (s.tabs || []).map((t) => t.url), panes: document.querySelectorAll('#panes .pane').length, frames: document.querySelectorAll('#frames iframe').length, palette: !!p, inputFocused: !!p && document.activeElement === p.querySelector('input'), rows: p ? Array.from(p.querySelectorAll('.pal-row')).map((r) => r.querySelector('.pal-t').textContent) : [], secs: p ? Array.from(p.querySelectorAll('.pal-sec')).map((r) => r.textContent) : [], sel: p ? (p.querySelector('.pal-row.on .pal-t') || {}).textContent || '' : '', leaving: document.querySelectorAll('#tabs .tab.out').length, focusIn: document.activeElement && document.activeElement.tagName }; })()");
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 700))); };

  step = "open";
  await win.loadURL(base + "/library").catch(() => {});
  await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); 1');
  await win.loadURL(base + "/").catch(() => {});
  await waitFrame(/\/library/, "window.PR && PR.lib && PR.token", "the library frame");
  for (const id of ids) { await wc.executeJavaScript("window.easyreadOpen(" + JSON.stringify("/read/" + id) + "); 1"); await sleep(700); }
  const readers = [];
  for (const id of ids) readers.push(await waitFrame(new RegExp("/read/" + id), "window.PR && PR.state && PR.state.paper && PR.token && PR.pageNodes && PR.pageNodes().length", "reader " + id));
  await sleep(900);
  wc.focus();
  const titles = await wc.executeJavaScript("Array.from(document.querySelectorAll('#tabs .tab')).map((t) => t.title)");
  const s0 = await shell();
  check("開場：文獻庫＋兩份文件三個分頁，目前在最後開的那一份", s0.tabs.length === 3 && s0.on === titles[2] && s0.focusIn === "IFRAME", s0);

  step = "open palette from inside a frame";
  await key("K", [mod]);
  await sleep(250);
  const s1 = await shell();
  check("焦點在文件那一格裡按 ⌘K：面板開在外殼、輸入框拿到焦點；先列別的分頁、最近看的、可以做的事", s1.palette && s1.inputFocused && s1.rows.includes(titles[1]) && s1.secs.length >= 2, s1);

  step = "type a title";
  const word = (titles[1].match(/[A-Za-z]{4,}/) || [titles[1].slice(0, 2)])[0];
  await type(word.toLowerCase());
  const s2 = await shell();
  check("打標題裡的幾個字（" + word + "）：對得上的那一份排最前面、已經選著", s2.rows[0] === titles[1] && s2.sel === titles[1], s2);
  await key("Return");
  await sleep(350);
  const s3 = await shell();
  check("Enter：切到那個分頁（不多開一個），面板收掉", !s3.palette && s3.on === titles[1] && s3.tabs.length === 3, s3);

  step = "full text";
  await key("K", [mod]);
  await sleep(200);
  const term = "likelihood";
  await type(term);
  await sleep(900);
  const s4 = await shell();
  const hit = await wc.executeJavaScript("(() => { const r = document.querySelector('#palette .pal-row.hit'); return r ? { i: +r.dataset.i, where: (r.querySelector('.pal-t i') || {}).textContent || '', mark: (r.querySelector('mark') || {}).textContent || '', title: r.querySelector('.pal-t').firstChild.textContent } : null; })()");
  check("打內文裡才有的詞（" + term + "）：多一段「內文」，列出哪一份、第幾頁、前後文，詞有標出來", !!hit && /\d/.test(hit.where) && hit.mark.toLowerCase() === term, { hit, secs: s4.secs });
  if (hit) {
    for (let i = 0; i < hit.i; i++) await key("Down");
    await key("Return");
    await sleep(1600);
    const page = +(hit.where.match(/\d+/) || [0])[0];
    const f = frames().find((x) => /\/read\//.test(x.url) && x.url.includes(ids.find((id) => x.url.includes(id))) && true && x);
    const where = [];
    for (const r of readers) where.push(await r.executeJavaScript("({ page: PR.pdfPage(), find: (document.querySelector('#findbar input') || {}).value || '', hits: document.querySelectorAll('.pv-hit').length, hash: location.hash, title: document.title })").catch(() => null));
    const got = where.find((w) => w && w.find === term);
    const s5 = await shell();
    check("Enter：開到那一頁、把那個詞找出來標著；「這次跳到哪」不記在分頁上（下次開 App 還是接著上次讀的地方）", !!got && got.page === page && got.hits > 0 && got.hash === "" && !s5.urls.some((u) => /page=|find=/.test(u)), { page, where, urls: s5.urls });
  }

  step = "esc";
  await key("K", [mod]);
  await sleep(150);
  await key("Escape");
  await sleep(200);
  const s6 = await shell();
  check("Esc：面板收掉，焦點回到剛才那一格", !s6.palette && s6.focusIn === "IFRAME", s6);

  step = "close and reopen";
  const before = await shell();
  await key("W", [mod]);
  await sleep(500);
  const closed = await shell();
  check("⌘W：關掉目前這個分頁（不是整個視窗），顯示旁邊的那一個", closed.tabs.length === before.tabs.length - 1 && !closed.tabs.includes(before.on) && closed.frames === before.frames - 1 && closed.leaving === 0, { before, closed });
  await key("T", [mod, "shift"]);
  await sleep(900);
  const again = await shell();
  check("⌘⇧T：剛關掉的那個開回來", again.tabs.length === before.tabs.length && again.on === before.on, { before, again });

  step = "beside";
  await wc.executeJavaScript("document.querySelector('#tabs .tab.lib').click(); 1");
  await sleep(250);
  await key("K", [mod]);
  await sleep(200);
  await type(word.toLowerCase());
  await key("Return", [mod]);
  await sleep(500);
  const beside = await shell();
  check("⌘Enter：在旁邊並排打開（文獻庫那一格不動）", beside.panes === 2 && beside.on === titles[1], beside);
  await wc.executeJavaScript("document.querySelector('#tabs [data-act=\"closepane\"]').click(); 1");
  await sleep(250);

  step = "context menu";
  const menu = await wc.executeJavaScript("(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const tabs = Array.from(document.querySelectorAll('#tabs .tab:not(.lib)')); const r = tabs[0].getBoundingClientRect(); tabs[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); await w(200); const items = Array.from(document.querySelectorAll('#ctxmenu.open button.mi')); const labels = items.map((b) => b.textContent.trim()); const others = items.find((b) => /其他|other/i.test(b.textContent)); if (others) others.click(); await w(400); return { labels, kept: tabs[0].title }; })()");
  const afterMenu = await shell();
  check("分頁按右鍵：關閉、關閉其他、關閉右邊的、並排、重新開啟；選「關閉其他」只留那一個和文獻庫", menu.labels.length >= 4 && afterMenu.tabs.length === 2 && afterMenu.tabs.includes(menu.kept), { menu, afterMenu });

  step = "new note action";
  await key("K", [mod]);
  await sleep(200);
  await wc.executeJavaScript("(() => { const i = document.querySelector('#palette input'); i.value = '新筆記'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");  // 中文不走按鍵（輸入法），直接填
  await sleep(200);
  const s7 = await shell();
  await key("Return");
  const note = await waitFrame(/\/note\//, "window.PR && PR.note && document.body.classList.contains('note-ready')", "the new note tab").catch(() => null);
  const s8 = await shell();
  check("面板裡打「新筆記」→ Enter：建一份筆記、開成分頁", /新筆記|New note/.test(s7.sel) && !!note && s8.tabs.length === 3, { s7: s7.rows, s8 });

  step = "cleanup";
  await cleanup();  // 直接叫伺服器刪（等於「在別處刪的」）：文獻庫要連續兩次在清單裡看不到它才關分頁——平常是 15 秒輪詢一次，這裡叫它馬上問兩次
  cleanup = null;
  const libFrame = frames().find((x) => /\/library/.test(x.url));
  await libFrame.executeJavaScript("PR.lib.loadNotes(true).then(() => PR.lib.loadNotes(true)).then(() => 1)");
  await sleep(500);
  const end = await shell();
  check("收尾：暫時的筆記在別處被刪掉，文獻庫的清單連兩次沒有它，分頁跟著關了", !end.urls.some((u) => /\/note\//.test(u)) && end.tabs.length === 2, end);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); 1');
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy();
  app.exit(bad ? 1 : 0);
});
