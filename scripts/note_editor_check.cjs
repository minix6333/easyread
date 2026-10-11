// 開發用：用真的滑鼠／鍵盤事件把區塊編輯器（web/js/common/blocks.js）操作一遍，檢查「用起來的感覺」那些單元測試顧不到的事：
// 點哪裡游標就到哪裡、點進清單版面不跳、Enter／Backspace／復原、選區塊（Esc、⇧方向鍵、拖過去、⌘A 兩次）、把手的選單、
// 貼上好幾段會拆成區塊、只重畫有變的那一塊（別的區塊的元素要是同一個）、長文件打字夠不夠快。
//   node_modules/.bin/electron scripts/note_editor_check.cjs [--base http://localhost:8765] [--only 關鍵字] [--keep]
// 會在文獻庫建一份暫時的筆記，跑完刪掉（連回收站裡的一起清）；--keep 留著（要自己看時）。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow, clipboard } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const only = opt("--only", "");
const keep = argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = [
  "# 梯度下降",
  "這一段有**粗體**、*斜體*、`程式碼`和公式 $\\nabla f(x)$，還有一個[連結](https://example.com)在中間，後面再接一些字讓它長一點可以換行。",
  "## 步驟",
  "- 第一項\n- 第二項有 ==螢光==\n  - 縮排的子項\n1. 編號一\n1. 編號二\n- [ ] 待辦事項\n- [x] 做完的事",
  "> 引用的一句話",
  "> [!note] 重點\n> 學習率太大會發散。",
  "```python\nprint(1)\n```",
  "$$\n\\theta_{t+1} = \\theta_t - \\eta \\nabla L\n$$",
  "---",
  "最後一段。",
].join("\n\n");

let step = "start";
let cleanupOnFail = null;  // 中途丟出例外也要把暫時的筆記刪掉
process.on("unhandledRejection", async (e) => {
  console.log("FAILED at step: " + step + " — " + String((e && e.stack) || e).slice(0, 400));
  if (cleanupOnFail) { const fn = cleanupOnFail; cleanupOnFail = null; await fn().catch(() => {}); }
  app.exit(2);
});
setTimeout(() => { console.log("TIMEOUT at step: " + step); app.exit(3); }, 180000);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const js = (code) => wc.executeJavaScript(code);
  const api = (path, body) => js("PR.api(" + JSON.stringify(path) + ", " + JSON.stringify(body === undefined ? undefined : { method: "POST", body }) + ")");
  const waitFor = async (cond, what) => { for (let i = 0; i < 80; i++) { if (await js("!!(" + cond + ")").catch(() => false)) return; await sleep(100); } throw new Error("waited too long for " + what); };

  step = "create note";
  await win.loadURL(base + "/library").catch(() => {});
  await waitFor("window.PR && PR.token", "library token");
  await js('localStorage.removeItem("easyread-note-ui"); 1');  // 目錄、右邊的面板從關著開始（開著的話紙會變窄，換行的位置不一樣）
  const note = await api("/api/notes", { title: "編輯器檢查（可以刪）", body: BODY });
  const cleanup = async () => {
    await win.loadURL(base + "/library").catch(() => {});
    await waitFor("window.PR && PR.token", "library token");
    const del = await api("/api/notes/" + note.id + "/delete", {});
    if (del && del.trash) await api("/api/trash", { action: "purge", name: del.trash });
  };
  if (!keep) cleanupOnFail = cleanup;
  const open = async (body) => {
    if (body != null) {  // 先離開筆記頁再重設內容：筆記頁離開時會把還沒存的送出去，晚到的話會蓋掉重設的內容
      if (/\/note\//.test(wc.getURL())) { await win.loadURL(base + "/library").catch(() => {}); await waitFor("window.PR && PR.token", "library token"); await sleep(120); }
      await api("/api/notes/" + note.id, { body });
    }
    await win.loadURL(base + "/note/" + note.id).catch(() => {});
    await waitFor("document.querySelector('#noteEd .bk-b')", "the editor");
    wc.focus();
    await js(HELPERS);
    await sleep(150);
  };
  // 頁面裡的小工具：找某個字在畫面上的位置、看現在的狀態
  const HELPERS = "(" + function () {
    window.__pt = (needle, dx) => {
      const w = document.createTreeWalker(document.querySelector("#noteEd"), NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.nodeValue.indexOf(needle);
        if (i < 0 || n.parentElement.closest(".katex, .bk-gut")) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
        let b = r.getBoundingClientRect();
        if (b.top < 90 || b.bottom > innerHeight - 200) { n.parentElement.scrollIntoView({ block: "center" }); b = r.getBoundingClientRect(); }  // 別點到頂欄、底下那條筆記 AI
        return { x: Math.round(b.left + (dx == null ? 1 : dx)), y: Math.round(b.top + b.height / 2) };
      }
      return null;
    };
    window.__st = () => {
      const ta = document.activeElement, v = (ta && ta.value) || "", el = ta && ta.closest && ta.closest(".bk-b");
      const at = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : -1;
      return { tag: ta && ta.tagName, cls: (el && el.className) || "", at, end: ta && ta.selectionEnd, caret: at < 0 ? "" : v.slice(Math.max(0, at - 6), at) + "|" + v.slice(at, at + 6), value: v,
        editing: document.querySelectorAll(".bk-b.editing").length, sel: document.querySelectorAll(".bk-b.sel").length, blocks: document.querySelectorAll(".bk-b").length,
        md: PR.noteEd ? PR.noteEd.getValue() : "", menu: !!(document.querySelector("#ctxmenu.open")), slash: !!(document.querySelector(".bk-menu.open")) };
    };
    window.__end = (needle) => {  // 那一塊最右邊的空白處（點了游標會在最後）
      const p = window.__pt(needle); if (!p) return null;
      const el = window.__block(needle); const r = el.getBoundingClientRect();
      const lines = el.querySelector(".bk-t, .bk-in").getBoundingClientRect();
      return { x: Math.round(r.right - 12), y: Math.round(lines.bottom - 8) };
    };
    window.__block = (text) => Array.from(document.querySelectorAll(".bk-b")).find((b) => b.textContent.includes(text) || ((b.querySelector(".bk-in") || {}).value || "").includes(text));
    window.__rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  } + ")()";
  const st = () => js("__st()");
  const pt = (needle, dx) => js("__pt(" + JSON.stringify(needle) + (dx == null ? "" : "," + dx) + ")");
  const end = (needle) => js("__end(" + JSON.stringify(needle) + ")");
  const mouse = (type, x, y, extra) => wc.sendInputEvent(Object.assign({ type, x, y, button: "left", clickCount: 1 }, extra || {}));
  const click = async (p, extra) => { mouse("mouseMove", p.x, p.y); mouse("mouseDown", p.x, p.y, extra); mouse("mouseUp", p.x, p.y, extra); await sleep(90); };
  const rclick = async (p) => { mouse("mouseDown", p.x, p.y, { button: "right" }); mouse("mouseUp", p.x, p.y, { button: "right" }); wc.sendInputEvent({ type: "contextMenu", x: p.x, y: p.y }); await sleep(120); };
  const key = async (keyCode, modifiers) => { wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers || [] }); wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers || [] }); await sleep(60); };
  const type = async (text) => { await wc.insertText(text); await sleep(60); };

  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail))); };
  const run = async (name, fn) => { if (only && !name.includes(only)) return; step = name; await open(BODY); await fn(name); };
  const CMD = process.platform === "darwin" ? "meta" : "control";

  await run("點連結後面的字：游標落在那個字前面", async (name) => {
    await click(await pt("在中間"));
    const s = await st();
    check(name, s.tag === "TEXTAREA" && s.caret === "e.com)|在中間，後面", s.caret);
  });
  await run("點粗體中間：游標在粗體裡面", async (name) => {
    await click(await pt("體**".slice(0, 1)));
    const s = await st();
    check(name, /\*\*粗\|體\*\*/.test(s.caret), s.caret);
  });
  await run("點段落最後面的空白：游標在最後", async (name) => {
    const p = await pt("換行。", 46);
    await click(p);
    const s = await st();
    check(name, s.at === s.value.length && /換行。$/.test(s.value), s.caret);
  });
  await run("點進清單項：記號還在、字不往左跳", async (name) => {
    const before = await js("(() => { const el = __block('第一項'); return { x: el.querySelector('.bk-t').getBoundingClientRect().left, y: el.getBoundingClientRect().top, h: el.getBoundingClientRect().height }; })()");
    await click(await pt("第一項", 20));
    const after = await js("(() => { const el = document.querySelector('.bk-b.editing'); const ta = el.querySelector('.bk-in'); return { x: ta.getBoundingClientRect().left, y: el.getBoundingClientRect().top, h: el.getBoundingClientRect().height, mark: !!el.querySelector('.bk-mark') }; })()");
    check(name, after.mark && Math.abs(after.x - before.x) < 1.5 && Math.abs(after.h - before.h) < 1.5, { before, after });
  });
  await run("點進內文／標題／引用／說明框：高度不變（版面不跳）", async (name) => {
    const out = [];
    for (const needle of ["梯度下降", "最後一段", "引用的一句話", "學習率"]) {
      await key("Escape"); await key("Escape");
      const where = await pt(needle, 3);  // 先讓它捲到看得到的地方，再量
      const b = await js("(() => { const el = __block(" + JSON.stringify(needle) + "); const r = el.getBoundingClientRect(); return { y: r.top, h: r.height }; })()");
      await click(where);
      const a = await js("(() => { const el = document.querySelector('.bk-b.editing'); if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.top, h: r.height }; })()");
      out.push({ needle, dh: a ? Math.round((a.h - b.h) * 10) / 10 : "not editing", dy: a ? Math.round((a.y - b.y) * 10) / 10 : "" });
    }
    check(name, out.every((o) => typeof o.dh === "number" && Math.abs(o.dh) <= 1.5 && Math.abs(o.dy) <= 1.5), out);
  });
  await run("Enter 分段、Backspace 併回去、⌘Z 復原", async (name) => {
    await click(await pt("在中間"));
    const n0 = (await st()).blocks;
    await key("Return");
    const s1 = await st();
    await key("Backspace");
    const s2 = await st();
    await type("甲乙");
    await sleep(1100);
    await type("丙");
    const s3 = await st();
    await key("z", [CMD]);
    const s4 = await st();
    check(name, s1.blocks === n0 + 1 && s1.caret.startsWith("|在中間") && s2.blocks === n0 && /\.com\)\|在中間/.test(s2.caret) && s3.value.includes("甲乙丙在中間") && s4.value.includes("甲乙在中間") && !s4.value.includes("丙"),
      { n0, s1: [s1.blocks, s1.caret], s2: [s2.blocks, s2.caret], s3: s3.caret, s4: s4.caret });
  });
  await run("只重畫有變的那一塊：別的區塊元素沒被換掉", async (name) => {
    await js("document.querySelectorAll('.bk-b').forEach((b, i) => { b.__mark = i; }); 1");
    await click(await end("最後一段"));
    await key("Return");
    await type("新的一段");
    await key("Escape");
    const kept = await js("Array.from(document.querySelectorAll('.bk-b')).filter((b) => b.__mark != null).length");
    const s = await st();
    check(name, kept === s.blocks - 1 && /最後一段。\n\n新的一段$/.test(s.md), { kept, total: s.blocks, tail: s.md.slice(-14) });
  });
  await run("Esc 選這一塊、⇧↓ 多選、⌫ 刪掉、⌘Z 回來", async (name) => {
    await click(await pt("第一項", 20));
    await key("Escape");
    const s1 = await st();
    await key("Down", ["shift"]); await key("Down", ["shift"]);
    const s2 = await st();
    await key("Up", ["shift"]);
    const s2b = await st();
    await key("Backspace");
    const s3 = await st();
    await key("Escape");
    await click(await pt("梯度下降", 3)); await key("Escape");
    await key("z", [CMD]);
    const s4 = await st();
    check(name, s1.sel === 1 && s1.editing === 0 && s2.sel === 3 && s2b.sel === 2 && s3.blocks === s1.blocks - 2 && !s3.md.includes("第一項") && s4.md.includes("- 第一項\n- 第二項有"),
      { s1: [s1.sel, s1.editing], s2: s2.sel, s2b: s2b.sel, s3: s3.blocks, s4: s4.blocks });
  });
  await run("⌘A 兩次：第一次選這一塊的字，第二次選全部區塊", async (name) => {
    await click(await pt("最後一段", 10));
    wc.selectAll(); await sleep(80);  // 第一次是系統的「全選」（選單的 role），合成的按鍵叫不動它
    const s1 = await st();
    await key("a", [CMD]);
    const s2 = await st();
    check(name, s1.tag === "TEXTAREA" && s1.at === 0 && s1.end === s1.value.length && s2.sel === s2.blocks && s2.editing === 0, { s1: [s1.at, s1.end], s2: [s2.sel, s2.blocks] });
  });
  await run("把手：點一下選起來並開選單；「複製一份」多一塊", async (name) => {
    const el = await js("(() => { const el = __block('最後一段'); el.scrollIntoView({ block: 'center' }); const h = el.querySelector('.bk-handle').getBoundingClientRect(); const r = el.getBoundingClientRect(); return { hx: Math.round(h.left + h.width / 2), hy: Math.round(h.top + h.height / 2), bx: Math.round(r.left + 120), by: Math.round(r.top + r.height / 2) }; })()");
    mouse("mouseMove", el.bx, el.by); await sleep(120);
    await click({ x: el.hx, y: el.hy });
    const s1 = await st();
    const dup = await js("(() => { const b = Array.from(document.querySelectorAll('#ctxmenu button.mi')).find((x) => /複製一份|Duplicate/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()");
    if (dup) await click(dup);
    const s2 = await st();
    check(name, s1.sel === 1 && s1.menu && !!dup && s2.blocks === s1.blocks + 1 && (s2.md.match(/最後一段。/g) || []).length === 2, { s1: [s1.sel, s1.menu], dup, s2: s2.blocks });
  });
  await run("在區塊上按右鍵：開區塊選單；選「項目清單」把內文變清單", async (name) => {
    await rclick(await pt("最後一段", 10));
    const s1 = await st();
    const b = await js("(() => { const b = document.querySelectorAll('#ctxmenu .menu-row button')[4]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: b.title }; })()");
    if (b) await click(b);
    const s2 = await st();
    check(name, s1.menu && s1.sel === 1 && !!b && /\n- 最後一段。$/.test(s2.md), { s1: [s1.menu, s1.sel], b, tail: s2.md.slice(-20) });
  });
  await run("按著滑鼠從一塊拖到另一塊：選起來的是區塊", async (name) => {
    const a = await pt("第一項", 30), z = await pt("編號二", 30);
    mouse("mouseMove", a.x, a.y); mouse("mouseDown", a.x, a.y);
    for (let i = 1; i <= 8; i++) { mouse("mouseMove", a.x + i * 4, Math.round(a.y + ((z.y - a.y) * i) / 8), { modifiers: ["leftButtonDown"] }); await sleep(20); }
    mouse("mouseUp", z.x, z.y);
    await sleep(120);
    const s = await st();
    check(name, s.sel === 5 && s.editing === 0, { sel: s.sel, editing: s.editing });
  });
  await run("在排好的字上拖選一段：進編輯、選的就是那一段", async (name) => {
    const a = await pt("後面再接", 0), z = await pt("讓它長", 0);
    mouse("mouseMove", a.x, a.y); mouse("mouseDown", a.x, a.y);
    for (let i = 1; i <= 6; i++) { mouse("mouseMove", Math.round(a.x + ((z.x - a.x) * i) / 6), a.y, { modifiers: ["leftButtonDown"] }); await sleep(20); }
    mouse("mouseUp", z.x, z.y);
    await sleep(150);
    const s = await st();
    check(name, s.tag === "TEXTAREA" && s.value.slice(s.at, s.end) === "後面再接一些字", { got: s.value.slice(s.at, s.end), at: s.at, end: s.end });
  });
  await run("貼上好幾行的清單：拆成一塊一塊", async (name) => {
    await click(await end("最後一段"));
    await key("Return");
    const n0 = (await st()).blocks;
    await clipboard.writeText("## 貼上的標題\n\n- 甲\n- 乙\n\n結尾");
    wc.paste(); await sleep(200);
    const s = await st();
    check(name, s.blocks === n0 + 3 && /## 貼上的標題\n\n- 甲\n- 乙\n\n結尾$/.test(s.md) && s.caret.startsWith("結尾|"), { n0, blocks: s.blocks, tail: s.md.slice(-40), caret: s.caret });
  });
  await run("選著區塊時 ⌘C、⌘V：下面多出一樣的幾塊", async (name) => {
    await click(await pt("第一項", 20));
    await key("Escape"); await key("Down", ["shift"]);
    wc.copy(); await sleep(120);
    const copied = String(await clipboard.readText());
    wc.paste(); await sleep(200);
    const s = await st();
    check(name, copied === "- 第一項\n- 第二項有 ==螢光==" && s.md.includes("- 第一項\n- 第二項有 ==螢光==\n- 第一項\n- 第二項有 ==螢光==\n  - 縮排的子項") && s.sel === 2, { copied, sel: s.sel });
  });
  await run("打「/」叫出插入選單，方向鍵＋Enter 選「大標題」", async (name) => {
    await click(await end("最後一段"));
    await key("Return");
    await type("/");
    const s1 = await st();
    await key("Down"); await key("Return");
    await type("新標題");
    const s2 = await st();
    check(name, s1.slash && !s2.slash && /\n\n# 新標題$/.test(s2.md), { slash: s1.slash, tail: s2.md.slice(-16) });
  });
  await run("左邊的「＋」：下面多一塊並開插入選單", async (name) => {
    const el = await js("(() => { const el = __block('引用的一句話'); const a = el.querySelector('.bk-add').getBoundingClientRect(); const r = el.getBoundingClientRect(); return { ax: Math.round(a.left + a.width / 2), ay: Math.round(a.top + a.height / 2), bx: Math.round(r.left + 120), by: Math.round(r.top + r.height / 2) }; })()");
    const n0 = (await st()).blocks;
    mouse("mouseMove", el.bx, el.by); await sleep(100);
    await click({ x: el.ax, y: el.ay });
    const s = await st();
    check(name, s.blocks === n0 + 1 && s.slash && s.tag === "TEXTAREA", { n0, blocks: s.blocks, slash: s.slash, tag: s.tag });
  });
  await run("點圖／公式是選起來，不是進編輯；再按 ⌫ 刪掉", async (name) => {
    const p = await js("(() => { const el = document.querySelector('.bk-b.t-math .katex-display'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
    await click(p);
    const s1 = await st();
    await key("Backspace");
    const s2 = await st();
    check(name, s1.sel === 1 && s1.editing === 0 && !s2.md.includes("\\theta_{t+1}"), { s1: [s1.sel, s1.editing], has: s2.md.includes("\\theta_{t+1}") });
  });
  await run("待辦：正在編這一項時點方框，勾起來而且游標還在", async (name) => {
    await click(await pt("待辦事項", 30));
    const box = await js("(() => { const b = document.querySelector('.bk-b.editing .bk-mark.todo').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()");
    await click(box);
    await type("！");
    const s = await st();
    check(name, s.tag === "TEXTAREA" && /- \[x\] 待辦事項！|- \[x\] 待辦！事項|- \[x\] 待！辦事項/.test(s.md), { tag: s.tag, md: (s.md.match(/- \[.\] 待[^\n]*/) || [])[0] });
  });
  await run("存檔：改的內容真的寫回伺服器", async (name) => {
    await click(await end("最後一段"));
    await type("存檔測試");
    await key("Escape");
    await sleep(1300);
    const saved = await api("/api/notes/" + note.id);
    check(name, /最後一段。存檔測試$/.test(saved.body), saved.body.slice(-20));
  });
  if (!only || "長文件".includes(only)) {
    step = "長文件";
    const big = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? "## 第 " + i + " 節" : i % 9 === 4 ? "$$\na_{" + i + "} = \\sum_k x_k^2\n$$" : "第 " + i + " 段：這裡有一些字和公式 $x_{" + i + "}^2$，還有**粗體**。")).join("\n\n");
    await open(big);
    const p = await js("(() => { const el = document.querySelectorAll('.bk-b')[200]; el.scrollIntoView({ block: 'center' }); const r = el.querySelector('.bk-t').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()");
    await click(p);
    const t = await js("(async () => { const ta = document.activeElement; if (!ta || ta.tagName !== 'TEXTAREA') return null; const frame = () => new Promise((r) => requestAnimationFrame(() => r())); let typing = 0; for (let i = 0; i < 40; i++) { const t0 = performance.now(); document.execCommand('insertText', false, 'a'); document.body.offsetHeight; typing += performance.now() - t0; await frame(); } typing /= 40; let enter = 0; for (let i = 0; i < 10; i++) { const t1 = performance.now(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); document.execCommand('insertText', false, 'b'); document.body.offsetHeight; enter += performance.now() - t1; await frame(); } enter /= 10; return { typing: Math.round(typing * 10) / 10, enter: Math.round(enter * 10) / 10, blocks: document.querySelectorAll('.bk-b').length }; })()");
    check("長文件（400 塊、一堆公式）：打一個字（連排版）不到 4 毫秒、按一次 Enter 不到 12 毫秒", !!t && t.typing < 4 && t.enter < 12 && t.blocks === 410, t);
  }
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));

  step = "cleanup";
  cleanupOnFail = null;
  if (!keep) await cleanup();
  else console.log("留著這份筆記：" + base + "/note/" + note.id);
  console.log(bad ? bad + " 項沒過" : "全部通過");
  app.exit(bad ? 1 : 0);
});
