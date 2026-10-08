const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true,
  platform: process.platform,
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
  updateState: () => ipcRenderer.invoke("easyread:update-state"),
  downloadUpdate: () => ipcRenderer.invoke("easyread:update-download"),
  installUpdate: () => ipcRenderer.invoke("easyread:update-install"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("easyread:update-state", listener);
    return () => ipcRenderer.removeListener("easyread:update-state", listener);
  },
});
