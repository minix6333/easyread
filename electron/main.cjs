const { app, BrowserWindow, dialog, Menu, shell, ipcMain, session } = require("electron");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const windowState = require("./window-state.cjs");
const { URL } = require("url");
const http = require("http");
const startup = require("./startup-feedback.cjs");
const { registerUpdates } = require("./desktop-updates.cjs");
const deepLink = require("./deep-link.cjs");
const { createNativeDock } = require("./native-dock.cjs");

// 視窗快取等放 %APPDATA%\EasyRead（預設會用 package.json 的 name，叫 easyread-desktop）。
// 論文和設定不放這裡：打包後的後端預設用 ~/EasyRead，和 pip 安裝版同一個位置，使用者找得到、好備份。
// EASYREAD_USER_DATA：開發、測試時另外指定（才能和正在用的那一份同時開，不搶同一把鎖）
app.setPath("userData", process.env.EASYREAD_USER_DATA || path.join(app.getPath("appData"), "EasyRead"));
startup.mark(app, "electron-entry");

// 桌面版自己的幾句報錯跟系統語言走（介面語言由後端決定，見 easyread/i18n.py）
const isZh = () => app.getLocale().toLowerCase().startsWith("zh");
let backend;
let mainWindow;
let backendReady;
let windowOpening = false;
let backendUrl;
let quitting = false;
let pendingOpen = deepLink.fromArgv(process.argv);
// 後端固定先試這個連接埠（被占用時後端自己換一個空的）。網址每次都一樣，頁面存在瀏覽器裡的東西
// （開著哪些分頁、怎麼分割、右邊嵌了哪些外部工具）下次開 App 才還在；以前每次隨機一個埠，等於每次都是新的網站。
const DESKTOP_PORT = "47865";
// 右邊嵌的外部網頁（ChatGPT 之類，見 web/js/dock.js）用的獨立儲存區：登入狀態留在這裡，和 EasyRead 自己的頁面分開
const EMBED_PARTITION = "persist:embed";

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function packagedBackend() {
  const name = process.platform === "win32" ? "easyread-backend.exe" : "easyread-backend";
  // PyInstaller 目錄版：resources/backend/easyread-backend/easyread-backend（啟動不用解壓）；舊的單檔版放在 resources/backend/ 下
  const dir = path.join(process.resourcesPath, "backend", "easyread-backend", name);
  return fs.existsSync(dir) ? dir : path.join(process.resourcesPath, "backend", name);
}

function backendCommand() {
  if (app.isPackaged) {
    const executable = packagedBackend();
    if (!fs.existsSync(executable)) {
      throw new Error(isZh() ? `找不到打包後的 EasyRead 後端：${executable}` : `Bundled EasyRead backend not found: ${executable}`);
    }
    return { command: executable, args: ["serve", "--port", DESKTOP_PORT], cwd: os.homedir() };
  }

  const root = projectRoot();
  const python = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  const command = fs.existsSync(python) ? python : (process.platform === "win32" ? "python" : "python3");
  return { command, args: ["-m", "easyread", "serve", "--port", process.env.EASYREAD_DESKTOP_PORT || DESKTOP_PORT], cwd: root };
}

// macOS / Linux 從啟動台、桌面圖示開啟時，拿不到終端裡配的 PATH（Homebrew、npm 全域性目錄），
// 後端會找不到 claude / codex。向使用者的登入 shell 要一份 PATH 補上。
function startBackend() {
  // On macOS an app can stay alive after its last window closes. Reopening
  // the window must reuse that backend, rather than orphaning the old one.
  if (backendReady) return backendReady;
  backendReady = (async () => {
  const launch = backendCommand();
  const env = { ...process.env, PYTHONUTF8: "1", EASYREAD_SYSTEM_LANG: app.getLocale() };  // 後端按它決定介面語言
  startup.mark(app, "shell-path-start");
  const shellPath = await startup.loginShellPath(process.platform);
  startup.mark(app, "shell-path-ready");
  if (quitting) throw new Error(isZh() ? "啟動已取消" : "Startup cancelled");
  if (shellPath) {
    env.PATH = [...new Set([...shellPath.split(":"), ...(env.PATH || "").split(":")].filter(Boolean))].join(":");
  }
  if (process.platform !== "win32") {
    const fallback = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    env.PATH = [...new Set([...(env.PATH || "").split(":"), ...fallback.filter(p => fs.existsSync(p))].filter(Boolean))].join(":");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error((isZh() ? "EasyRead 後端啟動超時。" : "EasyRead backend timed out while starting. ") + output.slice(-500)));
      stopBackend();
    }, 30000);

    startup.mark(app, "backend-spawn");
    backend = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
      const match = output.match(/EasyRead\s+已启动：\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) { startup.mark(app, "backend-http-ready"); backendUrl = match[1]; finish(resolve, match[1]); }
    });
    backend.stderr.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
    });
    backend.once("error", (error) => finish(reject, error));
    backend.once("exit", (code, signal) => {
      if (!settled) finish(reject, new Error((isZh() ? `EasyRead 後端退出（code=${code}, signal=${signal}）。` : `EasyRead backend exited (code=${code}, signal=${signal}). `) + output.slice(-500)));
      backend = undefined;
      backendReady = undefined;
      backendUrl = undefined;
    });
  });
  })();
  backendReady.catch(() => { backendReady = undefined; });
  return backendReady;
}

function backendJson(endpoint, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(endpoint, backendUrl), {
      method: token ? "POST" : "GET",
      headers: token ? { "X-Token": token, "Content-Type": "application/json", "Content-Length": 2 } : {},
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", part => { body += part; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) return reject(new Error(data.error || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(isZh() ? "後端關閉超時，請稍後重試" : "Backend shutdown timed out. Try again later.")));
    req.on("error", reject);
    req.end(token ? "{}" : undefined);
  });
}

async function stopBackendGracefully() {
  const child = backend;
  if (!child) return;
  const info = await backendJson("/api/library");
  await backendJson("/api/shutdown", info.token);
  // 後端清掉佔用標記、關閉 HTTP 服務後才啟動新程序。
  if (backend !== child) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("exit", exited); reject(new Error(isZh() ? "後端尚未退出，請稍後重試" : "The backend has not exited yet. Try again later.")); }, 8000);
    function exited() { clearTimeout(timer); resolve(); }
    child.once("exit", exited);
  });
}

function trustedWindow(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      !backendUrl || new URL(event.senderFrame.url).origin !== backendUrl) {
    throw new Error("Untrusted IPC sender");
  }
}

ipcMain.handle("easyread:pick-folder", async event => {
  trustedWindow(event);
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] || null;
});
ipcMain.handle("easyread:relaunch", async event => {
  trustedWindow(event);
  await stopBackendGracefully();
  app.relaunch();
  app.exit(0);
});

function stopBackend() {
  backendReady = undefined;
  if (backend && !backend.killed) {
    if (process.platform === "win32") {
      // PyInstaller's one-file launcher creates a child process. Killing only
      // the launcher would leave the local HTTP service running after exit.
      try {
        execFileSync("taskkill", ["/pid", String(backend.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch (_) {
        // The process may already have exited while the window was closing.
      }
    } else {
      backend.kill();
    }
    backend = undefined;
  }
}

// 視窗還在啟動時先記下，後端就緒後 createWindow 直接開啟這篇
function openLink(target) {
  if (!target) return;
  if (!mainWindow || windowOpening || !backendUrl) {
    pendingOpen = target;
    if (!mainWindow && app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const href = new URL(target, backendUrl).href;
  // 外殼已經開著：請它開成一個分頁，別整個視窗重載（其他分頁都還在）
  let onShell = false;
  try { const cur = new URL(mainWindow.webContents.getURL()); onShell = cur.origin === new URL(backendUrl).origin && cur.pathname === "/"; } catch (_) { onShell = false; }
  if (onShell) mainWindow.webContents.executeJavaScript(`!!(window.easyreadOpen && (window.easyreadOpen(${JSON.stringify(href)}), true))`).then((ok) => { if (!ok) mainWindow.loadURL(href); }).catch(() => mainWindow.loadURL(href));
  else mainWindow.loadURL(href);
}

// 頁面要開新視窗：問 AI 的獨立視窗（同一個後端的 /read/<id>?chat=1）讓它開成一個小視窗；其餘 http(s) 連結交給系統瀏覽器
const chatWindows = new Set();
function windowOpenHandler({ url: target }) {
  try {
    const u = new URL(target);
    if (backendUrl && u.origin === new URL(backendUrl).origin && u.pathname.startsWith("/read/") && u.searchParams.get("chat") === "1") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480, height: 800, minWidth: 360, minHeight: 420, autoHideMenuBar: true,
          icon: path.join(__dirname, "assets", "icon.ico"),
          webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") },
        },
      };
    }
  } catch (_) { /* 不是網址：照下面的處理 */ }
  if (/^https?:/i.test(target)) shell.openExternal(target);
  return { action: "deny" };
}

// ---------- 右邊嵌的外部網頁 ----------
// 它只是「放在那裡」：拿不到 EasyRead 的任何東西——沒有 preload、沒有 Node、獨立的儲存區、連不到本機的後端。
function guardWebview(event, webPreferences, params) {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  params.partition = EMBED_PARTITION;
  if (!/^https?:\/\//i.test(params.src || "") || isLoopback(params.src)) event.preventDefault();
}
function isLoopback(target) {
  try { return ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(new URL(target).hostname); } catch (_) { return false; }
}
// 嵌的網頁要開新視窗：登入用的小彈窗（有指定大小的）讓它開，用同一個儲存區；一般的「在新分頁開啟」交給系統瀏覽器
function embedOpenHandler({ url: target, disposition }) {
  if (!/^https?:\/\//i.test(target) || isLoopback(target)) return { action: "deny" };
  if (disposition === "new-window") {
    return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: EMBED_PARTITION } } };
  }
  shell.openExternal(target);
  return { action: "deny" };
}
function setupEmbedSession() {
  const ses = session.fromPartition(EMBED_PARTITION);
  // 有些網站（Google 登入）看到 Electron 字樣就不給用：報成一般的 Chrome
  ses.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|EasyRead|easyread[\w-]*)\/\S+/gi, ""));
  // 權限：只給剪貼簿和全螢幕；麥克風、鏡頭、通知、定位一律不給
  const ok = new Set(["clipboard-sanitized-write", "clipboard-read", "fullscreen"]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ok.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ok.has(permission));
  // 嵌的網頁碰不到本機的 EasyRead 後端（也碰不到這台電腦上其他只聽本機的服務）
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: isLoopback(details.url) }));
}
app.on("web-contents-created", (_event, contents) => {
  const type = contents.getType();
  const embedded = type === "webview" || (contents.session && contents.session === session.fromPartition(EMBED_PARTITION));
  if (!embedded) return;
  contents.setWindowOpenHandler(embedOpenHandler);
  contents.on("will-navigate", (event, target) => { if (!/^https?:\/\//i.test(target) || isLoopback(target)) event.preventDefault(); });
  contents.on("context-menu", (_e, params) => {
    const flags = params.editFlags || {};
    const items = params.isEditable
      ? [{ role: "undo", enabled: flags.canUndo }, { role: "redo", enabled: flags.canRedo }, { type: "separator" },
         { role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy }, { role: "paste", enabled: flags.canPaste }, { type: "separator" }, { role: "selectAll" }]
      : (params.selectionText || "").trim() ? [{ role: "copy" }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
});
// 清掉嵌的網頁存的東西（登入狀態、快取）：面板選單裡的「登出並清除資料」
// ---------- 把別的程式的視窗貼齊在右邊（macOS，見 native-dock.cjs） ----------
const MIN_WINDOW = [960, 680];
const nativeDock = createNativeDock({
  platform: process.platform,
  helperPath: app.isPackaged ? path.join(process.resourcesPath, "native", "easyread-winhelper") : path.join(projectRoot(), "build", "native", "easyread-winhelper"),
  getWindow: () => mainWindow,
  minSize: MIN_WINDOW,
  dry: process.env.EASYREAD_WINHELPER_DRY === "1",
  notify: (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("easyread:native-dock", msg); },
});
ipcMain.handle("easyread:native-dock", async (event, action, arg) => {
  trustedWindow(event);
  if (action === "status") return nativeDock.status();
  if (action === "request") return nativeDock.request();
  if (action === "attach") return nativeDock.attach(String((arg && arg.path) || ""), arg && arg.width);
  if (action === "detach") return nativeDock.detach();
  if (action === "settings") {  // 系統設定 → 隱私權與安全性 → 輔助使用
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    return true;
  }
  if (action === "pick") {
    const r = await dialog.showOpenDialog(mainWindow, { defaultPath: "/Applications", properties: ["openFile"], filters: [{ name: "Applications", extensions: ["app"] }] });
    return r.canceled ? null : r.filePaths[0] || null;
  }
  if (action === "icon") {  // 那個程式的圖示（放在右欄上面那一排）
    try { return (await app.getFileIcon(String(arg || ""), { size: "normal" })).resize({ width: 36, height: 36 }).toDataURL(); } catch (_) { return ""; }
  }
  return null;
});

ipcMain.handle("easyread:embed-clear", async event => {
  trustedWindow(event);
  const ses = session.fromPartition(EMBED_PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
});

async function createWindow() {
  if (windowOpening || mainWindow) return;
  windowOpening = true;
  const state = windowState.options();
  mainWindow = new BrowserWindow({
    ...state.opts,
    minWidth: MIN_WINDOW[0],
    minHeight: MIN_WINDOW[1],
    icon: path.join(__dirname, "assets", "icon.ico"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,  // 右邊嵌外部網頁用（只有外殼那一頁會建；掛上去之前 will-attach-webview 會把設定收緊）
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(windowOpenHandler);
  mainWindow.webContents.on("will-attach-webview", guardWebview);
  // 問 AI 的獨立視窗：沒有選單列；它裡面的連結照主視窗的規則開；主視窗關了它跟著關
  mainWindow.webContents.on("did-create-window", (child) => {
    child.setMenuBarVisibility(false);
    child.webContents.setWindowOpenHandler(windowOpenHandler);
    chatWindows.add(child);
    child.on("closed", () => chatWindows.delete(child));
  });
  // A native context menu is separate from the application Edit menu.
  // Electron does not emit this event when the page prevents contextmenu,
  // so the library's and reader's custom menus keep working.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags || {};
    const items = params.isEditable
      ? [{ role: "undo", enabled: flags.canUndo }, { role: "redo", enabled: flags.canRedo },
         { type: "separator" }, { role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy },
         { role: "paste", enabled: flags.canPaste }, { type: "separator" }, { role: "selectAll" }]
      : params.selectionText.trim() ? [{ role: "copy" }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  mainWindow.on("close", () => nativeDock.restoreNow());  // 貼著別的視窗時主視窗是窄的：先變回來，下一行才會記到原來的大小
  windowState.track(mainWindow);
  const openingWindow = mainWindow;
  mainWindow.once("ready-to-show", () => {
    if (mainWindow !== openingWindow) return;
    if (state.maximized) openingWindow.maximize();
    openingWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    for (const w of Array.from(chatWindows)) { try { w.close(); } catch (_) { /* 已經關了 */ } }
  });
  try {
    await openingWindow.loadURL(startup.loadingUrl(isZh()));
    if (mainWindow !== openingWindow || quitting) return;
    if (state.maximized) openingWindow.maximize();
    openingWindow.show();
    startup.mark(app, "startup-window-visible");
    const url = await startBackend();
    if (mainWindow !== openingWindow || quitting) return;
    const first = pendingOpen ? new URL(pendingOpen, url).href : url;
    pendingOpen = undefined;
    await openingWindow.loadURL(first);
    startup.mark(app, "library-loaded");
  } catch (error) {
    if (mainWindow !== openingWindow || quitting) return;
    startup.mark(app, "startup-failed");
    dialog.showErrorBox(isZh() ? "EasyRead 啟動失敗" : "EasyRead failed to start", error.message);
    app.quit();
  } finally {
    windowOpening = false;
    // 載入文獻庫期間又點了 easyread:// 連結，openLink 只記下了它，這裡補開
    if (pendingOpen && mainWindow === openingWindow && !quitting) openLink(pendingOpen);
  }
}

// Keep the web application's own header at the top of the content area. The
// default Electron File/Edit/View/Window strip would otherwise create a second
// toolbar row above it. The macOS menu is at the top of the screen and
// its Edit roles provide Cmd+C/V/X/A/Z.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  // macOS 用 open-url 傳連結，可能早於 ready
  app.on("open-url", (event, link) => {
    event.preventDefault();
    openLink(deepLink.openPath(link));
  });
  app.whenReady().then(() => {
    setupEmbedSession();
    deepLink.register(app, process);
    registerUpdates({
      app, ipcMain, updater: require("electron-updater").autoUpdater, trustedWindow,
      getWindow: () => mainWindow,
      prepareInstall: stopBackendGracefully,
      recover: async () => {
        if (backend) return;  // 後端沒停（正在翻譯、拒絕關閉）：頁面別重新整理，彈窗留著顯示原因
        const url = await startBackend();
        if (mainWindow) await mainWindow.loadURL(url);
      },
    });
    return createWindow();
  });
  app.on("before-quit", event => {
    nativeDock.restoreNow();
    nativeDock.dispose();
    if (quitting) return;
    quitting = true;
    if (!backend) return;
    event.preventDefault();
    stopBackendGracefully().catch(stopBackend).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("second-instance", (_event, argv) => {
    const target = deepLink.fromArgv(argv);
    if (target) return void openLink(target);
    if (!mainWindow) return void createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  process.on("exit", stopBackend);
}
