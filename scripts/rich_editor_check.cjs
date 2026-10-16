// 筆記編輯器的所見即所得（common/richtext.js + blocks.js）：點進去還是排好的樣子；不用打記號就能排版；
// 會打記號的照打也會變；全形的開頭記號（注音輸入法打得出來）也會變成清單、標題；貼上帶格式的、PDF 的字。
// 用一份暫時的筆記（最後刪掉、清出回收站），真的滑鼠、鍵盤事件。
//   node_modules/.bin/electron scripts/rich_editor_check.cjs [--base URL] [--only 名稱的一部分] [--keep]
const { app, BrowserWindow, clipboard } = require("electron");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765"), only = opt("--only", ""), keep = argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", cleanupOnFail = null;
const fail = async (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 500)); if (cleanupOnFail) await cleanupOnFail().catch(() => {}); app.exit(2); };
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error("TIMEOUT")), 180000);
const BODY = "# 梯度下降\n\n這一段有 **粗體**、==螢光== 和公式 $\\theta_t$，後面再接一些字。\n\n- 第一項\n- 第二項\n\n最後一段。";
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket/.test(e.message || "") && !/sandbox_bundle/.test(String(e.sourceId || ""))) errors.push((e.message || "") + " @ " + String(e.sourceId || "").split("/").pop() + ":" + e.lineNumber); });
  const js = (code) => wc.executeJavaScript(code).catch(async (e) => { const msg = await wc.executeJavaScript("window.__lastErr || ''").catch(() => ""); throw new Error(String(e.message || e).slice(0, 80) + " | page: " + msg + " | code: " + code.slice(0, 140)); });
  const api = (path, body) => js("PR.api(" + JSON.stringify(path) + ", " + JSON.stringify(body === undefined ? undefined : { method: "POST", body }) + ")");
  const waitFor = async (cond, what) => { for (let i = 0; i < 80; i++) { if (await js("!!(" + cond + ")").catch(() => false)) return; await sleep(100); } throw new Error("waited too long for " + what); };
  step = "create note";
  await win.loadURL(base + "/library").catch(() => {});
  await waitFor("window.PR && PR.token", "library token");
  await js('localStorage.removeItem("easyread-note-ui"); 1');
  const note = await api("/api/notes", { title: "所見即所得檢查（可以刪）", body: BODY });
  const cleanup = async () => {
    await win.loadURL(base + "/library").catch(() => {});
    await waitFor("window.PR && PR.token", "library token");
    const del = await api("/api/notes/" + note.id + "/delete", {});
    if (del && del.trash) await api("/api/trash", { action: "purge", name: del.trash });
  };
  if (!keep) cleanupOnFail = cleanup;
  const open = async (body) => {
    if (/\/note\//.test(wc.getURL())) { await win.loadURL(base + "/library").catch(() => {}); await waitFor("window.PR && PR.token", "library token"); await sleep(120); }
    await api("/api/notes/" + note.id, { body: body == null ? BODY : body });
    await win.loadURL(base + "/note/" + note.id).catch(() => {});
    await waitFor("document.querySelector('#noteEd .bk-b')", "the editor");
    wc.focus();
    await js(HELPERS);
    await sleep(150);
  };
  const HELPERS = "(" + function () {
    window.addEventListener("error", (ev) => { window.__lastErr = String(ev.message) + " @" + ev.lineno; });
    window.__pt = (needle, dx) => {
      const w = document.createTreeWalker(document.querySelector("#noteEd"), NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.nodeValue.indexOf(needle);
        if (i < 0 || n.parentElement.closest(".katex, .bk-gut")) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
        let b = r.getBoundingClientRect();
        if (b.top < 90 || b.bottom > innerHeight - 200) { n.parentElement.scrollIntoView({ block: "center" }); b = r.getBoundingClientRect(); }
        return { x: Math.round(b.left + (dx == null ? 1 : dx)), y: Math.round(b.top + b.height / 2) };
      }
      return null;
    };
    window.__st = () => {
      const a = document.activeElement, el = a && a.closest && a.closest(".bk-b");
      const rich = a && a.classList && a.classList.contains("bk-rich");
      const c = rich ? PR.rich.caret(a) : null, txt = rich ? PR.rich.text(a) : (a && a.value) || "";
      return { rich, tag: a && a.tagName, cls: (el && el.className) || "", at: c ? c.start : -1, end: c ? c.end : -1, text: txt,
        caret: c ? txt.slice(Math.max(0, c.start - 6), c.start) + "|" + txt.slice(c.start, c.start + 6) : "", html: rich ? a.innerHTML : "",
        editing: document.querySelectorAll(".bk-b.editing").length, blocks: document.querySelectorAll(".bk-b").length,
        md: PR.noteEd ? PR.noteEd.getValue() : "", slash: !!document.querySelector(".bk-menu.open"), tools: !!document.querySelector(".bk-tools.open"),
        pop: !!document.querySelector(".bk-pop") };
    };
  } + ")()";
  const st = () => js("__st()");
  const pt = (needle, dx) => js("__pt(" + JSON.stringify(needle) + (dx == null ? "" : "," + dx) + ")");
  const mouse = (type, x, y, extra) => wc.sendInputEvent(Object.assign({ type, x, y, button: "left", clickCount: 1 }, extra || {}));
  const click = async (p) => { mouse("mouseMove", p.x, p.y); mouse("mouseDown", p.x, p.y); mouse("mouseUp", p.x, p.y); await sleep(120); };
  const key = async (keyCode, modifiers) => {
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers || [] });
    if (keyCode === "Return" && !(modifiers || []).length) wc.sendInputEvent({ type: "char", keyCode: "\r" });
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers || [] });
    await sleep(70);
  };
  const type = async (text) => { for (const ch of text) { await wc.insertText(ch); await sleep(15); } await sleep(60); };
  const CMD = process.platform === "darwin" ? "meta" : "control";
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 600))); };
  const run = async (name, fn) => { if (only && !name.includes(only)) return; step = name; await open(); await fn(name); };

  await run("點進去還是排好的樣子：粗體、螢光、公式都在，游標落在點的字前面", async (name) => {
    await click(await pt("後面再接"));
    const s = await st();
    check(name, s.rich && /<b>粗體<\/b>/.test(s.html) && /<mark>螢光<\/mark>/.test(s.html) && /rt-tex/.test(s.html) && s.caret.endsWith("|後面再接一些"), { rich: s.rich, caret: s.caret, html: s.html.slice(0, 160) });
  });
  await run("選字按 ⌘B：變粗體，存的是 **字**；再按一次拿掉", async (name) => {
    await click(await pt("最後一段"));
    await key("End"); await key("Home", ["shift"]);
    await key("B", [CMD]);
    const s1 = await st();
    await key("B", [CMD]);
    const s2 = await st();
    check(name, /\*\*最後一段。\*\*/.test(s1.md) && !/\*\*最後一段/.test(s2.md) && /最後一段。/.test(s2.md), { s1: s1.md.slice(-20), s2: s2.md.slice(-20) });
  });
  await run("會打記號也行：打完 **字** 就變粗體、$式$ 變公式、==字== 變螢光", async (name) => {
    await click(await pt("最後一段"));
    await key("End");
    await type("看**這裡**和$x^2$和==重點==");
    const s = await st();
    check(name, /<b>這裡<\/b>/.test(s.html) && /data-tex="x\^2"/.test(s.html) && /<mark>重點<\/mark>/.test(s.html) && /最後一段。看\*\*這裡\*\*和\$x\^2\$和==重點==$/.test(s.md), { md: s.md.slice(-40), html: s.html.slice(-200) });
  });
  await run("字面上的記號照存：打 a*b 和 5$ 不會變成格式，重新讀回來還是 a*b", async (name) => {
    await click(await pt("最後一段"));
    await key("End");
    await type(" a*b 5$");
    await key("Escape");
    const s = await st();
    check(name, /最後一段。 a\\\*b 5\\\$$/.test(s.md), s.md.slice(-24));
  });
  await run("Enter 分段、Backspace 併回：樣式跟著走，不會變成 **a****b**", async (name) => {
    await click(await pt("粗體"));  // 游標在「粗」前面
    await key("Right");  // 「粗|體」
    await key("Return");
    const s1 = await st();
    await key("Backspace");
    const s2 = await st();
    check(name, s1.blocks === s2.blocks + 1 && /\*\*粗\*\*\n\n\*\*體\*\*/.test(s1.md) && /\*\*粗體\*\*/.test(s2.md) && s2.caret.includes("粗|體"), { s1: s1.md.slice(0, 60), s2: s2.md.slice(0, 60), caret: s2.caret });
  });
  await run("全形開頭也會變：「－ 」項目、「1、」編號、「＃ 」標題、「【】 」待辦、「》」引用", async (name) => {
    const out = [];
    for (const [pre, re] of [["－ ", /\n- 項$/], ["1、", /\n1\. 項$/], ["＃ ", /\n# 項$/], ["【】 ", /\n- \[ \] 項$/], ["》 ", /\n> 項$/]]) {
      await open();
      await click(await pt("最後一段"));
      await key("End"); await key("Return");
      await type(pre + "項");
      await key("Escape");
      const s = await st();
      out.push([pre, re.test(s.md), s.md.slice(-12)]);
    }
    check(name, out.every((x) => x[1]), out);
  });
  await run("空的一塊打「、」或「／」：叫出插入選單；選了變成那一種", async (name) => {
    await click(await pt("最後一段"));
    await key("End"); await key("Return");
    await type("、");
    const s1 = await st();
    await key("Escape");
    await key("Backspace");  // 選單收起來了，「、」還在：刪掉再試「／」
    await type("／標題");
    const s2 = await st();
    await key("Return");
    await type("新標題");
    await key("Escape");
    const s3 = await st();
    check(name, s1.slash && s2.slash && /\n### 新標題$|\n# 新標題$|\n## 新標題$/.test(s3.md), { s1: s1.slash, s2: s2.slash, tail: s3.md.slice(-14) });
  });
  await run("⌘⌥1 變大標題、⌘⇧8 變項目清單、⌘⇧7 變編號（不用打字）", async (name) => {
    await click(await pt("最後一段"));
    await key("1", [CMD, "alt"]);
    const s1 = await st();
    await key("8", [CMD, "shift"]);
    const s2 = await st();
    await key("7", [CMD, "shift"]);
    const s3 = await st();
    check(name, /hl-1/.test(s1.cls) && /l-bullet/.test(s2.cls) && /l-number/.test(s3.cls) && /\n1\. 最後一段。$/.test(s3.md), { c1: s1.cls, c2: s2.cls, c3: s3.cls, md: s3.md.slice(-12) });
  });
  await run("點公式：開 TeX 小框，改了 Enter，排好的樣子跟著變", async (name) => {
    const p = await js(`(function(){ const k = document.querySelector("#noteEd .katex"); const r = k.getBoundingClientRect(); k.scrollIntoView({ block: "center" }); const r2 = k.getBoundingClientRect(); return { x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) }; })()`);
    await click(p);  // 第一次：進編輯
    await sleep(150);
    const q = await js(`(function(){ const k = document.querySelector("#noteEd .bk-rich .rt-tex"); const r = k.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await click(q);  // 再點那個公式：小框
    const s1 = await st();
    await key("A", [CMD]);
    await type("\\alpha_t");
    await key("Return");
    const s2 = await st();
    check(name, s1.pop && /\$\\alpha_t\$/.test(s2.md) && !s2.pop, { pop: s1.pop, md: (s2.md.match(/\$[^$]*\$/) || [])[0] });
  });
  await run("貼上別處帶格式的字（HTML）：粗體、清單、表格照樣留下；PDF 的斷行接好", async (name) => {
    await click(await pt("最後一段"));
    await key("End"); await key("Return");
    const paste = (html, text) => js("(function(){ const dt = new DataTransfer(); " + (html ? "dt.setData('text/html', " + JSON.stringify(html) + "); " : "") + "dt.setData('text/plain', " + JSON.stringify(text) + "); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })(); 1");
    await paste("<p>從網頁<b>複製</b>的<i>字</i></p><ul><li>甲</li><li>乙</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>", "從網頁複製的字\n甲\n乙");
    await sleep(200);
    const s1 = await st();
    await key("Escape");
    await click(await pt("最後一段"));
    await key("End"); await key("Return");
    await paste("", "This sentence was copied out of a PDF file and the line\nbreaks in the middle of it, with a hyphen-\nated word too.");
    await sleep(200);
    const s2 = await st();
    check(name, /從網頁\*\*複製\*\*的\*字\*/.test(s1.md) && /- 甲\n- 乙/.test(s1.md) && /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/.test(s1.md) && /of it, with a hyphenated word too\./.test(s2.md) && /the line breaks/.test(s2.md),
      { s1: s1.md.slice(-140), s2: s2.md.slice(-120) });
  });
  await run("選字時上面浮出格式工具列，游標所在的樣式是亮的", async (name) => {
    await click(await pt("粗體"));
    await js(`(function(){ const el = document.activeElement; const c = PR.rich.caret(el); PR.rich.setCaret(el, c.start, c.start + 2); document.dispatchEvent(new Event("selectionchange")); })(); 1`);
    await sleep(150);
    const s = await st();
    const on = await js('Array.from(document.querySelectorAll(".bk-tools button.on")).map((b) => b.dataset.t)');
    check(name, s.tools && on.includes("**"), { tools: s.tools, on });
  });
  await run("注音輸入中（composition）不動畫面：選好字才收、開頭的「－ 」照樣變清單", async (name) => {
    await click(await pt("最後一段"));
    await key("End"); await key("Return");
    // 用 Chromium 自己的輸入法事件（DevTools 協定）：先是選字中的「－ 」，再確定
    const dbg = wc.debugger;
    try { dbg.attach("1.3"); } catch (e) { /* 已經接上 */ }
    await dbg.sendCommand("Input.imeSetComposition", { text: "－", selectionStart: 1, selectionEnd: 1 });
    await sleep(60);
    await dbg.sendCommand("Input.imeSetComposition", { text: "－ ", selectionStart: 2, selectionEnd: 2 });
    await sleep(120);
    const mid = await st();
    await dbg.sendCommand("Input.insertText", { text: "－ " });
    await sleep(150);
    try { dbg.detach(); } catch (e) { /* 沒關係 */ }
    await type("清單");
    await key("Escape");
    const s = await st();
    check(name, /t-p/.test(mid.cls) && /\n- 清單$/.test(s.md), { mid: mid.cls, md: s.md.slice(-10) });
  });
  await run("表格一格一格直接改：點格子、Tab 走到下一格、最後一格 Tab 多一列、⌘B 在格子裡變粗", async (name) => {
    await open("段落\n\n| 名稱 | 數字 |\n| --- | ---: |\n| A | 1 |");
    await click(await pt("A"));
    const s0 = await js("({ cell: !!document.activeElement.closest('.bk-cell'), grid: !!document.querySelector('.bk-b.editing .bk-grid') })");
    await key("End"); await type("甲");
    await key("Tab"); await key("End"); await type("0");
    await key("Tab");  // 最後一格：多一列
    await type("B");
    await key("Tab"); await type("2");
    await key("Home", ["shift"]);
    await key("B", [CMD]);
    await key("Escape");
    const s = await st();
    check(name, s0.cell && s0.grid && /\| 名稱 \| 數字 \|\n\| --- \| ---: \|\n\| A甲 \| 10 \|\n\| B \| \*\*2\*\* \|/.test(s.md), { s0, md: s.md.slice(-80) });
  });
  await run("表格：右鍵在右邊插入一欄、下面的「＋」加一列、貼上試算表的幾格從這一格開始填", async (name) => {
    await open("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |");
    await click(await pt("1"));
    const p1 = await pt("1");
    mouse("mouseDown", p1.x, p1.y, { button: "right" }); mouse("mouseUp", p1.x, p1.y, { button: "right" }); wc.sendInputEvent({ type: "contextMenu", x: p1.x, y: p1.y });
    await sleep(150);
    const item = await js("(() => { const b = Array.from(document.querySelectorAll('#ctxmenu button.mi')).find((x) => /右邊插入一欄|column to the right/i.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()");
    if (item) await click(item);
    const s1 = await st();
    const add = await js("(() => { const b = document.querySelector('.bk-b.editing .bk-gadd.row'); if (!b) return { missing: true, editing: document.querySelectorAll('.bk-b.editing').length, active: document.activeElement && document.activeElement.className }; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()");
    if (add.missing) { check(name, false, { add, item: !!item, md: s1.md }); return; }
    mouse("mouseMove", add.x, add.y - 30); await sleep(80);
    await click(add);
    await js("(function(){ const dt = new DataTransfer(); dt.setData('text/plain', " + JSON.stringify("x\ty\nz\tw") + "); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })(); 1");
    await sleep(150);
    await key("Escape");
    const s2 = await st();
    check(name, !!item && s1.md.includes("| 甲 |  | 乙 |") && s1.md.includes("| 1 |  | 2 |") && /\| x \| y \|  \|\n\| z \| w \|  \|$/.test(s2.md), { item: !!item, s1: s1.md, s2: s2.md });
  });
  await run("打字時外面送來內容：剛打的字不會被蓋掉；存檔還沒跟上時拿到自己舊的內容也不理", async (name) => {
    await click(await pt("最後一段"));
    await key("End");
    await type("甲");
    // 外面真的改了（別台電腦同步過來）：正在打字先不換；之後又打了字 → 停下來時留自己的
    await js("PR.noteEd.setValue('外面改的內容'); 1");
    await type("乙");
    await key("Escape"); await sleep(600);
    const s1 = await st();
    const stored1 = await js("fetch('/api/notes/' + PR.note.id).then((r) => r.json()).then((n) => n.body)");
    // 存檔還在去抖的那 0.4 秒裡，外面拿自己上一次交出去的（舊的）內容來 setValue：不是外面改了，不理
    const p2 = await pt("甲乙");
    if (!p2) { check(name, false, { s1: s1.md.slice(-20), stored1: String(stored1).slice(-20) }); return; }  // 剛打的字已經被蓋掉了
    await click(p2);
    await key("End");
    await type("丙");
    const old = s1.md;
    await js("PR.noteEd.setValue(" + JSON.stringify(old) + "); 1");
    await key("Escape"); await sleep(600);
    const s2 = await st();
    // 外面真的改了、之後沒再打字：停下來就換上外面的
    const p3 = await pt("甲乙丙");
    if (!p3) { check(name, false, { s2: s2.md.slice(-20) }); return; }
    await click(p3);
    await js("PR.noteEd.setValue('外面改的內容'); 1");
    await key("Escape"); await sleep(600);
    const s3 = await st();
    check(name, /最後一段。甲乙$/.test(s1.md) && stored1 === s1.md && /最後一段。甲乙丙$/.test(s2.md) && s3.md === "外面改的內容", { s1: s1.md.slice(-12), stored1: String(stored1).slice(-12), s2: s2.md.slice(-12), s3: s3.md });
  });
  await run("打 @ 找文件：選了變成連結（第一作者 年），接著打的字在連結外面；打 email 的 a@b 不會跳出來", async (name) => {
    await click(await pt("最後一段"));
    await key("End");
    await type("寄到 a@b");
    await sleep(500);
    const mail = await js("!!document.querySelector('.bk-mention.open')");
    await type(" 見 @karan");
    let shown = false;
    for (let k = 0; k < 30 && !shown; k++) { await sleep(100); shown = await js("!!document.querySelector('.bk-mention.open .bk-mi')"); }
    const first = await js("(document.querySelector('.bk-mention.open .bk-mi.on') || {}).textContent || ''");
    await key("Return");
    await type("提出");
    await key("Escape"); await sleep(500);
    const s = await st();
    check(name, !mail && shown && /Finetuning|取樣/.test(first) && /見 \[Karan 2026\]\(\/read\/4cf6b1e1a402\)提出$/.test(s.md), { mail, shown, first, md: s.md.slice(-80) });
  });
  await run("打 -> 變 →、<= 變 ≤、<-> 變 ↔；緊接著按 Backspace 變回 ->；`程式碼` 裡不換", async (name) => {
    await click(await pt("最後一段"));
    await key("End");
    await type(" A->B, x<=y, a<->b, c->");
    await key("Backspace");  // 剛換成 → 的那個：變回 ->
    await type("d `p->q`");
    await key("Escape"); await sleep(500);
    const s = await st();
    check(name, / A→B, x≤y, a↔b, c->d `p->q`$/.test(s.md), { md: s.md.slice(-60) });
  });
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  step = "cleanup";
  if (!keep) await cleanup();
  console.log(bad ? bad + " 項沒過" : "全部通過");
  app.exit(bad ? 1 : 0);
});
