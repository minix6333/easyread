// 開發用：在多分頁的外殼裡把「獨立筆記」的整條路走一遍，檢查幾格之間有沒有接上——單頁的測試看不到這些：
//   文獻庫按「新筆記」→ 外殼開成分頁 → 在筆記頁改標題、圖示、收藏、分類 → 文獻庫的清單馬上跟上 →
//   筆記頁複製一份 → 筆記頁刪除 → 那個分頁自己關掉、回到文獻庫、出「復原」→ 復原 → 回收站裡徹底刪掉。
//   node_modules/.bin/electron scripts/notes_flow_check.cjs [--base http://localhost:8765]
// 用的是開發的文獻庫：會建兩份暫時的筆記和一個暫時的分類，跑完都清掉（連回收站裡的）。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
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
  const lib = await waitFrame(/\/library/, "window.PR && PR.lib && PR.token && PR.lib.loadNotes", "the library frame");
  const before = await lib.executeJavaScript("PR.lib.notes.length");
  const folder = "流程檢查" + Date.now().toString(36).slice(-4);
  const created = [];
  const cleanup = async () => {
    for (const id of created) {
      const del = await lib.executeJavaScript('PR.api("/api/notes/' + id + '/delete", { method: "POST", body: {} }).catch(() => null)');
      if (del && del.trash) await lib.executeJavaScript('PR.api("/api/trash", { method: "POST", body: { action: "purge", name: ' + JSON.stringify(del.trash) + " } }).catch(() => null)");
    }
    await lib.executeJavaScript('PR.api("/api/notes-folder", { method: "POST", body: { from: ' + JSON.stringify(folder) + ', to: "" } }).catch(() => null)');
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

  step = "trash dialog";
  await lib.executeJavaScript('PR.lib.noteMenu && 1');
  const del = await lib.executeJavaScript('PR.api("/api/notes/' + copy.id + '/delete", { method: "POST", body: {} })');
  const trash = await lib.executeJavaScript('PR.api("/api/trash").then((d) => d.items.filter((t) => t.kind === "note").map((t) => ({ name: t.name, title: t.title, icon: t.icon })))');
  check("刪掉的筆記在回收站裡（有標題、圖示）", !!del.trash && trash.some((t) => t.name === del.trash && /流程檢查的筆記/.test(t.title) && t.icon === "atom"), { del, trash });
  await lib.executeJavaScript('PR.api("/api/trash", { method: "POST", body: { action: "purge", name: ' + JSON.stringify(del.trash) + " } })");
  created.splice(created.indexOf(copy.id), 1);

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
