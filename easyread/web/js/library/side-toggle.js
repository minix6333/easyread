/* 文獻庫的側欄開合（頂欄最左邊的按鈕）：寬視窗是把欄收進去（記住）；窄視窗（沒地方放欄）是從左邊滑出來蓋在內容上，點外面或選了一列就收回。 */
(function (PR) {
  "use strict";
  const btn = PR.$("#sideBtn");
  if (!btn) return;
  btn.innerHTML = PR.icon("sidebar");
  btn.title = PR.t("側欄");
  const narrow = matchMedia("(max-width: 1099px)");
  const scrim = PR.el("div", { class: "side-scrim" });
  document.body.append(scrim);
  const KEY = "easyread-side-collapsed";
  const drawer = () => document.body.classList.contains("side-drawer");
  function apply() {
    document.body.classList.toggle("side-collapsed", !narrow.matches && !!PR.ls.get(KEY, false));
    btn.classList.toggle("on", narrow.matches && drawer());
  }
  btn.onclick = () => {
    if (narrow.matches) document.body.classList.toggle("side-drawer");
    else PR.ls.set(KEY, !PR.ls.get(KEY, false));
    apply();
  };
  scrim.onclick = () => { document.body.classList.remove("side-drawer"); apply(); };
  narrow.addEventListener("change", () => { document.body.classList.remove("side-drawer"); apply(); });
  PR.$("#side").addEventListener("click", (e) => {
    if (!narrow.matches || !drawer()) return;
    const row = e.target.closest(".srow, a.recent");
    if (row && !e.target.closest(".h-add, .more, [data-add], [data-newnote], .side-input, .toggle-more")) { document.body.classList.remove("side-drawer"); apply(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer()) { document.body.classList.remove("side-drawer"); apply(); } });
  apply();
})(window.PR);
