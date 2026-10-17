// 右側筆記面板（本頁筆記、整篇筆記）裡選字：格式工具列整條看得到——第一行選字時不能被面板的上緣切掉（改放在字的下面），
// 下面幾行照舊放在字的上面，也不能蓋住選的字。只在畫面上換內容、不存（PR.commit 先攔下來，最後確認一次都沒送）。
//   node_modules/.bin/electron scripts/notes_toolbar_check.cjs <論文 id> [--base URL]
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
const TEXT = "123 第一行的字\n\n第二段，後面還有。\n\n第三段，中間的行。\n\n第四段。";
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 860, show: false, webPreferences: { backgroundThrottling: false, partition: "tb-" + Date.now() } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "")) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (cond, what) => { for (let i = 0; i < 100; i++) { if (await js("!!(" + cond + ")").catch(() => false)) return; await sleep(100); } throw new Error("waited too long for " + what); };
  const mouse = (type, x, y) => wc.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
  const click = async (p) => { mouse("mouseMove", p.x, p.y); mouse("mouseDown", p.x, p.y); mouse("mouseUp", p.x, p.y); await sleep(160); };
  step = "open reader";
  await win.loadURL(base + "/read/" + pid).catch(() => {});
  await waitFor("window.PR && PR.state && PR.state.reader && PR.toggleNotesPanel && PR.renderNotesPanel", "the reader");
  await sleep(600);
  wc.focus();  // 沒有焦點的視窗不送 focusout：編輯器收不到「離開了」，面板就一直等著不重畫
  await js("window.__commits = []; PR.commit = (op) => { window.__commits.push(op); return Promise.resolve(); }; 1");
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 600))); };
  // 工具列：每一層會切東西的外框（overflow 不是 visible）都要整條包住；四個角落點下去是工具列自己（沒被別的蓋住）
  const MEASURE = "(" + function (needle) {
    const t = document.querySelector("#notespanel .bk-tools.open");
    if (!t) return { open: false };
    const r = t.getBoundingClientRect();
    const clipped = [];
    for (let n = t.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowY === "visible" && cs.overflowX === "visible") continue;
      const b = n.getBoundingClientRect();
      if (r.top < b.top - 1 || r.bottom > b.bottom + 1) clipped.push((n.id || n.className || n.tagName).toString().slice(0, 40));
    }
    const covered = [[r.left + 6, r.top + 3], [r.right - 6, r.top + 3], [r.left + 6, r.bottom - 3], [r.right - 6, r.bottom - 3]]
      .filter(([x, y]) => { const e = document.elementFromPoint(x, y); return !(e && t.contains(e)); }).length;
    const sel = getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : null;
    const overlap = sel ? !(r.bottom <= sel.top + 1 || r.top >= sel.bottom - 1) : null;
    return { open: true, below: t.classList.contains("below"), top: Math.round(r.top), bottom: Math.round(r.bottom), clipped, covered, overlap,
      selTop: sel && Math.round(sel.top), selText: String(getSelection()) };
  } + ")";
  const pick = async (tab, needle, len) => {
    // 進編輯：點那個字；再用 PR.rich 選起來（和 rich_editor_check 一樣），讓編輯器自己放工具列
    const p = await js("(" + function (needle) {
      const root = document.querySelector("#notespanel #npPageEd, #notespanel #npPaperEd");
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.nodeValue.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
        const b = r.getBoundingClientRect();
        return { x: Math.round(b.left + 1), y: Math.round(b.top + b.height / 2) };
      }
      return null;
    } + ")(" + JSON.stringify(needle) + ")");
    if (!p) throw new Error("找不到「" + needle + "」（" + tab + "）");
    await click(p);
    await js("(" + function (needle, len) {
      const el = document.activeElement;
      if (!el || !el.classList.contains("bk-rich")) return false;
      const at = PR.rich.text(el).indexOf(needle);
      PR.rich.setCaret(el, at, at + len);
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    } + ")(" + JSON.stringify(needle) + "," + len + ")");
    await sleep(260);
    return js(MEASURE + "()");
  };
  for (const tab of ["page", "paper"]) {
    step = "tab " + tab;
    await js("PR.toggleNotesPanel(true, " + JSON.stringify(tab) + "); 1");
    const host = tab === "page" ? "#npPageEd" : "#npPaperEd";
    await waitFor("PR.notesTab() === " + JSON.stringify(tab) + " && document.querySelector('#notespanel " + host + "')", "the " + tab + " editor");
    await sleep(400);  // 換分頁的動畫
    await js("(" + function (tab, text) {
      const S = PR.state;
      if (tab === "page") {
        const p = +document.querySelector("#npPageEd").dataset.page;
        window.__keep = { tab, p, v: (S.reader.page_notes || {})[p] };
        S.reader.page_notes = Object.assign({}, S.reader.page_notes, { [p]: { body: text } });
      } else {
        window.__keep = { tab, v: S.reader.paper_note };
        S.reader.paper_note = { body: text };
      }
      PR.renderNotesPanel();
      return 1;
    } + ")(" + JSON.stringify(tab) + "," + JSON.stringify(TEXT) + ")");
    await waitFor("document.querySelector('#notespanel .np-bk .bk-b')", "blocks");
    await sleep(200);
    const first = await pick(tab, "123", 3);
    check(tab + "：第一行選字，工具列整條看得到（放在字的下面），沒有蓋住選的字",
      first.open && first.below && !first.clipped.length && !first.covered && first.overlap === false, first);
    await js("document.activeElement && document.activeElement.blur(); getSelection().removeAllRanges(); 1");
    await sleep(150);
    const mid = await pick(tab, "第三段", 3);
    check(tab + "：下面的行選字，工具列照舊在字的上面，整條看得到",
      mid.open && !mid.below && mid.bottom <= mid.selTop + 1 && !mid.clipped.length && !mid.covered, mid);
    await js("document.activeElement && document.activeElement.blur(); getSelection().removeAllRanges(); 1");
    await sleep(150);
    await js("(" + function () {
      const S = PR.state, k = window.__keep;
      if (k.tab === "page") { const pn = Object.assign({}, S.reader.page_notes); if (k.v) pn[k.p] = k.v; else delete pn[k.p]; S.reader.page_notes = pn; }
      else S.reader.paper_note = k.v;
      PR.renderNotesPanel();
      return 1;
    } + ")()");
  }
  const sent = await js("window.__commits.length");
  check("只是選字：一次都沒有存", sent === 0, await js("window.__commits"));
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  app.exit(bad ? 1 : 0);
});
