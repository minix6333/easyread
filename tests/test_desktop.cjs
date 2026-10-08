const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

async function desktop(platform = "darwin", lock = true, ready = true, argv = []) {
  const app = new EventEmitter();
  Object.assign(app, {
    setPath() {}, getPath: () => "/tmp", getLocale: () => "zh-CN", isPackaged: true,
    requestSingleInstanceLock: () => lock, whenReady: () => Promise.resolve(), isReady: () => true,
    setAsDefaultProtocolClient(scheme) { this.protocol = scheme; },
    quit() { this.quitCalled = true; this.emit("before-quit", { preventDefault() {} }); },
    relaunch() { this.relaunched = true; }, exit() { this.exited = true; },
  });
  const windows = [], launches = [], menus = [], stages = [], handlers = new Map();
  const ipcMain = { handle(name, fn) { handlers.set(name, fn); } };
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = (fn) => { this.webContents.openHandler = fn; }; this.webContents.mainFrame = { url: "http://127.0.0.1:9876/" }; windows.push(this); }
    static getAllWindows() { return windows.filter(w => !w.closed); }
    async loadURL(url) { this.url = url; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    isMinimized() { return false; }
    close() { this.closed = true; this.emit("closed"); }
  }
  const Menu = {
    buildFromTemplate(items) { return { items, popup() { menus.push(items); } }; },
    setApplicationMenu(menu) { app.menu = menu; },
  };
  const childProcess = {
    execFileSync: () => "__PATH__/usr/bin:/bin__PATH__",
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit("exit", 0, "SIGTERM"); };
      launches.push({ command, args, options, child });
      if (ready) queueMicrotask(() => child.stdout.emit("data", "EasyRead 已启动：http://127.0.0.1:9876\n"));
      return child;
    },
  };
  const proc = new EventEmitter();
  Object.assign(proc, { platform, env: {}, resourcesPath: "/tmp/Resources", argv: ["EasyRead.exe", ...argv] });
  const fakeRequire = name => name === "electron" ? { app, BrowserWindow: Window, Menu, ipcMain, dialog: { showErrorBox() {}, showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/chosen"] }) }, shell: { openExternal(url) { app.external = (app.external || []).concat(url); } } }
    : name === "child_process" ? childProcess : name === "fs" ? { existsSync: () => true }
    : name === "http" ? { request(url, options, callback) {
      const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; callback(res);
        res.emit("data", JSON.stringify(url.pathname === "/api/library" ? { token: "test-token" } : { ok: true }));
        res.emit("end");
        if (url.pathname === "/api/shutdown") launches[launches.length - 1].child.kill();
      }); return req;
    } }
    : name === "./startup-feedback.cjs" ? { ...require("../electron/startup-feedback.cjs"), mark(_app, stage) { stages.push(stage); }, loginShellPath: async () => "/usr/bin:/bin" }
    : name === "./desktop-updates.cjs" ? { registerUpdates() {} }
    : name === "./deep-link.cjs" ? require("../electron/deep-link.cjs")
    : name === "electron-updater" ? { autoUpdater: {} }
    : name === "./window-state.cjs" ? { options: () => ({ opts: { width: 1440, height: 960 }, maximized: false }), track() {} }
    : require(name);
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  vm.runInNewContext(source, { require: fakeRequire, process: proc, __dirname: "/tmp/electron", setTimeout, clearTimeout, console });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  await settled();
  return { app, windows, launches, menus, handlers, stages, settled };
}

test("macOS keeps native editing roles and offers input context actions", async () => {
  const d = await desktop();
  assert.deepEqual(Array.from(d.app.menu.items, x => x.role), ["appMenu", "editMenu", "windowMenu"]);
  d.windows[0].webContents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: { canPaste: true } });
  assert.ok(d.menus[0].some(x => x.role === "paste" && x.enabled));
  d.app.quit();
});

test("reopening a macOS window reuses one backend, even during repeated activation", async () => {
  const d = await desktop();
  d.windows[0].close();
  d.app.emit("activate"); d.app.emit("activate");
  await d.settled();
  assert.equal(d.launches.length, 1);
  assert.equal(d.windows.length, 2);
  d.app.emit("second-instance");
  assert.equal(d.windows[1].focused, true);
  d.app.quit();
  await d.settled();
  assert.equal(d.launches[0].child.killed, true);
});

test("the detached Ask AI window is allowed, other links go to the system browser, and it closes with the main window", async () => {
  const d = await desktop();
  const opened = [];
  const main = d.windows[0];
  const open = main.webContents.openHandler;
  // 同一個後端的 /read/<id>?chat=1：開成一個小視窗（問 AI 的獨立視窗，見 web/js/reader/chat-link.js）
  const chat = open({ url: "http://127.0.0.1:9876/read/abc123?chat=1" });
  assert.equal(chat.action, "allow");
  assert.ok(chat.overrideBrowserWindowOptions.width <= 520 && chat.overrideBrowserWindowOptions.webPreferences.contextIsolation);
  assert.equal(chat.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  // 沒有 ?chat=1 的閱讀頁、別的來源冒充的，都不開新視窗
  assert.equal(open({ url: "http://127.0.0.1:9876/read/abc123" }).action, "deny");
  assert.equal(open({ url: "http://evil.example/read/abc123?chat=1" }).action, "deny");
  assert.equal(open({ url: "not a url" }).action, "deny");
  assert.equal(JSON.stringify(d.app.external), JSON.stringify(["http://127.0.0.1:9876/read/abc123", "http://evil.example/read/abc123?chat=1"]));  // 交給系統瀏覽器
  // 那個視窗開出來之後：裡面的連結照同樣的規則；主視窗關了它跟著關
  const child = new EventEmitter();
  child.webContents = { setWindowOpenHandler(fn) { child.handler = fn; } };
  child.setMenuBarVisibility = (v) => { child.menuBar = v; };
  child.close = () => { opened.push("closed"); child.emit("closed"); };
  main.webContents.emit("did-create-window", child);
  assert.equal(child.menuBar, false);
  assert.equal(child.handler({ url: "http://127.0.0.1:9876/read/abc123" }).action, "deny");
  main.close();
  assert.deepEqual(opened, ["closed"]);
  d.app.quit();
});

test("a second app instance exits before starting a backend", async () => {
  const d = await desktop("darwin", false);
  assert.equal(d.app.quitCalled, true);
  assert.equal(d.launches.length, 0);
});

test("Windows retains its existing menu behavior", async () => {
  const d = await desktop("win32");
  assert.equal(d.app.menu, null);
  d.app.quit();
});

test("the startup window is visible while the backend is still starting", async () => {
  const d = await desktop("darwin", true, false);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].shown, true);
  assert.match(d.windows[0].url, /^data:text\/html/);
  assert.ok(d.stages.indexOf("startup-window-visible") < d.stages.indexOf("backend-spawn"));
  d.launches[0].child.stdout.emit("data", "EasyRead 已启动：http://127.0.0.1:9876\n");
  await d.settled();
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  assert.ok(d.stages.includes("library-loaded"));
  d.app.quit(); await d.settled();
});

test("login shell discovery yields without blocking and tolerates shell errors", async () => {
  const { loginShellPath } = require("../electron/startup-feedback.cjs");
  let callback;
  const pending = loginShellPath("darwin", "/bin/zsh", (_shell, _args, options, done) => {
    assert.equal(options.timeout, 5000); callback = done;
  });
  assert.ok(pending instanceof Promise);
  callback(null, "noise\n__PATH__/usr/local/bin:/usr/bin__PATH__\n");
  assert.equal(await pending, "/usr/local/bin:/usr/bin");
  assert.equal(await loginShellPath("darwin", "/bin/zsh", (_s, _a, _o, done) => done(new Error("timeout"))), "");
  assert.equal(await loginShellPath("win32", "", () => { throw new Error("unexpected shell"); }), "");
});


test("cloud library IPC restricts folder picking and relaunch to the local main frame", async () => {
  const d = await desktop();
  const sender = d.windows[0].webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal(await d.handlers.get("easyread:pick-folder")(event), "/tmp/chosen");
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender, senderFrame: { url: "https://example.com" } }), /Untrusted/);
  await d.handlers.get("easyread:relaunch")(event);
  assert.equal(d.launches[0].child.killed, true);
  assert.equal(d.app.relaunched, true);
  assert.equal(d.app.exited, true);
});

const SHA = "a".repeat(64);

test("easyread:// links open the paper once the backend is ready", async () => {
  const d = await desktop("win32", true, true, [`easyread://open?sha256=${SHA}&block=p3-2`]);
  await d.settled();
  assert.equal(d.app.protocol, "easyread");
  assert.equal(d.windows[0].url, `http://127.0.0.1:9876/open?sha256=${SHA}&block=p3-2`);
  d.app.quit();
});

test("a link from a second instance reuses the open window", async () => {
  const d = await desktop("win32");
  await d.settled();
  d.app.emit("second-instance", {}, ["EasyRead.exe", "easyread://open?id=abc123def456"]);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876/open?id=abc123def456");
  assert.equal(d.windows[0].focused, true);
  d.app.quit();
});

test("macOS open-url links are handled and unknown links ignored", async () => {
  const d = await desktop();
  await d.settled();
  d.app.emit("open-url", { preventDefault() {} }, "easyread://other?id=abc123def456");
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  d.app.emit("open-url", { preventDefault() {} }, `easyread://open?sha256=${SHA}&block=<x>`);
  assert.equal(d.windows[0].url, `http://127.0.0.1:9876/open?sha256=${SHA}`);
  d.app.quit();
});
