/* 外殼右邊的外部工具欄（web/js/dock.js 的純函式）和把別的程式視窗貼齊在旁邊的算法（electron/native-dock.cjs）。
   node --test tests/test_dock.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

function model() {
  const PR = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/dock.js"), "utf8"), { window: { PR }, URL });
  return PR.dockModel;
}

test("only real web addresses can be embedded; bare domains get https, local addresses are refused", () => {
  const M = model();
  assert.equal(M.url("https://chatgpt.com/"), "https://chatgpt.com/");
  assert.equal(M.url("claude.ai/new"), "https://claude.ai/new");
  assert.equal(M.url("  https://gemini.google.com/app  extra words"), "https://gemini.google.com/app");
  for (const bad of ["", "hello", "file:///etc/passwd", "javascript:alert(1)", "http://127.0.0.1:8765/api/library", "http://localhost:3000/", "easyread://open?id=1"]) assert.equal(M.url(bad), "", bad);
});

test("a dragged link, a .webloc file and an app icon all resolve to something that can be docked", () => {
  const M = model();
  assert.equal(M.fromDrop("# from Chrome\r\nhttps://chatgpt.com/c/abc\r\n", "ignored"), "https://chatgpt.com/c/abc");
  assert.equal(M.fromDrop("", "www.perplexity.ai"), "https://www.perplexity.ai/");
  assert.equal(M.fromDrop("", "just some selected text"), "");
  assert.equal(M.fromLinkFile('<plist><dict><key>URL</key><string>https://notebooklm.google.com/?a=1&amp;b=2</string></dict></plist>'), "https://notebooklm.google.com/?a=1&b=2");
  assert.equal(M.fromLinkFile("[InternetShortcut]\r\nURL=https://www.deepl.com/translator\r\n"), "https://www.deepl.com/translator");
  same(M.fromApp("ChatGPT.app"), { url: "https://chatgpt.com/", name: "ChatGPT" });
  same(M.fromApp("/Applications/Finder.app/"), { unknown: "Finder" });
  assert.equal(M.fromApp("paper.pdf"), null);
});

test("adding the same site twice switches to it; removing the active one picks a neighbour; saved state is sanitised", () => {
  const M = model();
  const st = M.blank();
  const a = M.add(st, "https://chatgpt.com/");
  M.add(st, "claude.ai");
  assert.equal(M.add(st, "https://chatgpt.com/c/123").id, a.id);  // 同一個網站：切過去，不重複加
  assert.equal(st.apps.length, 2);
  assert.equal(st.active, a.id);
  assert.equal(M.add(st, "not a url"), null);
  M.remove(st, a.id);
  assert.equal(st.active, st.apps[0].id);
  assert.equal(M.nameOf("https://gemini.google.com/app"), "Gemini");
  assert.equal(M.nameOf("https://www.example.org/x"), "example.org");
  // 存下來的東西重新讀：壞掉的、本機的網址丟掉；程式的路徑要像 /…/X.app
  const back = M.load({ open: true, w: 500, active: "d2", seq: 9, apps: [{ id: "d1", url: "http://localhost:1/" }, { id: "d2", url: "https://claude.ai/", name: "Claude", icon: "javascript:x" },
    { id: "d3", kind: "app", path: "/Applications/ChatGPT.app", name: "ChatGPT" }, { id: "d4", kind: "app", path: "relative/Evil.app" }] });
  same(back.apps.map((x) => [x.id, x.kind || "web", x.icon]), [["d2", "web", ""], ["d3", "app", ""]]);
  assert.equal(back.open, true);
  assert.equal(M.load({ open: true, active: "d3", apps: [{ id: "d3", kind: "app", path: "/Applications/ChatGPT.app" }] }).open, false);  // 上次貼著程式：重開不自動再貼
  assert.equal(M.clampW(5000, 1400), 980);  // 至少留 420 給文件
  assert.equal(M.clampW(100, 1400), 320);
  const st2 = M.blank();
  assert.equal(M.addApp(st2, "ChatGPT.app"), null);
  const app = M.addApp(st2, "/Applications/ChatGPT.app/");
  same([app.kind, app.name, st2.active, st2.open], ["app", "ChatGPT", null, false]);  // 加進清單而已；貼成了才算切過去
  assert.equal(M.addApp(st2, "/Applications/ChatGPT.app").id, app.id);
});

/* ---------- 貼齊別的程式的視窗 ---------- */
// 一個假的「程式」：只要是個名字以 .app 結尾、真的存在的資料夾（別的平台跑測試時沒有 /Applications）
function fakeApp() {
  const dir = path.join(require("node:os").tmpdir(), "easyread-test-Fake.app");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function harness(opts = {}) {
  const { createNativeDock, split, beside } = require("../electron/native-dock.cjs");
  const sent = [], notes = [];
  const win = new EventEmitter();
  Object.assign(win, { bounds: { x: 100, y: 50, width: 1400, height: 900 }, min: [960, 680], full: false,
    getBounds() { return { ...this.bounds }; }, setBounds(b) { this.bounds = { ...b }; }, setMinimumSize(w, h) { this.min = [w, h]; },
    isDestroyed: () => false, isMinimized: () => false, isFullScreen() { return this.full; } });
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  const reply = (obj) => proc.stdout.emit("data", JSON.stringify(obj) + "\n");
  proc.stdin = { end() {}, write(line) {
    const msg = JSON.parse(line); sent.push(msg);
    if (msg.cmd === "trust") reply({ id: msg.id, ok: true, trusted: opts.trusted !== false });
    else if (msg.cmd === "attach") reply(opts.attach ? opts.attach(msg) : { id: msg.id, ok: true, frame: msg.frame });
    else if (msg.cmd === "detach") reply({ id: msg.id, ok: true });
  } };
  const dock = createNativeDock({ platform: opts.platform || "darwin", helperPath: __filename, getWindow: () => win, minSize: [960, 680], notify: (m) => notes.push(m), spawnHelper: () => proc });
  return { dock, win, sent, notes, reply, split, beside, tick: () => new Promise((r) => setTimeout(r, 40)) };
}

test("splitting the window's area: the two windows together cover exactly what the main window covered", () => {
  const { split, beside } = harness();
  const plan = split({ x: 100, y: 50, width: 1400, height: 900 }, 480);
  same(plan.host, { x: 100, y: 50, width: 920, height: 900 });
  same(plan.side, { x: 1020, y: 50, width: 480, height: 900 });
  assert.equal(split({ x: 0, y: 0, width: 1500, height: 900 }, 5000).side.width, 860);  // 主視窗至少留 640
  assert.equal(split({ x: 0, y: 0, width: 900, height: 700 }, 480), null);            // 兩個放不下
  same(beside({ x: 10, y: 20, width: 800, height: 600 }, 480), { x: 810, y: 20, width: 480, height: 600 });
});

test("docking an app narrows the main window, follows it when it moves, and gives the width back on undock", async () => {
  const h = harness({ attach: (m) => ({ id: m.id, ok: true, frame: [m.frame[0], m.frame[1], 520, m.frame[3]] }) });  // 對方最窄 520
  const r = await h.dock.attach(fakeApp(), 480);
  same(r, { ok: true, width: 520 });
  same(h.win.bounds, { x: 100, y: 50, width: 880, height: 900 });  // 照對方實際的寬度讓位
  assert.ok(h.win.min[0] <= 640);
  h.win.bounds = { x: 300, y: 80, width: 880, height: 700 };       // 使用者拖了 EasyRead
  h.win.emit("move"); h.win.emit("move");
  await h.tick();
  const frames = h.sent.filter((m) => m.cmd === "frame");
  same(frames[frames.length - 1].frame, [1180, 80, 520, 700]);     // 旁邊的跟上，還是貼著
  // 使用者拉了對方視窗的左緣（變窄 60）：主視窗補上
  h.reply({ event: "frame", frame: [1240, 80, 460, 700] });
  same(h.win.bounds, { x: 300, y: 80, width: 940, height: 700 });
  same(h.notes, [{ type: "width", width: 460 }]);
  // 使用者把對方拖走了：擺回來
  h.reply({ event: "frame", frame: [50, 400, 460, 300] });
  await h.tick();
  same(h.sent[h.sent.length - 1], { cmd: "frame", frame: [1240, 80, 460, 700] });
  await h.dock.detach();
  same(h.win.bounds, { x: 300, y: 80, width: 1400, height: 700 });  // 變回原來那麼寬
  same(h.win.min, [960, 680]);
  assert.equal(h.win.listenerCount("move"), 0);
  assert.equal(h.sent[h.sent.length - 1].cmd, "detach");
});

test("no permission, full screen, other platforms and a quitting app are all handled without moving anything", async () => {
  const appPath = fakeApp();
  let h = harness({ trusted: false });
  same(await h.dock.attach(appPath, 480), { ok: false, reason: "permission" });
  same(h.win.bounds, { x: 100, y: 50, width: 1400, height: 900 });
  assert.ok(!h.sent.some((m) => m.cmd === "attach"));
  h = harness();
  h.win.full = true;
  assert.equal((await h.dock.attach(appPath, 480)).reason, "fullscreen");
  h.win.full = false;
  assert.equal((await h.dock.attach("/tmp/not-an-app.txt", 480)).reason, "path");
  h = harness({ platform: "win32" });
  assert.equal((await h.dock.attach(appPath, 480)).reason, "platform");
  same(await h.dock.status(), { supported: false, trusted: false, active: false });
  // 貼著的程式自己關了：主視窗變回來，頁面收到通知
  h = harness();
  await h.dock.attach(appPath, 480);
  h.reply({ event: "gone" });
  same(h.win.bounds, { x: 100, y: 50, width: 1400, height: 900 });
  same(h.notes, [{ type: "gone" }]);
  assert.equal(h.dock.active(), false);
  // 關視窗前：先把寬度還原（window-state 才會記到原來的大小）
  await h.dock.attach(appPath, 480);
  h.dock.restoreNow();
  same(h.win.bounds, { x: 100, y: 50, width: 1400, height: 900 });
});
