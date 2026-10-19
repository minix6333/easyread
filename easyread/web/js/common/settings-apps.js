/* 設定 →「外部 AI」：電腦上的 AI App（ChatGPT／Codex、Claude、Cursor、Claude Code）連到 FOLI 之後，回答時讀得到正在看的文件、
   能搜尋文獻庫、把回答存成筆記、請 FOLI 翻頁（後端 mcp_setup.py 改它們的設定，mcp_server.py 是它們連進來的那個伺服器）。
   也說一下右邊外部工具欄裡的 AI 網頁怎麼用（dock-ai.js）。連接、拿掉都是讀者按了才做，做之前說清楚會改哪個檔案。 */
(function (PR) {
  "use strict";
  let busy = "";
  const state = () => PR.settingsState;
  const redraw = () => { if (state().tab === "apps") PR.settingsRender(); };
  const TINT = { codex: "#10a37f", claude: "#d97757", cursor: "#3b3f46", "claude-code": "#c46f4f" };
  // 方塊：品牌色＋一個字母或圖示（不跟系統拿 App 圖示：有時候只拿得到空白的通用圖示，反而認不出來）
  const MARK = { codex: "G", claude: "C", cursor: PR.icon("cursor", "sm"), "claude-code": PR.icon("l-terminal", "sm") };
  const iconOf = (t) => '<i class="ltr" style="--tint:' + (TINT[t.id] || "#6b7280") + '">' + (MARK[t.id] || PR.esc(t.name.charAt(0))) + "</i>";
  async function load(s) {
    if (s.mcpLoading) return;
    s.mcpLoading = true; s.mcpError = "";
    try { s.mcp = await PR.api("/api/mcp"); } catch (e) { s.mcpError = e.message; } finally { s.mcpLoading = false; redraw(); }
  }
  function row(t) {
    const status = t.connected ? PR.t("已連接：關掉 {name} 再打開就能用", { name: t.name }) : t.installed ? PR.t("還沒連接") : PR.t("這台電腦上沒找到");
    const btn = t.connected
      ? '<button class="btn sm line" data-mcp="disconnect" data-id="' + PR.esc(t.id) + '"' + (busy ? " disabled" : "") + ">" + PR.t("拿掉") + "</button>"
      : '<button class="btn sm accent" data-mcp="connect" data-id="' + PR.esc(t.id) + '"' + (busy || !t.installed ? " disabled" : "") + ">" + (busy === t.id ? PR.t("連接中…") : PR.t("連接")) + "</button>";
    return '<div class="ai-app' + (t.installed ? "" : " off") + (t.connected ? " on" : "") + '">' + iconOf(t) +
      '<div class="ai-app-body"><b>' + PR.esc(t.name) + '</b><span title="' + PR.esc(t.path) + '">' + PR.esc(status) + "</span></div>" + btn + "</div>";
  }
  PR.settingsTabs.apps = {
    render(s) {
      if (!s.mcp && !s.mcpLoading && !s.mcpError) load(s);
      const list = (s.mcp && s.mcp.targets) || [];
      return '<div class="apps-settings">' +
        '<p class="set-lead">' + PR.t("連接之後，那個 App 回答時讀得到你正在看的文件（哪一頁、選了什麼字），能搜尋整個文獻庫，也能把回答存成這份文件的筆記、請 FOLI 翻到某一頁。FOLI 沒開也讀得到文獻庫。") + "</p>" +
        (s.mcpError ? '<p class="bad">' + PR.esc(s.mcpError) + "</p>" : "") +
        '<h4 class="set-h">' + PR.t("電腦上的 AI App") + "</h4>" +
        (list.length ? '<div class="ai-apps">' + list.map(row).join("") + "</div>" : '<p class="hint">' + (s.mcpLoading ? PR.t("正在找電腦上的 AI App…") : "") + "</p>") +
        '<h4 class="set-h">' + PR.t("右邊的外部工具欄") + '</h4><ul class="ai-notes"><li>' +
        PR.t("ChatGPT、Claude、Gemini 的網頁版：直接在它的輸入框問就好，送出時會先附上正在讀的這一頁（問「整份」「這篇」時加上整份 PDF）。迴紋針裡可以關掉，也可以自己挑要附什麼；在文件裡選字，選字工具列有「問右邊的…」。") + "</li><li>" +
        PR.t("回答裡的頁碼（第 5 頁、p. 5）點了左邊就翻過去；在回答上選字按右鍵，可以存成這一頁的筆記。") + "</li><li>" +
        PR.t("網頁版連不到這台電腦：只有你在它那邊按了送出，正在讀的那一頁才會跟著傳過去；同一段對話裡已經附過的那一頁不會再傳。") + "</li></ul></div>";
    },
    async click(e, s) {
      const b = e.target.closest("[data-mcp]");
      if (!b || b.disabled || busy) return !!b;
      const t = ((s.mcp && s.mcp.targets) || []).find((x) => x.id === b.dataset.id);
      if (!t) return true;
      const on = b.dataset.mcp === "connect";
      if (on && !(await PR.confirm({ title: PR.t("讓 {name} 連到 FOLI？", { name: t.name }), at: b, ok: PR.t("連接"),
        body: (t.id === "claude-code" ? PR.t("會用 claude 指令在你的使用者設定裡加一個叫 foli 的 MCP 伺服器。") : PR.t("會在 {path} 加一個叫 foli 的 MCP 伺服器，其他設定不動，改之前先備份一份。", { path: t.path })) +
          "\n" + PR.t("改好之後把 {name} 關掉再打開。", { name: t.name }) }))) return true;
      busy = t.id; redraw();
      try {
        s.mcp = await PR.api("/api/mcp", { method: "POST", body: { do: on ? "connect" : "disconnect", id: t.id } });
        PR.toast(on ? PR.t("已連接：關掉 {name} 再打開就能用", { name: t.name }) : PR.t("已拿掉"), null, 3500);
      } catch (err) { PR.toast(PR.esc(err.message), null, 5000); }
      finally { busy = ""; redraw(); }
      return true;
    },
  };
})(window.PR);
