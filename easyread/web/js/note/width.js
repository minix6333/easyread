/* 筆記頁寫字那一欄的寬度（每份筆記自己記：note.json 的 width——0 預設、-1 滿版、其他是像素）。
   - 紙的左右兩邊各有一道看不見的把手：滑鼠靠近才出現一條細線，拖了就變寬變窄（兩邊一起，紙一直置中）；
     拖到常用的寬度附近會吸過去，雙擊回到預設。拖的時候紙上方出現寬度，放開就消失。
   - 檢閱器的「版面寬度」、更多選單的「寬頁」也走這裡（PR.noteWidth.set）。
   - 以前只有「寬頁」一個開關（wide：820 或 1240）；舊筆記開著寬頁、沒設 width 的照 1240。 */
(function (PR) {
  "use strict";
  const N = PR.note, main = PR.$("#noteMain");
  if (!N || !main) return;
  const DEFAULT = 820, MIN = 440, MAX = 2400;
  const PRESETS = [["narrow", 640], ["normal", DEFAULT], ["wide", 1040], ["full", -1]];
  const SNAP = [640, DEFAULT, 1040, 1240];
  const room = () => main.parentElement ? main.parentElement.clientWidth - 24 : innerWidth;  // 中間那一格放得下多寬
  const widthOf = (n) => (n && n.width ? +n.width : n && n.wide ? 1240 : 0);
  function apply(w, live) {
    const b = document.body;
    b.classList.toggle("nw-live", !!live);
    b.classList.toggle("nw-full", w === -1);
    if (w > 0) b.style.setProperty("--note-w", w + "px"); else b.style.removeProperty("--note-w");
    b.classList.remove("wide");  // 舊的寬頁改用 --note-w
  }
  function current() { return widthOf(N.st.note); }
  function set(w) {
    w = w === -1 ? -1 : w > 0 ? Math.max(MIN, Math.min(MAX, Math.round(w))) : 0;
    apply(w, false);
    N.patch({ width: w, wide: false });
  }
  /* 把手：放在紙的兩邊（絕對定位，跟著紙走），拖的時候算「游標離紙中線多遠」×2 */
  const grips = ["l", "r"].map((side) => {
    const g = document.createElement("div");
    g.className = "nw-grip nw-" + side;
    g.setAttribute("role", "separator");
    g.setAttribute("aria-orientation", "vertical");
    g.title = PR.t("拖拉調整寬度（雙擊回到預設）");
    main.append(g);
    return g;
  });
  const tip = document.createElement("div");
  tip.className = "nw-tip";
  main.append(tip);
  let drag = null;
  grips.forEach((g) => {
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const r = main.getBoundingClientRect();
      drag = { id: e.pointerId, cx: r.left + r.width / 2, w: r.width };
      document.body.classList.add("nw-dragging");
    });
    g.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      let w = Math.abs(e.clientX - drag.cx) * 2;
      const max = Math.min(MAX, room());
      w = Math.max(MIN, Math.min(max, w));
      const near = SNAP.find((s) => Math.abs(s - w) <= 14 && s <= max);  // 靠近常用的寬度就吸過去
      if (near) w = near;
      if (w >= max - 6) w = -1;  // 拉到底就是滿版
      drag.w = w;
      apply(w, true);
      tip.textContent = w === -1 ? PR.t("滿版") : w === DEFAULT ? PR.t("{n} · 預設", { n: w }) : String(w);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const w = drag.w;
      drag = null;
      document.body.classList.remove("nw-dragging");
      set(w === DEFAULT ? 0 : w);
    };
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
    g.addEventListener("dblclick", () => set(0));
    g.addEventListener("keydown", (e) => {  // 鍵盤也能調：左右鍵一次 40px
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const now = current() > 0 ? current() : current() === -1 ? Math.min(MAX, room()) : DEFAULT;
      set(now + (e.key === "ArrowRight" ? 40 : -40));
    });
    g.tabIndex = 0;
  });
  N.on && N.on("note", (o) => { if (o && ("width" in o || "wide" in o) && !drag) apply(current(), false); });
  PR.noteWidth = {
    PRESETS, DEFAULT,
    get: current,
    set,
    preset() { const w = current(); const hit = PRESETS.find(([, v]) => (v === DEFAULT ? w === 0 || w === DEFAULT : v === w)); return hit ? hit[0] : "custom"; },
    apply: () => apply(current(), false),
  };
  if (N.ready && N.ready.then) N.ready.then(() => apply(current(), false)); else apply(current(), false);
})(window.PR);
