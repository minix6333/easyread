/* 被外殼（shell.html）框在裡面時：連到別份文件、回文獻庫的連結交給外殼開分頁，不在這個框裡跳走；
   標題改了、被點到了、按了切分頁的快捷鍵也告訴外殼。沒被框住（直接開 /read/… 或 /library）就什麼都不做。 */
(function (PR) {
  "use strict";
  let framed = false;
  try { framed = window.parent !== window && window.parent.location.origin === location.origin && !!window.parent.document.getElementById("panes"); } catch (e) { framed = false; }
  PR.framed = framed;
  const post = (msg) => window.parent.postMessage(Object.assign({ easyread: true }, msg), location.origin);
  /* 到某個網址：被框住就請外殼開分頁，不然照常跳轉 */
  PR.navigate = function (url) {
    const u = new URL(url, location.href);
    if (framed && u.origin === location.origin && /^\/(read|note)\//.test(u.pathname)) { post({ type: "open", url: u.pathname + u.search + u.hash }); return true; }
    if (framed && u.origin === location.origin && (u.pathname === "/" || u.pathname === "/library")) { post({ type: "home", url: "/library" + u.search + u.hash }); return true; }
    location.href = url;
    return false;
  };
  /* 筆記的清單變了（改名、換圖示、建副本、刪掉）：請外殼叫文獻庫那一格重新取。closeSelf：把自己這個分頁關掉、回文獻庫 */
  PR.notesChanged = function (closeSelf) {
    if (framed) post({ type: closeSelf ? "close-self" : "notes-changed" });
    else if (closeSelf) location.href = "/library";
  };
  /* 這一格的文件已經不在文獻庫裡了（開了才發現、或開著的時候被刪）：請外殼把這個分頁收掉、說一聲。沒被框住就什麼都不做（回傳 false，頁面自己顯示） */
  PR.docMissing = function () {
    if (framed) post({ type: "missing" });
    return framed;
  };
  if (!framed) return;
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || a.target === "_blank" || a.hasAttribute("download")) return;
    if (e.target.closest("[data-more]")) return;  // 連結裡的「⋯」是開選單，不是開那份文件（這個監聽在捕獲階段，比列上自己的處理早）
    let u;
    try { u = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
    if (u.origin !== location.origin || !(/^\/(read|note)\//.test(u.pathname) || u.pathname === "/" || u.pathname === "/library")) return;
    e.preventDefault();
    PR.navigate(u.href);
  }, true);
  const sendTitle = () => { if (document.title && document.title !== "EasyRead") post({ type: "title", title: document.title }); };
  const t = document.querySelector("title");
  if (t) new MutationObserver(sendTitle).observe(t, { childList: true, characterData: true, subtree: true });
  window.addEventListener("load", sendTitle);
  sendTitle();
  // 拖著網址、連結經過這一格：告訴外殼（它會在視窗右緣亮出「嵌在右邊」的地方，見 dock.js）。拖檔案不算——那是匯入 PDF、貼圖
  let dragAt = 0;
  document.addEventListener("dragover", (e) => {
    const t = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
    if (!t.includes("text/uri-list") || t.includes("Files") || Date.now() - dragAt < 150) return;
    dragAt = Date.now();
    post({ type: "drag-link" });
  }, true);
  document.addEventListener("mousedown", () => post({ type: "focus" }), true);
  window.addEventListener("focus", () => post({ type: "focus" }));
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const low = e.key.toLowerCase();
    // ⌘W 關分頁、⌘⇧T 重開、⌘T／⌘K 快速開啟。⌘K 在筆記的編輯框裡是「插入連結」（那邊先處理、已經 preventDefault）：這裡就不搶
    // Mac 上要的是 ⌘（⌃W、⌃K、⌃T 是文字框裡刪字、對調的老快捷鍵，不能搶）；其他系統是 Ctrl。⌃Tab 兩邊都是下一個分頁
    const cmd = /Mac|iPhone|iPad/.test(navigator.platform || "") ? e.metaKey && !e.ctrlKey : e.ctrlKey;
    const shellKey = (cmd && ((low === "w" && !e.shiftKey) || low === "t" || (low === "k" && !e.shiftKey && !e.defaultPrevented))) || (low === "tab" && e.ctrlKey && !e.metaKey);
    if (/^[1-9]$/.test(e.key) || e.key === "\\" || (e.shiftKey && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) || shellKey) { e.preventDefault(); post({ type: "key", key: e.key, shift: e.shiftKey }); }
  });
})(window.PR);
