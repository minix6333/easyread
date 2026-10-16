/* 文獻庫側欄的「複習」：整個文獻庫有複習卡時才出現，數字是今天到期幾張；點了把所有到期的卡拿出來複習一輪（common/review.js）。
   卡片在閱讀頁做（筆記面板的「複習卡」，reader/cards.js）；這裡只是跨文件一起複習的入口。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  let info = null, busy = false;
  L.loadCards = function () {
    return PR.api("/api/cards").then((d) => {
      const changed = !info || info.cards !== d.cards || info.due !== d.due;
      info = d;
      if (changed && PR.renderSide) PR.renderSide();
    }, () => {});
  };
  L.sideReviewHtml = function () {
    if (!info || !info.cards) return "";
    return '<div class="sgroup side-review"><button class="srow" data-review title="' + PR.esc(PR.t("把到期的複習卡拿出來考自己（{n} 張卡）", { n: info.cards })) + '">' + PR.icon("l-brain", "sm") +
      '<span class="t">' + PR.t("複習") + '</span><span class="n' + (info.due ? " due" : "") + '">' + (info.due || "") + "</span></button></div>";
  };
  PR.$("#side").addEventListener("click", async (e) => {
    if (!e.target.closest("[data-review]") || busy) return;
    busy = true;
    try {
      const d = await PR.api("/api/cards/queue");
      if (!(d.cards || []).length) PR.toast(PR.t("今天沒有到期的卡"));
      else PR.review.open(d.cards, { title: PR.t("複習"), onDone: L.loadCards });
    } catch (err) { PR.toast(PR.esc(err.message)); }
    busy = false;
  });
  // 在閱讀頁複習、做了卡回來：數字跟上
  window.addEventListener("focus", () => L.loadCards());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) L.loadCards(); });
  L.loadCards();
})(window.PR);
