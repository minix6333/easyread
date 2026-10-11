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
    PR.setTheme(dark() ? "light" : "dark");  // 寫進共用的那一份、存檔、套用都在 util.js 的 PR.setTheme
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
