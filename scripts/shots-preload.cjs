// scripts/shots.cjs 的 --desktop 用：假裝是桌面版（window.easyreadDesktop），外部工具欄才會用真的 <webview>。只給最少的幾樣，其他功能不接。
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("easyreadDesktop", { isElectron: true, platform: process.platform, setTheme: () => Promise.resolve() });
