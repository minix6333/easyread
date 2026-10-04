/* 頂欄的深色 / 淺色切換按鈕（文獻庫頁、閱讀頁都有）。點一下在淺色和深色之間切；
   「跟隨系統」在設定 → 介面主題裡選。 */
window.PR = window.PR || {};
(function (PR) {
  "use strict";

  const dark = () => document.documentElement.dataset.theme === "dark";

  function paint(btn) {
    btn.innerHTML = PR.icon(dark() ? "sun" : "moon");
    btn.title = dark() ? PR.t("换成浅色") : PR.t("换成深色");
  }

  PR.toggleTheme = function () {
    const next = dark() ? "light" : "dark";
    if (PR.setPref && PR.prefs) PR.setPref("theme", next);  // 閱讀頁：和 Aa 面板裡的主題是同一個設定
    else {
      const p = PR.ls.get("easyread-prefs", {});
      p.theme = next;
      PR.ls.set("easyread-prefs", p);
      PR.applyTheme(next);
      if (PR.savePrefs) PR.savePrefs("reader", { theme: next });
    }
    PR.$$(".theme-btn").forEach(paint);
  };

  /* 放在頂欄的語言 / 閱讀設定按鈕前面 */
  document.addEventListener("DOMContentLoaded", () => {
    const before = document.querySelector("#langBtn, #bar [data-act='settings']");
    if (!before) return;
    const btn = document.createElement("button");
    btn.className = "btn icon theme-btn";
    btn.onclick = PR.toggleTheme;
    before.parentNode.insertBefore(btn, before);
    paint(btn);
    // 跟隨系統時，系統切換深淺色、或在設定裡改了主題，圖示跟著變
    new MutationObserver(() => paint(btn)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  });
})(window.PR);
