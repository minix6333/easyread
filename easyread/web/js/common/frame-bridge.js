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
    if (framed && u.origin === location.origin && u.pathname.startsWith("/read/")) { post({ type: "open", url: u.pathname + u.search + u.hash }); return true; }
    if (framed && u.origin === location.origin && (u.pathname === "/" || u.pathname === "/library")) { post({ type: "home", url: "/library" + u.search + u.hash }); return true; }
    location.href = url;
    return false;
  };
  if (!framed) return;
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || a.target === "_blank" || a.hasAttribute("download")) return;
    let u;
    try { u = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
    if (u.origin !== location.origin || !(u.pathname.startsWith("/read/") || u.pathname === "/" || u.pathname === "/library")) return;
    e.preventDefault();
    PR.navigate(u.href);
  }, true);
  const sendTitle = () => { if (document.title && document.title !== "EasyRead") post({ type: "title", title: document.title }); };
  const t = document.querySelector("title");
  if (t) new MutationObserver(sendTitle).observe(t, { childList: true, characterData: true, subtree: true });
  window.addEventListener("load", sendTitle);
  sendTitle();
  // 在這一格裡切了淺色／深色：外殼和其他格跟著換
  const sendTheme = () => post({ type: "theme", theme: document.documentElement.dataset.theme || "" });
  new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
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
    if (/^[1-9]$/.test(e.key) || e.key === "\\" || (e.shiftKey && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}"))) { e.preventDefault(); post({ type: "key", key: e.key, shift: e.shiftKey }); }
  });
})(window.PR);
