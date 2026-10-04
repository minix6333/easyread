/* 頂欄的 中 / EN 切換按鈕：中文介面顯示 EN，英文介面顯示「中」，點一下換成另一種並重新整理。
   中文一律切到繁體；簡體介面和「跟隨系統」在設定 → 閱讀 → 介面語言裡選。離線單檔版沒有服務存設定，不顯示。 */
(function (PR) {
  "use strict";
  const btn = PR.$("#langBtn");
  if (!btn) return;
  if (location.protocol === "file:") { btn.hidden = true; return; }
  btn.textContent = PR.lang === "en" ? "中" : "EN";  // i18n-ok 按鈕上寫的是要切換到的語言
  btn.title = PR.lang === "en" ? PR.t("切換到中文介面") : PR.t("切换到英文界面");
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await PR.api("/api/prefs", { method: "POST", body: { ui: { lang: PR.lang === "en" ? "zh-TW" : "en" } } });
      try { if (PR.lib && PR.lib.lastData) sessionStorage.setItem("easyread-lib-snap", JSON.stringify({ t: Date.now(), d: PR.lib.lastData })); } catch (e) { /* 存不下就普通重新整理 */ }
      location.replace(location.href.split("#")[0]);  // 不用 reload：普通跳轉才有淡入淡出（library.css 的 @view-transition）
    } catch (e) {
      btn.disabled = false;
      PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) }));
    }
  };
})(window.PR);
