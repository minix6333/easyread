/* 介面的小動作（apple-design）：
   - 分段控制（.seg）的白色滑塊真的「滑」到新的一段，不是閃一下換位置；整段重畫（innerHTML）也接得上上一次的位置。
   - 側欄（.side）選中那一列的底是一塊會滑的墊子，換列時滑過去。
   都只是裝飾：真正的狀態還是 .on，這支壞了也只是沒有動畫。 */
(function (PR) {
  "use strict";
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- 分段控制 ---------- */
  const lastKnob = new Map();  // 位置的記號 → 上一次滑塊的位置（重畫後從那裡滑過來）
  function segKey(seg) {
    const host = seg.closest("[id]");
    if (!host) return null;
    const segs = host.querySelectorAll(".seg");
    return host.id + "#" + Array.prototype.indexOf.call(segs, seg);
  }
  /* 大小變了就重擺滑塊：畫的時候藏著（display: none，量不到）的分段控制，之後顯示出來時補上——
     閱讀頁頂欄的「原文／譯文／雙語」在 PDF 優先時是藏著的，打開譯文才出現，以前那時候滑塊沒擺上去，看不出選了哪個。
     字型載好、換語言讓每一格變寬變窄時也靠這個對回去。 */
  const watched = new WeakSet();
  const ro = window.ResizeObserver ? new ResizeObserver((entries) => { for (const e of entries) if (e.target.isConnected) placeKnob(e.target, true); }) : null;
  function placeKnob(seg, instant) {
    let k = seg.querySelector(":scope > .seg-knob");
    const on = seg.querySelector(":scope > button.on");
    if (ro && !watched.has(seg)) { watched.add(seg); ro.observe(seg); }
    if (!k) { k = document.createElement("i"); k.className = "seg-knob"; seg.prepend(k); instant = true; }
    if (!on) { k.style.opacity = "0"; return; }
    const r = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
    if (!r.w) return;  // 還沒排版（藏著）
    const key = segKey(seg), prev = instant && key ? lastKnob.get(key) : null;
    const set = (p) => { k.style.transform = "translate(" + p.x + "px," + p.y + "px)"; k.style.width = p.w + "px"; k.style.height = p.h + "px"; };
    k.style.opacity = "";
    if (instant) {
      k.classList.add("still");
      set(prev && (prev.x !== r.x || prev.w !== r.w) ? prev : r);
      k.offsetWidth;  // 先放到起點，下一格再滑過去
      k.classList.remove("still");
      if (prev && (prev.x !== r.x || prev.w !== r.w)) requestAnimationFrame(() => set(r));
    } else set(r);
    if (key) lastKnob.set(key, r);
  }
  function segs(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches(".seg")) placeKnob(root, true);
    root.querySelectorAll(".seg").forEach((s) => placeKnob(s, true));
  }

  /* ---------- 側欄的選中墊 ---------- */
  function sideKnob(side) {
    let k = side.querySelector(":scope > .side-knob");
    const on = side.querySelector(".srow.on, button.on");
    if (!k) { k = document.createElement("i"); k.className = "side-knob still"; side.prepend(k); }
    if (!on || !on.offsetWidth) { k.style.opacity = "0"; return; }
    // offsetTop 是相對 .side（position: relative）的，捲動時跟著內容走
    let x = 0, y = 0, el = on;
    while (el && el !== side) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
    const p = "translate(" + x + "px," + y + "px)";
    const moved = k.style.transform && k.style.transform !== p;
    k.style.opacity = "";
    k.style.width = on.offsetWidth + "px"; k.style.height = on.offsetHeight + "px"; k.style.transform = p;
    if (moved) { k.classList.remove("still"); }
    else { k.classList.add("still"); k.offsetWidth; k.classList.remove("still"); }
  }

  function boot() {
    segs(document.body);
    const sides = () => PR.$$(".side").forEach(sideKnob);
    sides();
    let queue = [], timer = 0, sideDirty = false;
    const flush = () => {
      timer = 0; const q = queue; queue = []; q.forEach(segs);
      if (sideDirty) { sideDirty = false; sides(); }
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") {
          const t = m.target;
          if (t.matches && t.matches(".seg > button")) placeKnob(t.parentElement, false);
          if (t.closest && t.closest(".side")) sideDirty = true;
        } else {
          for (const n of m.addedNodes) if (n.nodeType === 1) { queue.push(n); if (n.closest && n.closest(".side")) sideDirty = true; }
        }
      }
      if ((queue.length || sideDirty) && !timer) timer = setTimeout(flush, 16);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    addEventListener("resize", () => { PR.$$(".seg").forEach((s) => placeKnob(s, true)); sides(); });
    if (still.matches) document.documentElement.classList.add("still-ui");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  /* ---------- 彈簧曲線、FLIP ----------
     PR.spring()：CSS 的 --spring（臨界阻尼的彈簧，linear() 寫的）拿來給 element.animate 用；減少動態時是直線（等於直接跳過去）。
     PR.dur()：同一條彈簧跑完的時間（--dur，毫秒）。
     PR.flip(els, change, opts)：版面要變之前記下每個元素的位置，change() 改完版面，再讓它們從舊位置滑到新位置——
       只動 translate（不縮放，字和封面不會變形；版面一次到位，不會滑到一半被擠壓、換行）；只處理舊位置或新位置看得到的（上下左右多算 120px）；
       連續觸發時從目前畫面上的位置接著滑（不會跳回去）。
     opts.hold(on)：內容區變窄的時候用（例如打開側欄）。新版面裡元素的舊位置有一部分在捲動區外面、會被切掉，
       所以量好新位置後 hold(true) 先回到舊版面，在舊版面裡滑到新位置，滑完 hold(false) 才真的換過去——那一幀位置一樣，看不出換了。
     opts.scale：這些元素寬度也變了的話，一起等比例縮放（以左上角為準），一格一格的卡片才不會在滑的時候互相疊到、到了才突然變大變小；
       等比例所以不會變形，差個一成看不出來。
     opts.edges：一整條有底色、跟著欄變寬變窄的（清單檢視那張紙、提示條）：它們不能整條平移（另一邊會跟著跑），
       改成左右邊緣跟著滑（動 margin，只有它自己裡面重排；卡片那種一格一格的才用 translate）。
     opts.done()：滑完（或被下一次打斷）之後。 */
  let springV = "", durV = 0;  // 讀一次就記著（在迴圈裡一邊改樣式一邊讀 <html> 的計算樣式，每讀一次都要重算一次樣式）
  PR.spring = function () {
    if (!springV) springV = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "cubic-bezier(.22, 1, .36, 1)";
    return springV;
  };
  PR.dur = function () {
    if (!durV) {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--dur").trim(), n = parseFloat(v);
      durV = isNaN(n) ? 450 : /ms$/.test(v) ? n : n * 1000;
    }
    return durV;
  };
  still.addEventListener && still.addEventListener("change", () => { springV = ""; durV = 0; });

  /* 絕對定位的東西換位置（邊註的卡片被擠下去、往上補）：top 直接到位，畫面上用 translate 從舊位置滑過去——
     以前是 transition: top，每一格都要重新排版；連續換位置時從畫面上現在的位置接著滑 */
  PR.moveTop = function (el, top) {
    const v = Math.round(top) + "px";
    if (el.style.top === v) return;
    const was = el.style.top && el.style.top !== "auto" ? parseFloat(el.style.top) : NaN;
    let from = 0;
    if (!isNaN(was) && !still.matches && el.isConnected && el.animate) {
      const cur = el.getAnimations().find((a) => a.id === "slide");
      if (cur) { from = parseFloat(String(getComputedStyle(el).translate || "").split(" ")[1]) || 0; cur.cancel(); }
      from += was - Math.round(top);
    }
    el.style.top = v;
    if (Math.abs(from) > 1) {
      const a = el.animate([{ translate: "0 " + from + "px" }, { translate: "0 0" }], { duration: PR.dur(), easing: PR.spring() });
      a.id = "slide";
    }
  };
  let flipping = null;  // 還在滑的那一次的收尾（下一次開始前先收掉）
  PR.flip = function (els, change, opts) {
    opts = opts || {};
    const prev = flipping;
    flipping = null;
    if (still.matches || !document.body.animate) {
      if (prev) prev();
      change();
      if (opts.done) opts.done();
      return () => {};
    }
    const first = new Map();
    for (const el of els) {
      if (!el || !el.isConnected) continue;
      const b = el.getBoundingClientRect();
      if (b.width || b.height) first.set(el, b);
    }
    const edges = (opts.edges || []).filter((el) => el && el.isConnected && el.offsetWidth).map((el) => ({ el, b: el.getBoundingClientRect() }));
    if (prev) prev();  // 上一次收尾：版面換到它的終點、動畫取消；這一次從剛剛畫面上的位置開始
    change();
    const vw = innerWidth, vh = innerHeight, M = 120;
    const near = (b) => b.bottom > -M && b.top < vh + M && b.right > -M && b.left < vw + M;
    const moving = [];
    first.forEach((b, el) => {
      if (!el.isConnected) return;
      const a = el.getBoundingClientRect();
      if (!near(a) && !near(b)) return;
      if (Math.abs(b.left - a.left) < 0.5 && Math.abs(b.top - a.top) < 0.5 && Math.abs(b.width - a.width) < 1) return;
      moving.push({ el, b, a, c: a });
    });
    edges.forEach((e) => { e.a = e.el.getBoundingClientRect(); e.c = e.a; });
    if (opts.hold) {
      opts.hold(true);
      moving.forEach((m) => { m.c = m.el.getBoundingClientRect(); });  // 動畫在舊版面裡跑：從這裡算位移
      edges.forEach((e) => { e.c = e.el.getBoundingClientRect(); });
    }
    const easing = PR.spring(), duration = opts.duration || PR.dur(), fill = opts.hold ? "forwards" : "none";
    const scaled = new Set(opts.scale || []);
    const anims = moving.map((m) => {
      const k0 = { translate: (m.b.left - m.c.left) + "px " + (m.b.top - m.c.top) + "px" }, k1 = { translate: (m.a.left - m.c.left) + "px " + (m.a.top - m.c.top) + "px" };
      if (scaled.has(m.el) && m.c.width && Math.abs(m.b.width - m.a.width) > 1) {
        k0.scale = String(m.b.width / m.c.width); k1.scale = String(m.a.width / m.c.width);
        k0.transformOrigin = k1.transformOrigin = "0 0";
      }
      const x = m.el.animate([k0, k1], { duration, easing, fill });
      x.id = "flip";
      return x;
    });
    edges.forEach((e) => {
      const dl0 = e.b.left - e.c.left, dl1 = e.a.left - e.c.left, dr0 = e.c.right - e.b.right, dr1 = e.c.right - e.a.right;
      if (Math.abs(dl0 - dl1) < 0.5 && Math.abs(dr0 - dr1) < 0.5) return;
      const cs = getComputedStyle(e.el), ml = parseFloat(cs.marginLeft) || 0, mr = parseFloat(cs.marginRight) || 0;
      const x = e.el.animate([{ marginLeft: ml + dl0 + "px", marginRight: mr + dr0 + "px" }, { marginLeft: ml + dl1 + "px", marginRight: mr + dr1 + "px" }], { duration, easing, fill });
      x.id = "flip";
      anims.push(x);
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (flipping === end) flipping = null;
      if (opts.hold) opts.hold(false);
      anims.forEach((x) => x.cancel());  // hold 的話：換到新版面的同一刻拿掉位移（位置一樣）；被打斷的話：下一次從量到的位置接手
      if (opts.done) opts.done();
    };
    flipping = end;
    if (anims.length) anims[0].finished.then(end, () => {});
    else setTimeout(end, 0);
    return end;
  };

  /* ---------- 版面大改：View Transitions ----------
     閱讀頁、筆記頁開關側面板時，畫面上很多固定位置的東西一起變（畫布、PDF 頁、頂欄的鈕、底下的頁碼膠囊…），
     PDF 頁換寬度還要重新排、重新解碼——一個個去算 FLIP 太碎，而且舊位置會被捲動區切掉。
     改用 View Transitions：拍下舊畫面 → update() 改版面 → 拍新畫面；有名字的元素（opts.names）從舊的位置、大小滑到新的
     （是 GPU 上的截圖在動，不重排、不重新解碼），其餘的淡入淡出。
     opts.names()：[[元素, 名字, 類別], …]，改版面前後各叫一次（新畫面才出現的也算得到）；類別給 CSS 選（*.page、*.panel、*.fill）。
     update() 會晚一格才跑（要先拍舊畫面）。動畫期間滑鼠點得到底下真的元素（CSS 裡 ::view-transition 不擋）。
     連續觸發時上一次直接跳到結尾（View Transitions 沒辦法從半路接著動）。 */
  PR.morph = function (update, opts) {
    opts = opts || {};
    const root = document.documentElement;
    // 整個視窗同一時間只能有一個 View Transitions（外殼和 iframe 各跑一個會讓頁面當掉，見 util.js 的 PR.vtFree）：有別的在跑就直接換
    if (still.matches || !document.startViewTransition || document.visibilityState !== "visible" || (PR.vtFree && !PR.vtFree())) { update(); return null; }
    const byName = new Map();  // 名字 → 元素（同一個名字只能有一個）
    const nameAll = () => {
      for (const [el, name, cls] of (opts.names ? opts.names() : [])) {
        if (!el || !el.isConnected) continue;
        const had = byName.get(name);
        if (had && had !== el && had.isConnected) continue;
        if (el.style.viewTransitionName && el.style.viewTransitionName !== name) continue;
        byName.set(name, el);
        el.style.viewTransitionName = name;
        if (cls) el.style.viewTransitionClass = cls;
      }
    };
    const cleanup = () => {
      byName.forEach((el) => { el.style.viewTransitionName = ""; el.style.viewTransitionClass = ""; });
      byName.clear();
      if (root.dataset.vt === (opts.type || "morph")) delete root.dataset.vt;
      if (PR.vtDone) PR.vtDone();
    };
    nameAll();
    root.dataset.vt = opts.type || "morph";
    if (PR.vtHold) PR.vtHold(2000);
    let t;
    try {
      t = document.startViewTransition(() => { update(); nameAll(); });
    } catch (e) { cleanup(); update(); return null; }
    t.ready.catch(() => {});
    t.finished.then(cleanup, cleanup);
    return t;
  };
})(window.PR = window.PR || {});
