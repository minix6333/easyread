/* 告訴後端「讀者現在在看哪一份、第幾頁、選了什麼字」：電腦上的 AI App（Claude、ChatGPT／Codex…）透過 MCP 問的就是這個
   （mcp_server.py 的 current）。只有這一格是外殼裡被選著的那一格、頁面看得到的時候才報；有變才送，最多一秒半一次。
   後端只放在記憶體裡（重開就沒了），不存檔、不同步。問 AI 的獨立視窗、筆記的獨立視窗不報。 */
(function (PR) {
  "use strict";
  let last = "", busy = false;
  function mine() {
    if (document.visibilityState !== "visible" || PR.chatOnly || PR.notesOnly) return false;
    if (!PR.framed) return true;
    try { const t = window.parent.PR.shell.tabs().find((x) => x.on); return !!t && t.doc === PR.pid; } catch (e) { return true; }
  }
  function report() {
    if (busy || !PR.pid || !PR.token || !PR.state || !PR.state.paper || !(PR.store && PR.store.mode === "server") || !mine()) return;
    const meta = PR.state.paper.meta || {};
    const page = PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : ((PR.blockById || {})[PR.readingBlock && PR.readingBlock()] || {}).page || 1;
    let sel = "";
    try { sel = String(getSelection() || "").trim().slice(0, 4000); } catch (e) { sel = ""; }
    const body = { id: PR.pid, page, pages: (meta.pages || []).length, sel, title: meta.title_en || meta.title_zh || document.title || "" };
    const sig = JSON.stringify(body);
    if (sig === last) return;
    last = sig;
    busy = true;
    PR.api("/api/focus", { method: "POST", body }).catch(() => { last = ""; }).finally(() => { busy = false; });
  }
  setInterval(report, 1500);
  window.addEventListener("focus", () => setTimeout(report, 50));
  document.addEventListener("selectionchange", PR.debounce(report, 500));
})(window.PR);
