// 開發用：在多分頁的外殼裡把「獨立筆記」的整條路走一遍，檢查幾格之間有沒有接上——單頁的測試看不到這些：
//   文獻庫按「新筆記」→ 外殼開成分頁 → 在筆記頁改標題、圖示、收藏、分類 → 文獻庫的清單馬上跟上 →
//   筆記頁複製一份 → 筆記頁刪除 → 那個分頁自己關掉、回到文獻庫、出「復原」→ 復原 → 回收站裡徹底刪掉。
//   還有：文件開著分頁時被刪掉（在文獻庫刪、別處刪、上次留下來的分頁）→ 分頁要跟著關。
//   node_modules/.bin/electron scripts/notes_flow_check.cjs [--base http://localhost:8765] [--paper <一篇可以暫時刪掉再復原的論文 id>]
// 用的是開發的文獻庫：會建兩份暫時的筆記和一個暫時的分類，跑完都清掉（連回收站裡的）。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const paperId = opt("--paper", "");  // 給一篇可以暫時移到回收站再復原的論文（開發用的那篇一頁的）：連「刪論文、分頁跟著關」一起檢查
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = "start";
let cleanupOnFail = null;  // 中途丟出例外也要把暫時的筆記、分類清掉（第一次寫這支時漏了，在開發的文獻庫留下一份「流程檢查的筆記」）
process.on("unhandledRejection", async (e) => {
  console.log("FAILED at step: " + step + " — " + String((e && e.stack) || e).slice(0, 400));
  if (cleanupOnFail) { const fn = cleanupOnFail; cleanupOnFail = null; await fn().catch(() => {}); }
  app.exit(2);
});
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 120000);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame);
  const frameOf = (re) => frames().find((f) => re.test(f.url));
  const waitFrame = async (re, cond, what) => {
    for (let i = 0; i < 100; i++) { const f = frameOf(re); if (f && (await f.executeJavaScript("!!(" + cond + ")").catch(() => false))) return f; await sleep(100); }
    throw new Error("waited too long for " + what);
  };
  const waitFor = async (frame, cond, what) => { for (let i = 0; i < 80; i++) { if (await frame.executeJavaScript("!!(" + cond + ")").catch(() => false)) return; await sleep(100); } throw new Error("waited too long for " + what); };
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail))); };

  step = "open shell";
  await win.loadURL(base + "/library").catch(() => {});
  await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); localStorage.removeItem("easyread-note-ui"); 1');  // 外殼從只有文獻庫開始；筆記頁的目錄、面板從關著開始
  await win.loadURL(base + "/").catch(() => {});
  let lib = await waitFrame(/\/library/, "window.PR && PR.lib && PR.token && PR.lib.loadNotes", "the library frame");  // 後面重新載入外殼之後要換成新的那一格
  const before = await lib.executeJavaScript("PR.lib.notes.length");
  const folder = "流程檢查" + Date.now().toString(36).slice(-4);
  const created = [];
  // 收尾直接問伺服器，不靠哪一格的頁面（外殼重新載入之後原來那一格就不在了；第一次寫時靠那一格，中途失敗就留下暫時的筆記）
  const api = async (path, body) => {
    const token = (await (await fetch(base + "/api/notes")).json()).token;
    const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: JSON.stringify(body) } : {});
    return r.json().catch(() => null);
  };
  const cleanup = async () => {
    for (const id of created) {
      const del = await api("/api/notes/" + id + "/delete", {}).catch(() => null);
      if (del && del.trash) await api("/api/trash", { action: "purge", name: del.trash }).catch(() => null);
    }
    for (const t of ((await api("/api/trash").catch(() => null)) || { items: [] }).items) if (t.kind === "note" && created.some((id) => t.name.includes(id))) await api("/api/trash", { action: "purge", name: t.name }).catch(() => null);  // 已經在回收站裡的也清掉
    await api("/api/notes-folder", { from: folder, to: "" }).catch(() => null);
  };

  cleanupOnFail = cleanup;

  step = "new note";
  await lib.executeJavaScript('document.querySelector("#side [data-newnote]").click(); 1');
  const note = await waitFrame(/\/note\//, "window.PR && PR.note && PR.noteEd && document.body.classList.contains('note-ready')", "the note tab");
  const id = decodeURIComponent(note.url.split("/note/")[1].split(/[?#]/)[0]);
  created.push(id);
  const tabs1 = await wc.executeJavaScript("document.querySelectorAll('#tabs .tab').length");
  check("文獻庫按「新筆記」：外殼開出一個筆記分頁", tabs1 >= 2 && /^[0-9a-f]{12}$/.test(id), { tabs1, id });

  step = "edit meta";
  await note.executeJavaScript('const t = document.querySelector("#noteTitle"); t.value = "流程檢查的筆記"; t.dispatchEvent(new Event("input", { bubbles: true })); PR.noteEd.insert("# 第一節\\n\\n內文一段。"); PR.note.patch({ icon: "atom", color: "blue", star: true, folder: ' + JSON.stringify(folder) + " }); 1");
  await waitFor(lib, 'PR.lib.notes.some((n) => n.id === "' + id + '" && n.title === "流程檢查的筆記" && n.icon === "atom" && n.star)', "the library to pick up the changes");
  const row = await lib.executeJavaScript('(() => { const r = document.querySelector(\'#side .srow.note[data-note="' + id + '"]\'); const c = document.querySelector(\'#side .srow[data-cat="' + folder + '"]\'); return { row: !!r, text: r && r.textContent.trim(), star: !!(r && r.querySelector(".st")), tint: r && r.querySelector(".ti") && r.querySelector(".ti").dataset.c, cat: !!c, count: c && c.querySelector(".n").textContent }; })()');
  check("在筆記頁改標題、圖示、收藏、分類：文獻庫的側欄馬上跟上（新的分類也出現）", row.row && row.text.includes("流程檢查的筆記") && row.star && row.tint === "blue" && row.cat && row.count === "1", row);
  const head = await note.executeJavaScript('({ icon: !!document.querySelector("#noteIcon.set .ti[data-c=blue]"), star: document.querySelector("#starBtn").classList.contains("on"), chip: (document.querySelector("#noteMeta .note-chip") || {}).textContent, saved: document.querySelector("#noteState").dataset.s })');
  check("筆記頁自己：標題旁的圖示、收藏的星、分類的小標籤、存檔的燈", head.icon && head.star && head.chip === folder && head.saved === "saved", head);

  step = "panels";
  const panels = await note.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); document.querySelector("#outlineBtn").click(); document.querySelector("#inspBtn").click(); await w(250); const tabs = Array.from(document.querySelectorAll("#noteInsp [data-ni-tab]")); const out = { outline: document.querySelectorAll("#noteOutline .no-i").length, tabs: tabs.length, bodies: {} }; for (const t of tabs) { t.click(); await w(120); out.bodies[t.dataset.niTab] = document.querySelectorAll("#noteInsp .ni-body button, #noteInsp .ni-body a, #noteInsp .ni-body input").length; } document.querySelector(\'#noteInsp [data-ni-tab="insert"]\').click(); await w(100); const n0 = PR.noteEd.count(); document.querySelector(\'#noteInsp [data-ins="todo"]\').click(); await w(150); out.inserted = PR.noteEd.count() - n0; out.kind = PR.noteEd.current().kind; document.querySelector(\'#noteInsp [data-ni-tab="format"]\').click(); await w(100); document.querySelector(\'#noteInsp [data-fmt="h2"]\').click(); await w(150); out.kind2 = PR.noteEd.current().kind; out.outline2 = document.querySelectorAll("#noteOutline .no-i").length; document.querySelector("#outlineBtn").click(); document.querySelector("#inspBtn").click(); return out; })()');
  check("目錄和右邊四個分頁：都有內容；「插入 → 待辦」多一塊、「格式 → 副標題」換成標題、目錄跟著多一行", panels.outline === 1 && panels.tabs === 4 && Object.values(panels.bodies).every((n) => n > 3) && panels.inserted === 1 && panels.kind === "todo" && panels.kind2 === "h2" && panels.outline2 === 2, panels);

  step = "duplicate";
  await note.executeJavaScript('PR.note.flush(); 1');
  await sleep(700);
  const copy = await lib.executeJavaScript('PR.api("/api/notes/' + id + '/duplicate", { method: "POST", body: {} })');
  created.push(copy.id);
  check("複製一份：內容、圖示、分類帶過去，收藏不帶", copy.id !== id && /流程檢查的筆記/.test(copy.title) && copy.icon === "atom" && copy.folder === folder && copy.star === false && /# 第一節/.test(copy.body), { title: copy.title, icon: copy.icon, star: copy.star });

  step = "delete from note page";
  await note.executeJavaScript('(async () => { document.querySelector("#noteMore").click(); await new Promise((r) => setTimeout(r, 150)); const b = Array.from(document.querySelectorAll("#ctxmenu button.mi")).find((x) => x.classList.contains("danger")); b.click(); return 1; })()').catch(() => 0);
  await sleep(900);
  const after = await wc.executeJavaScript("({ tabs: document.querySelectorAll('#tabs .tab').length, noteFrames: Array.from(document.querySelectorAll('iframe')).filter((f) => /\\/note\\//.test(f.src)).length })");
  const toast = await lib.executeJavaScript('(() => { const t = document.querySelector("#toast"); return { open: t.classList.contains("show") || t.classList.contains("open") || !!t.textContent, text: t.textContent, gone: !PR.lib.notes.some((n) => n.id === "' + id + '"), trash: PR.lib.trashCount }; })()');
  check("在筆記頁刪除：那個分頁關掉、回到文獻庫、清單裡沒有了、出「復原」", after.noteFrames === 0 && toast.gone && /復原|Undo/.test(toast.text), { after, toast });

  step = "undo";
  await lib.executeJavaScript('(() => { const b = document.querySelector("#toast button"); if (b) b.click(); return !!b; })()');
  await waitFor(lib, 'PR.lib.notes.some((n) => n.id === "' + id + '")', "the note to come back").catch(() => {});
  const back = await lib.executeJavaScript('PR.api("/api/notes/' + id + '").then((n) => ({ title: n.title, folder: n.folder, body: n.body.slice(0, 20) })).catch((e) => ({ error: e.message }))');
  check("按「復原」：筆記回來了，內容和分類都在", back.title === "流程檢查的筆記" && back.folder === folder && /第一節/.test(back.body || ""), back);

  step = "library menu";
  const menu = await lib.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); PR.lib.view = "notes"; PR.lib.tag = null; PR.lib.render(); await w(100); const card = document.querySelector(\'#list .ncard[data-note="' + id + '"]\'); const more = card && card.querySelector("[data-more]"); if (!more) return { card: !!card }; more.click(); await w(150); const labels = Array.from(document.querySelectorAll("#ctxmenu button.mi")).map((b) => b.textContent.trim()); PR.closeMenu(); return { card: true, cards: document.querySelectorAll("#list .ncard[data-note]").length, labels }; })()');
  check("「全部筆記」的卡片：有這份筆記，「⋯」選單裡有改名、圖示、收藏、移到分類、複製、刪除", menu.card && menu.labels && menu.labels.length >= 7, menu);
  // 在外殼裡點「⋯」只能開選單，不能順便把那份筆記開成分頁（連結的點擊是外殼攔的，比列上自己的處理早）
  const side = await lib.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const row = document.querySelector(\'#side .srow.note[data-note="' + id + '"]\'); const more = row && row.querySelector("[data-more]"); if (!more) return { row: !!row }; more.click(); await w(200); const open = !!document.querySelector("#ctxmenu.open"); PR.closeMenu(); return { row: true, open }; })()');
  await sleep(500);
  const opened = await wc.executeJavaScript("Array.from(document.querySelectorAll('iframe')).filter((f) => /\\/note\\//.test(f.src)).length");
  check("在外殼裡點筆記列的「⋯」：開的是選單，沒有順便把筆記開成分頁", side.row && side.open && opened === 0, { side, opened });

  step = "trash dialog";
  await lib.executeJavaScript('PR.lib.noteMenu && 1');
  const del = await lib.executeJavaScript('PR.api("/api/notes/' + copy.id + '/delete", { method: "POST", body: {} })');
  const trash = await lib.executeJavaScript('PR.api("/api/trash").then((d) => d.items.filter((t) => t.kind === "note").map((t) => ({ name: t.name, title: t.title, icon: t.icon })))');
  check("刪掉的筆記在回收站裡（有標題、圖示）", !!del.trash && trash.some((t) => t.name === del.trash && /流程檢查的筆記/.test(t.title) && t.icon === "atom"), { del, trash });
  await lib.executeJavaScript('PR.api("/api/trash", { method: "POST", body: { action: "purge", name: ' + JSON.stringify(del.trash) + " } })");
  created.splice(created.indexOf(copy.id), 1);

  // ---------- 刪掉的文件，分頁要跟著關（2.1.0-tw.7 沒做：分頁列上留著打不開的分頁，那一格還每四秒重試存檔） ----------
  const shell = () => wc.executeJavaScript("(() => { const s = JSON.parse(localStorage.getItem('easyread-shell') || '{}'); return { tabs: Array.from(document.querySelectorAll('#tabs .tab')).map((t) => t.title), urls: (s.tabs || []).map((t) => t.url), frames: Array.from(document.querySelectorAll('#frames iframe')).map((f) => f.getAttribute('src')), shown: Array.from(document.querySelectorAll('#frames iframe:not(.hidden)')).length, toast: (document.querySelector('#toast.open') || {}).textContent || '' }; })()");
  const has = (list, x) => list.some((u) => String(u).includes(x));
  step = "delete an open note from the library";
  await lib.executeJavaScript('PR.navigate("/note/' + id + '"); 1');
  await waitFrame(new RegExp("/note/" + id), "window.PR && PR.note && PR.noteEd && document.body.classList.contains('note-ready')", "the note tab again");
  const open1 = await shell();
  await wc.executeJavaScript("document.querySelector('#tabs .tab.lib').click(); 1");
  await sleep(200);
  await lib.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const row = document.querySelector(\'#side .srow.note[data-note="' + id + '"]\'); row.querySelector("[data-more]").click(); await w(200); Array.from(document.querySelectorAll("#ctxmenu button.mi")).find((x) => x.classList.contains("danger")).click(); return 1; })()');
  await sleep(500);
  const gone1 = await shell();
  check("筆記開著分頁時在文獻庫把它刪掉：分頁馬上關掉、那一格卸掉、存起來的分頁清單裡也沒有了", has(open1.urls, id) && has(open1.frames, id) && !has(gone1.urls, id) && !has(gone1.frames, id) && gone1.tabs.length === open1.tabs.length - 1 && gone1.shown === 1, { open1, gone1 });
  await lib.executeJavaScript('(() => { const b = document.querySelector("#toast button"); if (b) b.click(); return !!b; })()');
  await waitFor(lib, 'PR.lib.notes.some((n) => n.id === "' + id + '")', "the note to come back again");
  const back2 = await shell();
  check("復原之後：筆記回到清單，分頁不會自己又開起來", !has(back2.urls, id) && !has(back2.frames, id), back2);

  step = "consecutive absences";
  await lib.executeJavaScript('PR.navigate("/note/' + id + '"); 1');
  await waitFrame(new RegExp("/note/" + id), "window.PR && PR.note && document.body.classList.contains('note-ready')", "the note tab a third time");
  await sleep(400);
  const ids = await lib.executeJavaScript("PR.lib.notes.map((n) => n.id)");
  const without = JSON.stringify(ids.filter((x) => x !== id));
  await lib.executeJavaScript("PR.lib.tellDocs('note', " + JSON.stringify(ids) + "); PR.lib.tellDocs('note', " + without + "); 1");  // 清單裡少了它一次（讀到一半、舊清單晚到）
  await sleep(300);
  const once = await shell();
  await lib.executeJavaScript("PR.lib.tellDocs('note', " + JSON.stringify(ids) + "); PR.lib.tellDocs('note', " + without + "); 1");  // 回來了，又少一次：還是不算
  await sleep(300);
  const again = await shell();
  await lib.executeJavaScript("PR.lib.tellDocs('note', " + without + "); 1");  // 連續第二次沒有：真的不在了
  await sleep(400);
  const twice = await shell();
  check("輪詢的清單裡少了它一次不關（可能只是讀到一半），連續兩次都沒有才關", has(once.urls, id) && has(again.urls, id) && !has(twice.urls, id) && !has(twice.frames, id), { once: once.urls, again: again.urls, twice: twice.urls });
  await lib.executeJavaScript("PR.lib.loadNotes(true)");

  step = "missing doc opened later";
  await wc.executeJavaScript('window.easyreadOpen("/note/dddddddddddd"); 1');
  await sleep(1500);
  const miss = await shell();
  check("開一份已經不存在的筆記：那個分頁自己收掉，說一聲", !has(miss.urls, "dddddddddddd") && !has(miss.frames, "dddddddddddd") && /不在文獻庫|no longer/.test(miss.toast), miss);
  await wc.executeJavaScript('window.easyreadOpen("/read/eeeeeeeeeeee"); 1');
  await sleep(1800);
  const miss2 = await shell();
  check("開一篇已經不存在的論文：一樣收掉", !has(miss2.urls, "eeeeeeeeeeee") && !has(miss2.frames, "eeeeeeeeeeee"), miss2);

  step = "stale tabs at startup";
  await wc.executeJavaScript("localStorage.setItem('easyread-shell', JSON.stringify({ tabs: [{ id: 't1', kind: 'note', url: '/note/ffffffffffff', title: '早就刪掉的筆記' }, { id: 't2', kind: 'note', url: '/note/" + id + "', title: '還在的筆記' }, { id: 't3', kind: 'paper', url: '/read/eeeeeeeeeeee', title: '早就刪掉的論文' }], panes: [{ tab: 'lib', w: 1 }], focus: 0, seq: 3 })); 1");
  await win.loadURL(base + "/").catch(() => {});
  lib = await waitFrame(/\/library/, "window.PR && PR.lib && PR.token && PR.lib.items && PR.lib.loadNotes", "the library frame after reload");
  await sleep(1500);
  const start = await shell();
  check("重開 App：上次留下來、文件已經刪掉的分頁不再出現，還在的那個留著", !has(start.urls, "ffffffffffff") && !has(start.urls, "eeeeeeeeeeee") && has(start.urls, id) && start.tabs.length === 2, start);
  await wc.executeJavaScript("localStorage.removeItem('easyread-shell'); 1");

  if (paperId) {
    step = "delete an open paper";
    await win.loadURL(base + "/").catch(() => {});
    lib = await waitFrame(/\/library/, "window.PR && PR.lib && PR.token && PR.lib.items && PR.lib.items.length", "the library frame for the paper test");
    await wc.executeJavaScript('window.easyreadOpen("/read/' + paperId + '"); 1');
    await waitFrame(new RegExp("/read/" + paperId), "window.PR && PR.state && PR.state.paper && PR.token", "the reader tab");
    await sleep(600);
    const p1 = await shell();
    await wc.executeJavaScript("document.querySelector('#tabs .tab.lib').click(); 1");
    let trashName = "";
    cleanupOnFail = async () => { if (trashName) await lib.executeJavaScript('PR.api("/api/trash", { method: "POST", body: { action: "restore", name: ' + JSON.stringify(trashName) + " } }).catch(() => null)"); await cleanup(); };
    // 走介面上的那條路：右鍵選單 →「移到回收站」→ 確認
    await lib.executeJavaScript('(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); PR.lib.view = "all"; PR.lib.tag = null; PR.lib.render(); await w(100); PR.rowMenu("' + paperId + '", { x: 300, y: 300 }); await w(200); const items = Array.from(document.querySelectorAll("#ctxmenu button.mi")); items[items.length - 1].click(); await w(300); const ok = document.querySelector(\'.popover.confirm [data-cf="ok"]\'); if (ok) ok.click(); return !!ok; })()');
    for (let i = 0; i < 40 && !trashName; i++) { await sleep(150); const t = await lib.executeJavaScript('PR.api("/api/trash").then((d) => (d.items.find((x) => x.name.startsWith("' + paperId + '-")) || {}).name || "")'); trashName = t; }
    await sleep(500);
    const p2 = await shell();
    check("論文開著分頁時在文獻庫把它移到回收站：分頁跟著關", !!trashName && has(p1.urls, paperId) && !has(p2.urls, paperId) && !has(p2.frames, paperId), { trashName, p1: p1.urls, p2: p2.urls });
    if (trashName) await lib.executeJavaScript('PR.api("/api/trash", { method: "POST", body: { action: "restore", name: ' + JSON.stringify(trashName) + " } })");
    trashName = "";
    await lib.executeJavaScript("PR.lib.load()");
    await sleep(500);
    const restoredPaper = await lib.executeJavaScript('PR.lib.items.some((i) => i.id === "' + paperId + '")');
    check("那篇論文復原回來了（開發用的文獻庫照舊）", restoredPaper, { restoredPaper });
    cleanupOnFail = cleanup;
  }

  step = "cleanup";
  await cleanup();
  await lib.executeJavaScript("PR.lib.view = 'all'; PR.lib.load()");
  await sleep(400);
  const left = await lib.executeJavaScript('({ notes: PR.lib.notes.length, cat: PR.lib.cats().includes(' + JSON.stringify(folder) + ") })");
  check("收尾：暫時的筆記和分類都清掉了", left.notes === before && !left.cat, { before, left });
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  app.exit(bad ? 1 : 0);
});
