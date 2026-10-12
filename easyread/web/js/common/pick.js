/* 圖示＋顏色的挑選器（資料夾和筆記的圖示用，像 Craft 的資料夾圖示），和它們共用的那組顏色。
   圖示是 icons-extra.js 裡「l-」開頭的那一批（scripts/gen_icons.cjs 從 Lucide 產生），存的是不帶前綴的名字；
   顏色存的是名字（gray、red…），真正的色值是 CSS 變數 --nc-<名字>（craft.css，亮暗各一組）。
   PR.tintIcon(icon, color, fallback)：一顆帶顏色的圖示的 HTML。
   PR.pickIcon(anchor, { icon, color, onChange({icon, color}) })：開挑選器，點了就改（不用按確定）。 */
(function (PR) {
  "use strict";
  PR.TINTS = [["", PR.t("不上色")], ["gray", PR.t("灰")], ["red", PR.t("红")], ["orange", PR.t("橙")], ["yellow", PR.t("黄")], ["green", PR.t("绿")],
    ["teal", PR.t("青")], ["blue", PR.t("蓝")], ["purple", PR.t("紫")], ["pink", PR.t("粉")], ["brown", PR.t("棕")]];
  const GROUP = () => ({ study: PR.t("學習"), research: PR.t("研究"), computer: PR.t("電腦"), ideas: PR.t("點子"), life: PR.t("生活"), work: PR.t("工作"), nature: PR.t("自然") });
  const okTint = (c) => (PR.TINTS.some(([k]) => k === c) ? c : "");
  const okIcon = (i) => (i && PR.hasIcon("l-" + i) ? i : "");
  PR.tintIcon = function (icon, color, fallback, cls) {
    const name = okIcon(icon) ? "l-" + icon : fallback || "doc";
    return '<span class="ti' + (cls ? " " + cls : "") + '"' + (okTint(color) ? ' data-c="' + okTint(color) + '"' : "") + ">" + PR.icon(name, "sm") + "</span>";
  };

  let pop = null, cur = null;
  function close() { if (pop) pop.classList.remove("open"); cur = null; }
  PR.closePick = close;
  function paint() {
    const groups = GROUP();
    pop.innerHTML = '<div class="pick-dots">' + PR.TINTS.map(([c, name]) => '<button type="button" data-c="' + c + '" class="' + (c ? "" : "none") + (cur.color === c ? " on" : "") + '" title="' + PR.esc(name) + '"></button>').join("") + "</div>" +
      '<div class="pick-grid"' + (cur.color ? ' data-c="' + cur.color + '"' : "") + ">" + (PR.PICK_ICONS || []).map(([g, names]) => '<div class="pick-g">' + PR.esc(groups[g] || g) + "</div>" +
        names.map((n) => '<button type="button" data-i="' + n + '" class="' + (cur.icon === n ? "on" : "") + '">' + PR.icon("l-" + n, "sm") + "</button>").join("")).join("") + "</div>" +
      '<div class="pick-foot"><button type="button" class="btn sm" data-none' + (cur.icon ? "" : " disabled") + ">" + PR.t("用預設圖示") + "</button></div>";
  }
  PR.pickIcon = function (anchor, o) {
    if (!pop) {
      pop = PR.el("div", { id: "pickPop", class: "popover pick" });
      document.body.appendChild(pop);
      pop.addEventListener("mousedown", (e) => e.preventDefault());
      pop.addEventListener("click", (e) => {
        if (!cur) return;
        const c = e.target.closest(".pick-dots [data-c]"), i = e.target.closest("[data-i]"), none = e.target.closest("[data-none]");
        if (!c && !i && !none) return;
        if (c) cur.color = c.dataset.c;
        if (i) cur.icon = i.dataset.i;
        if (none) cur.icon = "";
        const keep = pop.querySelector(".pick-grid").scrollTop;
        paint();
        pop.querySelector(".pick-grid").scrollTop = keep;
        cur.onChange({ icon: cur.icon, color: cur.color });
      });
      document.addEventListener("mousedown", (e) => { if (cur && !e.target.closest("#pickPop")) close(); });
      document.addEventListener("keydown", (e) => { if (cur && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }, true);
    }
    cur = { icon: okIcon(o.icon), color: okTint(o.color), onChange: o.onChange || (() => {}) };
    paint();
    pop.classList.add("open");
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
    pop.style.top = y + "px";
    if (PR.growFrom) PR.growFrom(pop, r);
    const on = pop.querySelector(".pick-grid .on");
    if (on) on.scrollIntoView({ block: "center" });
  };
})(window.PR);
