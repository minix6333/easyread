/* 外部工具欄的 AI 開一個漂浮的小視窗（同一個網站、同一個登入）：看右邊的對話看到不懂、突然想問別的，就在這裡另外問，原本的對話不動。
   - 打開：外部工具欄標題列的小視窗圖示、在回答裡選字冒出的「問這句」、回答上按右鍵「在小視窗問這段」（選的字貼進小視窗的輸入框）。
   - 接著原本的對話問：小視窗送出第一個問題時，右邊那段對話（一則一則轉成 Markdown）當成檔案附上，再加上正在讀的那一頁（dock-ai.js 的 autoSend）。
   - 抓上面那一條可以拖、右下角可以拉大小，位置和大小記著。沒釘選時點到外面就收起來（對話還在，再打開就回來）；釘選了就一直浮著。
   - 上面那排：新對話（有「FOLI」專案就開在專案裡）、釘選、收起來。 */
(function (PR) {
  "use strict";
  const desktop = !!(window.easyreadDesktop && window.easyreadDesktop.isElectron);
  if (!desktop) return;
  const KEY = "easyread-dock-float";
  const MIN_W = 300, MIN_H = 260;
  let box = null, view = null, app = null;
  const prefs = () => Object.assign({ w: 400, h: 560, pinned: false }, PR.ls.get(KEY, {}) || {});
  const keep = (o) => PR.ls.set(KEY, Object.assign(prefs(), o));
  const shown = () => !!(box && !box.hidden);

  function el() {
    if (box) return box;
    box = PR.el("div", { id: "dockFloat", class: "dock-float", hidden: "" });
    box.innerHTML = '<div class="df-head"><span class="df-app"></span><span class="df-hint">' + PR.esc(PR.t("接著右邊的對話問")) + '</span><span class="grow"></span>' +
      '<button class="btn icon" data-f="new" title="' + PR.esc(PR.t("新對話")) + '">' + PR.icon("chatplus", "sm") + "</button>" +
      '<button class="btn icon" data-f="pin"></button>' +
      '<button class="btn icon" data-f="close" title="' + PR.esc(PR.t("收起來（對話還在）")) + '">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="df-body"></div><div class="df-grip" title="' + PR.esc(PR.t("拉大小")) + '"></div>';
    document.body.append(box);
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      if (b.dataset.f === "close") return hide();
      if (b.dataset.f === "pin") return pin(!prefs().pinned);
      if (b.dataset.f === "new" && view && app) return fresh();
    });
    // 拖：抓上面那一條（按鈕以外）；拉大小：右下角。拖的時候網頁不吃滑鼠（body.sizing，shell.css）
    box.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest(".df-grip"), head = e.target.closest(".df-head");
      if (e.button !== 0 || (!grip && (!head || e.target.closest("button")))) return;
      e.preventDefault();
      const r = box.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      document.body.classList.add("sizing");
      box.classList.add("moving");
      const move = (ev) => {
        if (grip) size(r.width + ev.clientX - x0, r.height + ev.clientY - y0);
        else place(r.left + ev.clientX - x0, r.top + ev.clientY - y0);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("sizing");
        box.classList.remove("moving");
        const q = box.getBoundingClientRect();
        keep({ x: Math.round(q.left), y: Math.round(q.top), w: Math.round(q.width), h: Math.round(q.height) });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return box;
  }
  const top0 = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tabs-h")) || 40;
  function place(x, y) {
    const w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, x))) + "px";
    box.style.top = Math.round(Math.max(top0() + 4, Math.min(innerHeight - Math.min(h, 120), y))) + "px";
  }
  function size(w, h) {
    box.style.width = Math.round(Math.max(MIN_W, Math.min(innerWidth - 16, w))) + "px";
    box.style.height = Math.round(Math.max(MIN_H, Math.min(innerHeight - top0() - 12, h))) + "px";
  }
  function paintHead() {
    const p = prefs().pinned, pb = box.querySelector('[data-f="pin"]');
    pb.innerHTML = PR.icon("pin", "sm");
    pb.classList.toggle("on", p);
    pb.title = p ? PR.t("取消釘選（點到外面就收起來）") : PR.t("釘選：點到外面也不收起來");
    box.classList.toggle("pinned", p);
    const a = box.querySelector(".df-app");
    a.textContent = app ? app.name : "";
  }
  function pin(on) {
    keep({ pinned: !!on });
    paintHead();
  }
  const home = () => (app ? (PR.dockAI && PR.dockAI.home(app)) || app.url : "about:blank");
  function fresh() {  // 新對話（有「FOLI」專案就開在專案裡）
    if (!view) return;
    view.loadURL(home()).catch(() => {});
  }
  function makeView(a) {
    if (view) { if (PR.dockAI) PR.dockAI.forget(view); view.remove(); view = null; }
    app = a;
    view = document.createElement("webview");
    view.className = "dock-view on df-view";
    view.setAttribute("partition", "persist:embed");
    view.setAttribute("allowpopups", "");
    view.setAttribute("src", home());
    view.dataset.app = a.id;
    if (PR.dockAI) PR.dockAI.wire(view, a, { float: true });
    box.querySelector(".df-body").append(view);
  }
  /* 打開；o.quote：選的字（貼進輸入框，開一段新的對話來問它） */
  async function open(a, o) {
    a = a || (PR.dock && PR.dock.current && PR.dock.current());
    if (!a || a.kind === "app") return;
    o = o || {};
    el();
    const first = !view || !app || app.id !== a.id;
    const since = view ? view._setups || 0 : 0;
    if (first) makeView(a);
    else if (o.quote) fresh();
    if (box.hidden) {
      const p = prefs(), dockW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dock-w")) || 0;
      box.hidden = false;
      size(p.w, p.h);
      if (p.x == null) place(innerWidth - dockW - box.offsetWidth - 16, top0() + 56); else place(p.x, p.y);
    }
    paintHead();
    view.focus();
    if (o.quote && PR.dockAI) {
      await PR.dockAI.whenReady(view, first ? 0 : since, 20000);
      await new Promise((r) => setTimeout(r, 500));  // 網站把輸入框畫好
      await PR.dockAI.typeInto(view, PR.t("「{q}」", { q: String(o.quote).replace(/\s+/g, " ").trim().slice(0, 1500) }) + " ");
    }
  }
  function hide() { if (box) box.hidden = true; }
  // 沒釘選：點到小視窗外面（FOLI 的畫面、右邊的網頁、閱讀頁）就收起來
  document.addEventListener("mousedown", (e) => { if (shown() && !prefs().pinned && !box.contains(e.target) && !(e.target.closest && e.target.closest("#ctxmenu, .menu"))) hide(); }, true);
  window.addEventListener("blur", () => setTimeout(() => { if (shown() && !prefs().pinned && document.activeElement !== view) hide(); }, 0));
  // 從小視窗直接點到右邊的網頁、閱讀頁：FOLI 的視窗本來就沒有焦點（在小視窗裡），收不到 blur；看焦點換到哪個元素
  document.addEventListener("focusin", (e) => { if (shown() && !prefs().pinned && e.target !== view && !box.contains(e.target)) hide(); }, true);
  window.addEventListener("resize", () => { if (shown()) { const q = box.getBoundingClientRect(); size(q.width, q.height); place(q.left, q.top); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && shown() && !prefs().pinned && box.contains(document.activeElement)) hide(); });

  PR.dockFloat = {
    open,
    hide,
    /* 點到別的地方（閱讀頁、文獻庫的框——外殼收不到那裡的滑鼠；右邊的網頁——dock-guest.js 說一聲）：沒釘選就收起來 */
    outside() { if (shown() && !prefs().pinned) hide(); },
    toggle(a) { if (shown() && (!a || (app && app.id === a.id))) hide(); else open(a); },
    shown,
    view: () => view,
    pin,
  };
})(window.PR);
