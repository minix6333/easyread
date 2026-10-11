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
  function placeKnob(seg, instant) {
    let k = seg.querySelector(":scope > .seg-knob");
    const on = seg.querySelector(":scope > button.on");
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
})(window.PR = window.PR || {});
