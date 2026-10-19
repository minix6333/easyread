// 外部工具欄裡的 AI 讀得到正在讀的文件（web/js/dock-ai.js、dock-guest.js、electron/embed-bridge.cjs）：
// 用一個本機的假 AI 網頁（深色底、一則有頁碼和公式的回答、上傳欄位、輸入框）嵌進右邊，逐項看：
// 底色換成 FOLI 面板的、回答裡的頁碼標出來而且點了會翻頁、附上這一頁（交給上傳欄位；沒有欄位時拖進輸入框）、
// 閱讀頁選字「問右邊的…」貼進輸入框、最後一則回答存成提問紀錄（公式還原成 TeX）、回答上按右鍵的翻頁、
// 在它的輸入框按 Enter／送出鈕：先附上正在讀的那一頁、等它「上傳」完才送出（同一段對話同一頁不重附、問整份加上 PDF、可以關掉）。
// 不連任何外部網站；存進去的筆記最後刪掉。
//   node_modules/.bin/electron scripts/dock_ai_check.cjs <論文 id> [--base URL]
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const bridge = require("../electron/embed-bridge.cjs");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765"), pid = argv.find((a) => /^[0-9a-f]{6,}$/.test(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "start", cleanup = null;
const fail = async (e) => { console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 600)); if (cleanup) await cleanup().catch(() => {}); app.exit(2); };
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error("TIMEOUT")), 150000);
if (!pid) { console.log("FAILED — 要給一篇論文的 id"); process.exit(2); }

const MOCK = (input, sneaky) => `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>
:root { --surface-0: #000000; --surface-1: #212121; --surface-2: #303030; --text: #ececec; --brand: #10a37f; }
html, body { margin: 0; height: 100%; background: var(--surface-0); color: var(--text); font: 15px system-ui; }
main { position: fixed; inset: 0; background: var(--surface-0); display: flex; flex-direction: column; }
.thread { flex: 1; overflow: auto; padding: 16px; }
.bubble { background: var(--surface-2); border-radius: 18px; padding: 8px 12px; margin: 8px 0 8px 30%; }
.literal { background: #0b0b0b; height: 40px; }
.composer { margin: 12px; background: var(--surface-1); border-radius: 24px; padding: 10px 16px; }
textarea { width: 100%; height: 48px; background: transparent; color: inherit; border: 0; outline: 0; font: inherit; }
button.send { background: var(--brand); }
</style></head><body><main>
<div class="thread">
  <div data-message-author-role="user" class="bubble">連續的隨機變數，期望值為什麼要用積分？</div>
  <div data-message-author-role="assistant" class="answer"><p>先看<strong>第 3 頁</strong>的定義，例子在 p. 5。</p>
  <p>公式：<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">E[X]=\\int x\\,p(x)\\,dx</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E[X]=∫xp(x)dx</span></span>。</p>
  <ul><li>離散：加總</li><li>連續：積分</li></ul></div>
</div>
<div class="literal"></div>
<form class="composer" onsubmit="return false">${input ? '<input type="file" id="files" multiple accept="image/*,application/pdf" hidden>' : ""}<textarea id="prompt-textarea" placeholder="問問"></textarea><span class="bar" role="progressbar" hidden>…</span><button class="send" type="button"${input ? ' aria-label="Send prompt"' : ""}>送出</button></form>
</main><script>
window.__got = []; window.__sent = []; window.__upDone = 0;
const f = document.getElementById("files"), btn = document.querySelector(".send"), bar = document.querySelector(".bar"), ta = document.getElementById("prompt-textarea");
// 收到檔案就「上傳」0.7 秒：這段時間送出鈕不能按、有進度條（和真的網站一樣）。
// sneaky：上傳 1.2 秒，送出鈕看起來能按、也沒有進度條，但傳完之前按送出它不理
const sneaky = ${sneaky ? "true" : "false"};
let busy = false;
const upload = () => {
  if (sneaky) { busy = true; setTimeout(() => { busy = false; window.__upDone = Date.now(); }, 1200); return; }
  btn.disabled = true; bar.hidden = false; setTimeout(() => { btn.disabled = false; bar.hidden = true; window.__upDone = Date.now(); }, 700);
};
if (f) f.addEventListener("change", (e) => { for (const x of e.target.files) window.__got.push("input:" + x.name + ":" + x.size); upload(); });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); for (const x of e.dataTransfer.files) window.__got.push("drop:" + x.name + ":" + x.size); upload(); });
const send = () => { if (btn.disabled || busy || !ta.value.trim()) return; window.__sent.push({ text: ta.value, got: window.__got.slice(), at: Date.now() }); ta.value = ""; window.__got = []; };
btn.addEventListener("click", send);
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
</script></body></html>`;

// 外部工具欄不收本機網址（127.0.0.1、localhost）：假網頁用一個名字，這個測試自己的 Electron 把它對到本機
app.commandLine.appendSwitch("host-resolver-rules", "MAP foli-mock.test 127.0.0.1");
app.whenReady().then(async () => {
  step = "mock server";
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(MOCK(!/noinput/.test(req.url), /sneaky/.test(req.url))); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const mock = "http://foli-mock.test:" + server.address().port + "/";
  // 預載：和桌面版的 preload 一樣的那幾個（這裡的主程序自己接 embed-files，用的是同一份 embed-bridge.cjs）
  const pre = path.join(os.tmpdir(), "foli-dockai-preload-" + process.pid + ".cjs");
  fs.writeFileSync(pre, `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("easyreadDesktop", { isElectron: true, platform: process.platform, setTheme: () => Promise.resolve(true),
  embedFiles: (id, files, at) => ipcRenderer.invoke("easyread:embed-files", { id, files, at }),
  onEmbedAction: (cb) => { const l = (_e, m) => cb(m); ipcRenderer.on("easyread:embed-action", l); return () => ipcRenderer.removeListener("easyread:embed-action", l); } });`);
  ipcMain.handle("easyread:embed-files", async (_e, arg) => {
    const wc = webContents.fromId(Number(arg && arg.id));
    const files = bridge.checkFiles(arg && arg.files);
    if (!wc || !files) return { ok: false, error: !wc ? "target" : "files" };
    return bridge.giveFiles(wc, files, arg.at || null);
  });
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { webviewTag: true, preload: pre, backgroundThrottling: false, partition: "dockai-" + Date.now() } });
  const wc = win.webContents;
  const errors = [];
  wc.on("console-message", (e) => { if ((e.level === "error" || e.level === 3) && !/presence|WebSocket|favicon|ResizeObserver loop/.test(e.message || "")) errors.push("[" + step + "] " + e.message + " @ " + (e.sourceId || "").replace(/^.*\/web\//, "") + ":" + e.lineNumber); });
  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (cond, what, n) => { for (let i = 0; i < (n || 120); i++) { if (await js("!!(" + cond + ")").catch(() => false)) return; await sleep(100); } throw new Error("waited too long for " + what); };
  const guestOf = () => webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed() && /^http:\/\/foli-mock\.test/.test(w.getURL()));
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 600))); };

  step = "open shell";
  await win.loadURL(base + "/library").catch(() => {});
  await js(`localStorage.setItem("easyread-dockai-any", "1"); localStorage.setItem("easyread-dock", JSON.stringify({ open: true, w: 460, nw: 480, apps: [{ id: "d1", url: ${JSON.stringify(mock)}, name: "MockAI" }], active: "d1", seq: 1 })); 1`);
  await win.loadURL(base + "/?open=/read/" + pid).catch(() => {});
  await waitFor("window.PR && PR.shell && PR.dockAI && PR.shell.frameOf('/read/" + pid + "') && PR.shell.frameOf('/read/" + pid + "').PR && PR.shell.frameOf('/read/" + pid + "').PR.pdfPage", "the reader in the shell", 200);
  wc.focus();
  const R = "PR.shell.frameOf('/read/" + pid + "')";
  await js(R + ".PR.commit = ((orig) => function (op) { if (op && op.op === 'progress') return; return orig.apply(this, arguments); })(" + R + ".PR.commit); 1");  // 不記閱讀進度（這份的「上次讀到哪」留著）
  // 閱讀頁剛打開的 1.8 秒內會再跳回「上次讀到的頁」（除非讀者動過）：先當成讀者點過，翻頁才不會被蓋回去
  await js("(() => { const w = " + R + "; w.document.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true })); return 1; })()");
  let g = null;
  for (let i = 0; i < 100 && !(g = guestOf()); i++) await sleep(100);
  if (!g) throw new Error("no webview guest");
  for (let i = 0; i < 100 && !(await g.executeJavaScript("!!window.__foliGuest").catch(() => false)); i++) await sleep(100);
  await sleep(600);

  step = "skin";
  const sheet = await js("getComputedStyle(document.querySelector('#dock .dock-body')).backgroundColor");
  const look = await g.executeJavaScript("({ main: getComputedStyle(document.querySelector('main')).backgroundColor, body: getComputedStyle(document.body).backgroundColor, composer: getComputedStyle(document.querySelector('.composer')).backgroundColor, literal: getComputedStyle(document.querySelector('.literal')).backgroundColor, text: getComputedStyle(document.querySelector('.answer')).color, brand: getComputedStyle(document.querySelector('.send')).backgroundColor })");
  const near = (a, b) => { const x = (a.match(/\d+/g) || []).map(Number), y = (b.match(/\d+/g) || []).map(Number); return x.length >= 3 && y.length >= 3 && Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) <= 9; };
  check("底色換成 FOLI 面板的顏色（變數和寫死的大區塊都換），輸入框比底亮一點，文字色、品牌色不動",
    near(look.main, sheet) && near(look.body, sheet) && !near(look.composer, sheet) && !/^rgb\(33, 33, 33\)/.test(look.composer) && look.literal !== "rgb(11, 11, 11)" &&
    look.text === "rgb(236, 236, 236)" && look.brand === "rgb(16, 163, 127)", { sheet, look });

  if (opt("--shot", "")) {  // --shot 檔名：換好底色、標好頁碼的樣子截一張（給人看）
    await sleep(400);
    const b = await js("(() => { const r = document.querySelector('#dock').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    fs.writeFileSync(opt("--shot", ""), (await wc.capturePage({ x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.w), height: Math.ceil(b.h) })).toPNG());
  }
  step = "plain colours";
  await js("(() => { const a = PR.dock.current(); a.plain = true; return PR.dockAI.reskin(document.querySelector('#dock webview.dock-view'), a).then(() => 1); })()");
  const plain = await g.executeJavaScript("getComputedStyle(document.querySelector('main')).backgroundColor");
  await js("(() => { const a = PR.dock.current(); a.plain = false; return PR.dockAI.reskin(document.querySelector('#dock webview.dock-view'), a).then(() => 1); })()");
  const back = await g.executeJavaScript("getComputedStyle(document.querySelector('main')).backgroundColor");
  check("「⋯」裡關掉「換成 FOLI 的底色」：回到網站原本的顏色；再打開又換回來", plain === "rgb(0, 0, 0)" && near(back, sheet), { plain, back, sheet });

  step = "page refs";
  const refs = await g.executeJavaScript("window.__foliGuest.hits()");
  check("回答裡的頁碼標出來（第 3 頁、p. 5）", refs === 2, { refs });
  const at = await g.executeJavaScript("(() => { const n = [...document.querySelectorAll('.answer strong')][0].firstChild; const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.nodeValue.length); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()");
  g.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
  await sleep(120);
  const hand = await g.executeJavaScript("document.documentElement.classList.contains('foli-hand')");
  g.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  g.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(1500);
  const page = await js(R + ".PR.pdfPage()");
  check("滑過頁碼是手指，點了左邊翻到第 3 頁", hand && page === 3, { hand, page });

  step = "attach page";
  await js(R + ".PR.goToPage(4); 1");
  await sleep(800);
  await js("(async () => { const a = PR.dock.current(); return a && a.id; })()");
  const attachRes = await js(`(async () => {
    const d = ${R}.PR;
    const v = document.querySelector('#dock webview.dock-view');
    const f = await PR.api('/api/p/${pid}/handoff', { method: 'POST', body: { do: 'file', kind: 'page', page: d.pdfPage() } });
    v.focus();
    const at = await v.executeJavaScript('window.__foliGuest.focusComposer()');
    return { file: f.name, r: await window.easyreadDesktop.embedFiles(v.getWebContentsId(), [f.path], at) };
  })()`);
  await sleep(400);
  const got = await g.executeJavaScript("window.__got.slice()");
  check("附上這一頁：交給它的上傳欄位（檔名是文件標題＋頁碼）", attachRes.r && attachRes.r.ok && attachRes.r.how === "input" && got.length === 1 && /^input:.* p4\.jpg:\d+$/.test(got[0]), { attachRes, got });
  const refused = await js(`window.easyreadDesktop.embedFiles(document.querySelector('#dock webview.dock-view').getWebContentsId(), ['/etc/hosts'], null)`);
  check("只收 FOLI 做好的那幾個檔案（別的路徑一律不給）", refused && refused.ok === false && refused.error === "files", refused);

  step = "paperclip menu";
  await g.executeJavaScript("window.__got = []; document.querySelector('#prompt-textarea').value = ''; 1");
  const clip = await js("(() => { const b = document.querySelector('#dock [data-d=ai]'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
  wc.sendInputEvent({ type: "mouseMove", x: clip.x, y: clip.y });
  wc.sendInputEvent({ type: "mouseDown", x: clip.x, y: clip.y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: clip.x, y: clip.y, button: "left", clickCount: 1 });
  await sleep(500);
  const items = await js("[...document.querySelectorAll('#ctxmenu .mi')].map((b) => b.textContent.trim() + (b.disabled ? ' (off)' : ''))");
  const pageItem = await js("(() => { const b = [...document.querySelectorAll('#ctxmenu .mi')].find((x) => /附上這一頁/.test(x.textContent)); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
  wc.sendInputEvent({ type: "mouseMove", x: pageItem.x, y: pageItem.y });
  wc.sendInputEvent({ type: "mouseDown", x: pageItem.x, y: pageItem.y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: pageItem.x, y: pageItem.y, button: "left", clickCount: 1 });
  await sleep(1500);
  const got3 = await g.executeJavaScript("window.__got.slice()"), line = await g.executeJavaScript("document.querySelector('#prompt-textarea').value");
  check("點迴紋針 →「附上這一頁」：檔案交給它、輸入框多一句說明（還沒送出）",
    items.length === 6 && /《.+》/.test(items[0]) && /\(off\)$/.test(items[0]) && got3.length === 1 && /p4\.jpg/.test(got3[0]) && /^附上的是《.+》第 4 頁。\s*$/.test(line) && !(await g.executeJavaScript("window.__sent.length")),
    { items, got3, line });

  step = "ask from selection";
  await g.executeJavaScript("document.querySelector('#prompt-textarea').value = ''; 1");
  const asked = await js(`PR.dockAI.ask("Supervised finetuning suffers from catastrophic forgetting.", 2)`);
  await sleep(300);
  const typed = await g.executeJavaScript("document.querySelector('#prompt-textarea').value");
  const sent = (await g.executeJavaScript("window.__sent.length")) > 0;
  check("閱讀頁選字「問右邊的…」：選的字和出處貼進輸入框，沒有送出", asked && /^「Supervised finetuning suffers from catastrophic forgetting\.」（《.+》第 2 頁）\s*$/.test(typed) && !sent, { typed, sent });

  step = "save last answer";
  const before = await js(`PR.api('/api/p/${pid}/state').then((s) => Object.keys((s.reader || {}).notes || {}))`);
  const ans = await g.executeJavaScript("window.__foliGuest.lastAnswer()");
  const saved = await js(`PR.api('/api/p/${pid}/handoff', { method: 'POST', body: { do: 'qa', page: 4, question: ${JSON.stringify(ans.question)}, answer: ${JSON.stringify(ans.md)}, by: 'MockAI' } })`);
  const nid = saved && saved.note && saved.note.id;
  cleanup = async () => {
    if (!nid) return;
    const st = await js(`PR.api('/api/p/${pid}/state')`).catch(() => null);
    const rid = st && ((st.discussion || {}).entries || []).filter((e) => e.reply_to === nid).map((e) => e.id);
    for (const id of rid || []) await js(`PR.api('/api/p/${pid}/discussion_del', { method: 'POST', body: { id: ${JSON.stringify(id)} } })`).catch(() => {});
    await js(`PR.api('/api/p/${pid}/ops', { method: 'POST', body: { ops: [{ op: 'note_del', id: ${JSON.stringify(nid)}, at: new Date().toISOString() }] } })`).catch(() => {});
  };
  const st = await js(`PR.api('/api/p/${pid}/state')`);
  const note = ((st.reader || {}).notes || {})[nid] || {};
  const reply = ((st.discussion || {}).entries || []).find((e) => e.reply_to === nid) || {};
  check("最後一則回答存成提問紀錄：問題當標題、回答（公式還原成 TeX、清單照樣）、署名是那個 AI",
    !before.includes(nid) && note.kind === "question" && note.page === 4 && /期望值為什麼要用積分/.test(note.body) &&
    /\$E\[X\]=\\int x\\,p\(x\)\\,dx\$/.test(reply.body || "") && /\*\*第 3 頁\*\*/.test(reply.body || "") && /- 離散：加總\n- 連續：積分/.test(reply.body || "") && reply.by === "MockAI",
    { note, reply: (reply.body || "").slice(0, 300) });

  step = "context menu page";
  win.webContents.send("easyread:embed-action", { action: "page", page: 6, id: g.id });
  await sleep(1500);
  check("回答上選字按右鍵「跳到第 N 頁」：左邊翻過去", (await js(R + ".PR.pdfPage()")) === 6, {});

  step = "attach on send";
  // 讀者在它的輸入框打字、按 Enter（真的按鍵）或點送出鈕；回傳這一則送出時帶了哪些檔案、從按下去到送出花多久
  const V = "document.querySelector('#dock webview.dock-view')";
  const askIt = async (text, how) => {
    await g.executeJavaScript("(() => { window.__got = []; window.__sent = []; const t = document.querySelector('#prompt-textarea'); t.value = " + JSON.stringify(text) + "; t.focus(); return 1; })()");
    const t0 = Date.now();
    if (how === "click") {
      const b = await g.executeJavaScript("(() => { const r = document.querySelector('.send').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
      g.sendInputEvent({ type: "mouseMove", x: b.x, y: b.y });
      g.sendInputEvent({ type: "mouseDown", x: b.x, y: b.y, button: "left", clickCount: 1 });
      g.sendInputEvent({ type: "mouseUp", x: b.x, y: b.y, button: "left", clickCount: 1 });
    } else {
      g.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      g.sendInputEvent({ type: "char", keyCode: "\r" });
      g.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    }
    for (let i = 0; i < 80 && !(await g.executeJavaScript("window.__sent.length")); i++) await sleep(100);
    const sent = await g.executeJavaScript("window.__sent.slice()"), up = await g.executeJavaScript("window.__upDone");
    return { sent, ms: Date.now() - t0, afterUpload: !!(sent[0] && sent[0].at >= up) };
  };
  const files = (r) => ((r.sent[0] || {}).got || []).map((x) => (/\.pdf:\d+$/.test(x) ? "pdf" : (x.match(/ (p\d+\.jpg):\d+$/) || [])[1] || x));
  g.focus();
  await js(R + ".PR.goToPage(6); 1");
  await sleep(700);
  const r1 = await askIt("這頁在講什麼");
  check("在它的輸入框問「這頁在講什麼」按 Enter：先附上正在讀的第 6 頁，傳完才送出，問題原封不動",
    r1.sent.length === 1 && r1.sent[0].text === "這頁在講什麼" && JSON.stringify(files(r1)) === '["p6.jpg"]' && r1.afterUpload, r1);
  const r2 = await askIt("那第二個公式呢");
  check("同一段對話、同一頁接著問：不再附，馬上送出", r2.sent.length === 1 && !files(r2).length && r2.ms < 1200, r2);
  await g.executeJavaScript("history.pushState(null, '', '/c/6a1b2c3d-new'); 1");
  const r3 = await askIt("再問一個");
  await g.executeJavaScript("history.pushState(null, '', '/c/9f8e7d6c-other'); 1");
  const r4 = await askIt("換一段對話問");
  check("新對話有了編號還是同一段（不重附）；換到另一段對話就重新附", r3.sent.length === 1 && !files(r3).length && JSON.stringify(files(r4)) === '["p6.jpg"]', { r3, r4 });
  await js(R + ".PR.goToPage(7); 1");
  await sleep(700);
  const r5 = await askIt("整份在講什麼");
  check("翻到第 7 頁、問「整份」：附上整份 PDF 和第 7 頁", r5.sent.length === 1 && JSON.stringify(files(r5)) === '["pdf","p7.jpg"]' && r5.afterUpload, r5);
  await js("PR.dockAI.auto(" + V + ", PR.dock.current(), false)");
  await js(R + ".PR.goToPage(8); 1");
  await sleep(700);
  const r6 = await askIt("不要附");
  const kept = await js("JSON.parse(localStorage.getItem('easyread-dock')).apps[0].noPage");
  await js("PR.dockAI.auto(" + V + ", PR.dock.current(), true)");
  check("迴紋針裡關掉「問問題時附上正在讀的這一頁」：照常送出、什麼都不附，設定記住", r6.sent.length === 1 && !files(r6).length && r6.ms < 1200 && kept === true, { r6, kept });
  const r7 = await askIt("用按鈕送出", "click");
  check("點送出鈕也一樣：先附上第 8 頁再送出", r7.sent.length === 1 && r7.sent[0].text === "用按鈕送出" && JSON.stringify(files(r7)) === '["p8.jpg"]' && r7.afterUpload, r7);
  await g.executeJavaScript("(() => { const t = document.querySelector('#prompt-textarea'); t.value = 'a'; t.focus(); window.__sent = []; return 1; })()");
  g.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers: ["shift"] });
  g.sendInputEvent({ type: "keyUp", keyCode: "Return", modifiers: ["shift"] });
  await sleep(500);
  check("Shift+Enter（換行）不攔、不送", (await g.executeJavaScript("window.__sent.length")) === 0, {});
  await g.executeJavaScript("document.querySelector('#prompt-textarea').value = ''; 1");

  step = "drop fallback";
  await g.loadURL(mock + "?noinput=1");
  for (let i = 0; i < 100 && !(await g.executeJavaScript("!!window.__foliGuest").catch(() => false)); i++) await sleep(100);
  await sleep(500);
  const drop = await js(`(async () => {
    const v = document.querySelector('#dock webview.dock-view');
    const f = await PR.api('/api/p/${pid}/handoff', { method: 'POST', body: { do: 'file', kind: 'pdf' } });
    v.focus();
    const at = await v.executeJavaScript('window.__foliGuest.focusComposer()');
    return await window.easyreadDesktop.embedFiles(v.getWebContentsId(), [f.path], at);
  })()`);
  await sleep(500);
  const got2 = await g.executeJavaScript("window.__got.slice()");
  check("沒有上傳欄位的網站：模擬把 PDF 拖進輸入框", drop && drop.ok && drop.how === "drop" && got2.length === 1 && /^drop:.+\.pdf:\d+$/.test(got2[0]), { drop, got2 });
  await sleep(800);
  g.focus();
  const r8 = await askIt("認不出送出鈕");
  check("上傳欄位、送出鈕都認不出的網站：這一頁拖進去、等它傳完，FOLI 替讀者按 Enter 送出", r8.sent.length === 1 && r8.sent[0].text === "認不出送出鈕" && JSON.stringify(files(r8)) === '["p8.jpg"]' && r8.afterUpload, r8);
  await g.executeJavaScript("console.debug = () => {}; 1");  // FOLI 收不到「要送出了」：當成 FOLI 沒回應
  const r9 = await askIt("FOLI 沒回應");
  check("FOLI 沒回應：1.5 秒後照常送出，問題不會卡住", r9.sent.length === 1 && r9.ms >= 1400 && r9.ms < 3000, r9);
  await g.loadURL(mock + "?sneaky=1");
  for (let i = 0; i < 100 && !(await g.executeJavaScript("!!window.__foliGuest").catch(() => false)); i++) await sleep(100);
  await sleep(500);
  g.focus();
  await js(R + ".PR.goToPage(9); 1");
  await sleep(700);
  const r10 = await askIt("上傳中按送出它不理的網站");
  check("上傳時送出鈕看起來能按、但按了不理的網站：傳完再按一次，只送出一則", r10.sent.length === 1 && JSON.stringify(files(r10)) === '["p9.jpg"]' && r10.afterUpload, r10);

  step = "cleanup";
  await cleanup();
  cleanup = null;
  await js("localStorage.removeItem('easyread-dock'); localStorage.removeItem('easyread-dockai-any'); 1");
  check("整個過程主控台沒有錯誤", errors.length === 0, errors.slice(0, 5));
  console.log(bad ? bad + " 項沒過" : "全部通過");
  server.close();
  try { fs.unlinkSync(pre); } catch (e) { /* 留著也沒關係 */ }
  app.exit(bad ? 1 : 0);
});
