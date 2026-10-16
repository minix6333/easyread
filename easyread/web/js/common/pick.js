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

  /* ---------- 筆記的封面（像 Craft 文件頂上那一張）----------
     一組漸層（樣子在 notepage.css 的 .nb-<名字>），或貼上去的圖（clips/檔名，存在那份筆記的資料夾裡）。
     PR.BANNERS：[名字, 中文名]；PR.bannerAttrs(值, 圖的網址(src))：那一塊要加的 class 和 style；
     PR.pickBanner(anchor, { value, onChange(值), upload(file) → "clips/…" })：挑封面的小框，點了就換（不用按確定）。 */
  PR.BANNERS = [["mist", PR.t("霧藍")], ["dawn", PR.t("晨光")], ["sea", PR.t("海鹽")], ["forest", PR.t("森林")], ["dusk", PR.t("暮色")],
    ["sand", PR.t("沙丘")], ["rose", PR.t("玫瑰")], ["aurora", PR.t("極光")], ["ink", PR.t("墨")], ["night", PR.t("夜空")]];
  PR.bannerAttrs = function (v, urlOf) {
    if (!v) return null;
    if (/^clips\/[A-Za-z0-9._-]+$/.test(v) && urlOf) return { cls: "nb-img", style: "background-image:url(&quot;" + PR.esc(urlOf(v)) + "&quot;)" };
    return PR.BANNERS.some(([k]) => k === v) ? { cls: "nb-" + v, style: "" } : null;
  };
  let bpop = null, bcur = null, bfile = null;
  function closeBanner() { if (bpop) bpop.classList.remove("open"); bcur = null; }
  function paintBanner() {
    bpop.innerHTML = '<div class="nb-grid">' + PR.BANNERS.map(([k, name]) => '<button type="button" class="nb-sw nb-' + k + (bcur.value === k ? " on" : "") + '" data-b="' + k + '" title="' + PR.esc(name) + '"></button>').join("") + "</div>" +
      '<div class="pick-foot nb-foot">' + (bcur.upload ? '<button type="button" class="btn sm" data-up>' + PR.icon("image", "sm") + PR.t("用自己的圖…") + "</button>" : "") +
      '<span class="grow"></span><button type="button" class="btn sm" data-b=""' + (bcur.value ? "" : " disabled") + ">" + PR.t("拿掉封面") + "</button></div>";
  }
  PR.pickBanner = function (anchor, o) {
    if (!bpop) {
      bpop = PR.el("div", { id: "bannerPop", class: "popover nb-pop" });
      document.body.appendChild(bpop);
      bfile = PR.el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: "" });
      document.body.appendChild(bfile);
      bpop.addEventListener("mousedown", (e) => e.preventDefault());
      bpop.addEventListener("click", (e) => {
        if (!bcur) return;
        if (e.target.closest("[data-up]")) { bfile.value = ""; bfile.click(); return; }
        const b = e.target.closest("[data-b]");
        if (!b) return;
        bcur.value = b.dataset.b;
        bcur.onChange(bcur.value);
        if (!bcur.value) return closeBanner();
        paintBanner();
      });
      bfile.addEventListener("change", async () => {
        const f = bfile.files && bfile.files[0], cur = bcur;
        if (!f || !cur || !cur.upload) return;
        closeBanner();
        try { cur.onChange(await cur.upload(f)); } catch (e) { PR.toast(PR.t("封面沒換成：{msg}", { msg: PR.esc(e.message) })); }
      });
      document.addEventListener("mousedown", (e) => { if (bcur && !e.target.closest("#bannerPop")) closeBanner(); });
      document.addEventListener("keydown", (e) => { if (bcur && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBanner(); } }, true);
    }
    bcur = { value: o.value || "", onChange: o.onChange || (() => {}), upload: o.upload || null };
    paintBanner();
    bpop.classList.add("open");
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = bpop.offsetWidth, h = bpop.offsetHeight;
    let y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    bpop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + "px";
    bpop.style.top = y + "px";
    if (PR.growFrom) PR.growFrom(bpop, r);
  };
})(window.PR);
