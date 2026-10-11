/* 筆記面板拉成獨立視窗：同一頁加上 ?notes=1 只畫筆記面板。在那個視窗裡點出處卡、標記要跳到文件某處，
   請主視窗跳（BroadcastChannel，和 chat-link.js 共用同一條頻道）；筆記本身走伺服器同步，兩邊各自輪詢。 */
(function (PR) {
  "use strict";
  const only = /[?&]notes=1(&|$)/.test(location.search);
  PR.notesOnly = only;
  if (only) document.documentElement.classList.add("notes-only");
  const chan = typeof BroadcastChannel !== "undefined" && PR.pid ? new BroadcastChannel("easyread-chat-" + PR.pid) : null;
  const post = (msg) => { if (chan) chan.postMessage(msg); };
  PR.notesPopout = function () {
    if (only) return;
    const w = 520, h = Math.min(860, Math.max(560, (window.screen && screen.availHeight) || 800) - 80);
    const left = Math.max(0, ((window.screen && screen.availWidth) || 1440) - w - 24);
    const win = window.open("/read/" + encodeURIComponent(PR.pid) + "?notes=1", "easyread-notes-" + PR.pid, "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=60");
    if (!win) return PR.toast(PR.t("視窗沒開成（被瀏覽器擋下來了）"));
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.toggleNotesPanel(false);
  };
  if (!only) return;
  // 獨立視窗裡：所有「跳到文件某處」都轉給主視窗
  const go = (msg) => { post(Object.assign({ type: "go" }, msg)); };
  PR.goToNote = (id) => go({ note: id });
  PR.goToPage = (n) => go({ page: n });
  PR.openPage = (n) => go({ page: n });
  PR.goToAnchor = (a) => go({ anchor: a });
  PR.jumpTo = (id) => go({ anchor: String(id).replace(/^b-/, "") });
  window.addEventListener("pagehide", () => post({ type: "changed" }));
})(window.PR);
