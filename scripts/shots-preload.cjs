// scripts/shots.cjs 的 --desktop 和 scripts/theme_loop_check.cjs 用：假裝是桌面版（window.easyreadDesktop），外部工具欄才會用真的 <webview>。
// 只給最少的幾樣，其他功能不接。setTheme 照真的那樣送給主程序；主程序沒接（shots.cjs）就當沒事。
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true, platform: process.platform,
  setTheme: (theme) => ipcRenderer.invoke("easyread:theme", theme).catch(() => null),
});
