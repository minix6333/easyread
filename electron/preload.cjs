const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true,
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.invoke("easyread:theme", theme),  // "dark" / "light" / 其他＝跟隨系統（視窗材質的明暗）
  pickFolder: () => ipcRenderer.invoke("easyread:pick-folder"),
  relaunch: () => ipcRenderer.invoke("easyread:relaunch"),
  clearEmbedData: () => ipcRenderer.invoke("easyread:embed-clear"),
  // 拖進來的檔案在硬碟上的路徑（拖 App 圖示進右欄時要知道是哪個程式）
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ""; } },
  // 把別的程式的視窗貼齊在右邊（macOS）：status / request / attach {path, width} / detach / settings / pick / icon
  nativeDock: (action, arg) => ipcRenderer.invoke("easyread:native-dock", action, arg),
  onNativeDock: (callback) => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on("easyread:native-dock", listener);
    return () => ipcRenderer.removeListener("easyread:native-dock", listener);
  },
  // ⌘W（關分頁）、⌘⇧T（重開）是主程式選單上的項目：按了送到外殼（web/js/shell.js 的 key）
  onShellKey: (callback) => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on("easyread:shell-key", listener);
    return () => ipcRenderer.removeListener("easyread:shell-key", listener);
  },
  updateState: () => ipcRenderer.invoke("easyread:update-state"),
  downloadUpdate: () => ipcRenderer.invoke("easyread:update-download"),
  installUpdate: () => ipcRenderer.invoke("easyread:update-install"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("easyread:update-state", listener);
    return () => ipcRenderer.removeListener("easyread:update-state", listener);
  },
});
