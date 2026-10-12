// 開發用：文獻庫主頁的卡片和「快速查看」，還有閱讀頁裡可以點的頁碼：
//   格狀的卡片是短的（橫的封面＋標題＋一列狀態）、封面用的是伺服器裁的那張、標題折得下來不會被撐破 →
//   選一篇按空白鍵：快速查看開起來（每頁一張圖）→ ↑↓ 換一篇、清單上選的跟著走 → 空白鍵收掉 → Enter 開成閱讀頁 →
//   筆記的快速查看畫得出內文 → 閱讀頁裡「第 7 頁」這種字點了翻到那一頁。
//   node_modules/.bin/electron scripts/library_check.cjs [--base http://localhost:8765] <論文 id> <一份筆記 id>
// 不改任何資料。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const [pid, nid] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!pid || !nid) { console.log("要給一篇論文的 id 和一份筆記的 id"); process.exit(2); }

let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at step: " + step + " — " + String((e && e.stack) || e).slice(0, 500)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 120000);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const waitFor = async (cond, what) => { for (let i = 0; i < 80; i++) { if (await wc.executeJavaScript("!!(" + cond + ")").catch(() => false)) return; await sleep(150); } throw new Error("waited too long for " + what); };
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 700))); };
  const key = 'const key = (k) => (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));';
  const W = "const w = (ms) => new Promise((r) => setTimeout(r, ms));";

  step = "cards";
  await win.loadURL(base + "/library").catch(() => {});
  await waitFor("window.PR && PR.lib && PR.lib.items && PR.lib.items.length && PR.quickLook", "the library");
  await wc.executeJavaScript('PR.ls.set("easyread-lib-view", "grid"); if (!document.querySelector("#list").classList.contains("grid")) { const b = document.querySelector("[data-listview=grid], [data-view-mode=grid]"); if (b) b.click(); } PR.lib.view = "all"; PR.lib.tag = null; PR.lib.q = ""; PR.lib.render(); 1');
  await sleep(900);
  const cards = await wc.executeJavaScript('(() => { const list = document.querySelector("#list"); const row = document.querySelector(\'#list .row[data-id="' + pid + '"]\'); if (!row) return { grid: list.className }; const r = row.getBoundingClientRect(), th = row.querySelector(".thumb"), tr = th.getBoundingClientRect(), cs = getComputedStyle(th), t1 = row.querySelector(".t1").getBoundingClientRect(), main = row.querySelector(".row-main").getBoundingClientRect(); return { grid: list.classList.contains("grid"), w: Math.round(r.width), h: Math.round(r.height), cover: /cover\\.webp\\?c=/.test(cs.backgroundImage), ratio: +(tr.width / tr.height).toFixed(2), mainInside: main.right <= r.right + 0.5, titleInside: t1.right <= r.right + 0.5 }; })()');
  check("格狀的卡片：橫的封面（16:10，伺服器裁的那張）、整張卡片不比寬度高出太多、標題和作者那一塊沒有撐出卡片", cards.grid && cards.cover && Math.abs(cards.ratio - 1.6) < 0.05 && cards.h < cards.w * 1.25 && cards.mainInside && cards.titleInside, cards);
  const img = await fetch(base + "/p/" + pid + "/cover.webp").then(async (r) => ({ code: r.status, type: r.headers.get("content-type"), bytes: (await r.arrayBuffer()).byteLength })).catch((e) => ({ err: String(e) }));
  check("封面的圖拿得到（webp）", img.code === 200 && /webp/.test(img.type || "") && img.bytes > 3000, img);

  step = "quick look";
  const ql = await wc.executeJavaScript("(async () => { " + W + key + ' PR.lib.select("' + pid + '"); await w(150); key(" "); await w(900); const a = { open: PR.quickLook.isOpen(), pages: document.querySelectorAll("#ql .ql-page img").length, t: (document.querySelector("#ql .ql-t") || {}).textContent, n: PR.lib.byId("' + pid + '").pages }; const ids = PR.lib.filtered().map((i) => i.id), at = ids.indexOf("' + pid + '"); const d = at < ids.length - 1 ? 1 : -1; key(d > 0 ? "ArrowDown" : "ArrowUp"); await w(500); const b = { sel: PR.lib.selected, want: ids[at + d], t: (document.querySelector("#ql .ql-t") || {}).textContent }; key(d > 0 ? "ArrowUp" : "ArrowDown"); await w(400); const c = PR.lib.selected; key(" "); await w(200); return { a, b, c, closed: !PR.quickLook.isOpen() }; })()');
  check("選一篇按空白鍵：快速查看開起來，每一頁一張圖；↑↓ 換一篇、清單上選的跟著走；再按空白鍵收掉", ql.a.open && ql.a.pages === ql.a.n && ql.a.pages > 0 && ql.b.sel === ql.b.want && ql.b.t !== ql.a.t && ql.c === pid && ql.closed, ql);
  const note = await wc.executeJavaScript("(async () => { " + W + ' PR.quickLook.open("note", "' + nid + '"); for (let i = 0; i < 40 && !document.querySelector("#ql .ql-note"); i++) await w(100); const el = document.querySelector("#ql .ql-note"); const out = { open: PR.quickLook.isOpen(), h1: el ? el.querySelector("h1").textContent : "", len: el ? el.textContent.length : 0, katex: !!window.katex }; PR.quickLook.close(); return out; })()');
  check("筆記的快速查看：標題和內文都畫出來（用到的排版程式這時候才載入）", note.open && note.h1.length > 0 && note.len > note.h1.length && note.katex, note);

  step = "page refs";
  await win.loadURL(base + "/read/" + pid).catch(() => {});
  await waitFor("window.PR && PR.state && PR.state.paper && PR.pageNodes && PR.pageNodes().length && PR.md", "the reader");
  await sleep(900);
  const ref = await wc.executeJavaScript("(async () => { " + W + ' if (!PR.pdfMain()) return { skip: true }; document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); PR.openPage(2, null, { instant: true }); await w(300); const tmp = document.createElement("div"); tmp.innerHTML = PR.md("重點在第 7 頁，另見 p. 3；第 999 頁不存在"); document.body.append(tmp); const links = Array.from(tmp.querySelectorAll("a.pgref")).map((a) => a.dataset.page); tmp.querySelector("a.pgref").click(); await w(1300); const page = PR.pdfPage(); tmp.remove(); return { links, page }; })()');
  check("閱讀頁裡「第 7 頁」「p. 3」是可以點的（不存在的頁不連），點了翻到那一頁", ref.skip || (ref.links.join() === "7,3" && ref.page === 7), ref);
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy();
  app.exit(bad ? 1 : 0);
});
