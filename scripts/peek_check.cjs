// PDF 上的預覽卡（reader/peek.js）：指到引用出現那一筆參考文獻、移開就收；點了釘住；「跳過去」到那一頁、左下角跳得回來；
// 指到圖號看得到那一塊、可以釘在旁邊；Esc 收掉；網址只顯示、不在檢查裡真的開。只看、只點，不寫任何資料（釘的那塊最後拿掉）。
//   node_modules/.bin/electron scripts/peek_check.cjs [--base URL] <有內部連結的論文 id>
const { app, BrowserWindow } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0] || "4cf6b1e1a402";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start";
process.on("unhandledRejection", (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 400)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 120000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents, js = (c) => wc.executeJavaScript(c).catch((e) => { throw new Error(String(e.message || e) + " ← " + c.slice(0, 160)); });
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|ResizeObserver loop|Transition was skipped/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "").slice(0, 200)); });
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 500))); };
  step = "load";
  await win.loadURL(base + "/read/" + id).catch(() => {});
  for (let i = 0; i < 80 && !(await js("!!(window.PR && PR.pageNodes && PR.pageNodes().length && PR.pdfLinks)").catch(() => false)); i++) await sleep(200);
  // 點一下頁面：閱讀頁打開後幾秒內會把 PDF 拉回「上次讀到的那一頁」（讀者自己動過就停）——不先動一下，等一下捲去指連結時會被拉走
  await js("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); PR.sideMotion = false; PR.toggleInspector && PR.toggleInspector(false); PR.openPage(1, null, { instant: true }); 1");
  await sleep(1200);
  // 把某個連結捲到畫面中間，回傳它在畫面上的中心點；mouse(x, y, type) 在那一點發滑鼠事件（落在文字層的字上，和真的一樣）
  await js(`window.__pk = {
    async bring(pick) {
      const d = await PR.pdfLinks();
      let page = 0, l = null;
      for (const [p, arr] of Object.entries(d.pages)) { const hit = arr.find((x) => pick(x, +p)); if (hit) { page = +p; l = hit; break; } }
      if (!l) return null;
      const node = document.querySelector('#pageview .pv-page[data-n="' + page + '"]'), sc = document.querySelector(".pv-scroll");
      let r = node.getBoundingClientRect();
      sc.scrollTop += r.top + l.r[1] * r.height - sc.getBoundingClientRect().top - sc.clientHeight * 0.4;
      await new Promise((ok) => setTimeout(ok, 700));
      r = node.getBoundingClientRect();
      return { page, l, x: r.left + (l.r[0] + l.r[2]) / 2 * r.width, y: r.top + (l.r[1] + l.r[3]) / 2 * r.height };
    },
    mouse(x, y, type) { const el = document.elementFromPoint(x, y); el.dispatchEvent(new MouseEvent(type || "mousemove", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })); return el.className || el.tagName; },
    pop() { const p = document.querySelector("#popover"); return { open: p.classList.contains("open") && p.classList.contains("peek"), text: p.innerText.slice(0, 300), img: !!p.querySelector(".pk-view img"), acts: Array.from(p.querySelectorAll("[data-pk]")).map((b) => b.dataset.pk) }; },
  }; 1`);
  const pop = () => js("JSON.stringify(__pk.pop())").then(JSON.parse);

  step = "hover ref";
  const ref = await js("__pk.bring((x, p) => x.to && x.to > p + 3 && x.y > 0).then((r) => JSON.stringify(r))").then(JSON.parse);
  await js(`__pk.mouse(${ref.x}, ${ref.y}); 1`); await sleep(700);
  const a = await pop();
  check("指著引用停一下：出現那一筆參考文獻（全文、有年份），有問 AI、複製、加到筆記、搜尋", a.open && /\b(19|20)\d\d\b/.test(a.text) && ["ask", "copy", "note", "scholar"].every((k) => a.acts.includes(k)), a);
  await js(`__pk.mouse(${ref.x}, ${ref.y + 140}); 1`); await sleep(700);
  const b = await pop();
  check("移開：預覽收起來", !b.open, b);

  step = "pin + go";
  await js(`__pk.mouse(${ref.x}, ${ref.y}); __pk.mouse(${ref.x}, ${ref.y}, "click"); 1`); await sleep(700);
  await js(`__pk.mouse(${ref.x}, ${ref.y + 140}); 1`); await sleep(700);
  const c = await pop();
  check("點一下：釘住，滑鼠移開也不收", c.open, c);
  const from = await js("PR.pdfPage()");
  await js('document.querySelector("#popover [data-pk=go]").click(); 1'); await sleep(1600);
  const went = await js('JSON.stringify({ page: PR.pdfPage(), back: !!document.querySelector(".jump-back") && !document.querySelector(".jump-back").hidden, flash: !!document.querySelector(".pv-flash"), open: __pk.pop().open })').then(JSON.parse);
  check("「跳過去」：PDF 捲到那一頁、標出那一行，左下角出現「回到第 N 頁」", went.page === ref.l.to && went.back && went.flash && !went.open, { went, to: ref.l.to });
  await js('document.querySelector(".jump-back").click(); 1'); await sleep(1600);
  const back = await js("PR.pdfPage()");
  check("點「回到第 N 頁」：回到原來讀的那一頁", back === from, { back, from });

  step = "figure";
  // 找一個「Figure / Table / 公式」那類的：一個一個試，直到卡片裡是一塊頁面
  let f = null, tries = 0;
  const cands = await js(`PR.pdfLinks().then((d) => JSON.stringify(Object.entries(d.pages).flatMap(([p, arr]) => arr.map((x, i) => [+p, i, x]).filter(([p, i, x]) => x.to && x.y > 0 && x.to < 12).map(([p, i]) => [p, i]))))`).then(JSON.parse);
  for (const [p, i] of cands) {
    if (++tries > 40) break;
    const r = await js(`PR.pdfLinks().then((d) => { const l = d.pages["${p}"][${i}]; return __pk.bring((x) => x === l); }).then((r) => JSON.stringify(r))`).then(JSON.parse);
    if (!r) continue;
    await js(`__pk.mouse(${r.x}, ${r.y}); __pk.mouse(${r.x}, ${r.y}, "click"); 1`); await sleep(900);
    const s = await pop();
    if (s.open && s.img) { f = { r, s }; break; }
    await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1'); await sleep(200);
  }
  const loaded = f ? await js('(function () { const i = document.querySelector("#popover .pk-view img"); return new Promise((ok) => { if (i.complete) ok(i.naturalWidth); else i.onload = () => ok(i.naturalWidth); setTimeout(() => ok(i.naturalWidth), 4000); }); })()') : 0;
  check("指到圖、表、公式：卡片裡是目標頁上的那一塊（圖載得出來），可以釘住、附給問 AI", !!f && loaded > 0 && f.s.acts.includes("pin") && f.s.acts.includes("askfig"), { f: f && f.s, loaded, tries });
  if (f) {
    await js('document.querySelector("#popover [data-pk=pin]").click(); 1'); await sleep(800);
    const pins = await js("PR.pinCount()");
    check("「釘在旁邊」：那一塊釘到 PDF 角落", pins === 1, pins);
    await js("PR.unpinAll(); 1"); await sleep(300);
  }

  step = "esc";
  const r2 = await js("__pk.bring((x, p) => x.to && x.to > p + 3 && x.y > 0).then((r) => JSON.stringify(r))").then(JSON.parse);
  await js(`__pk.mouse(${r2.x}, ${r2.y}); __pk.mouse(${r2.x}, ${r2.y}, "click"); 1`); await sleep(700);
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1'); await sleep(300);
  const e = await pop();
  check("Esc：釘住的預覽也收掉", !e.open, e);

  step = "url";
  const u = await js("__pk.bring((x) => !!x.u).then((r) => JSON.stringify(r))").then(JSON.parse);
  if (u) {
    await js(`__pk.mouse(${u.x}, ${u.y}); 1`); await sleep(1000);
    const s = await pop();
    check("指著網址：看得到網址（點了才用瀏覽器開，這裡不點）", s.open && s.text.includes(new URL(u.l.u).hostname.replace(/^www\./, "")), s);
  }
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 4));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy(); app.exit(bad ? 1 : 0);
});
