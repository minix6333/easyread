/* 回答、筆記裡的「網路上的圖」（```pic 區塊，markup.js 排成 <figure class="md-pic">）：到後端問一張圖（/api/webimg，只到維基百科／維基共享資源找），
   找到就放進去，下面一行出處（檔名、作者、授權——創用 CC 的圖要註明）；找不到整塊不顯示。
   模型看不到實際找到哪一張，所以圖右上角有一顆「換一張」：在幾張候選之間切，選過的記在這台（同一個條目下次直接是那一張）。
   頁面上哪裡多出了 .md-pic 就處理（聊天、卡片、便利貼、筆記都走這裡）；同一個查詢只問一次。
   問過的由 PR.picCached 直接排進 HTML：回答還在寫的時候整段會重排很多次，每次都重新放一張圖會一直閃。 */
(function (PR) {
  "use strict";
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const asked = new Map();  // 查詢 → Promise<items>
  const found = new Map();  // 查詢 → 回來的那幾張
  const keyOf = (el) => [el.dataset.article || "", el.dataset.q || "", el.dataset.file || ""].join("|");
  const picks = () => (PR.ls ? PR.ls.get("easyread-webimg-pick", {}) || {} : {});
  const picked = (key, items) => Math.min(items.length - 1, Math.max(0, +picks()[key] || 0));
  const esc = (s) => PR.esc(String(s == null ? "" : s));
  const tell = (el) => { if (PR.emit) PR.emit("flow-drawn", [el]); };  // 高度變了：卡片要重新疊放（和流程圖畫好時一樣）
  const ask = (el) => {
    const key = keyOf(el);
    if (!asked.has(key)) {
      const qs = new URLSearchParams({ article: el.dataset.article || "", q: el.dataset.q || "", file: el.dataset.file || "" });
      asked.set(key, fetch("/api/webimg?" + qs).then((r) => (r.ok ? r.json() : { error: true })).catch(() => ({ error: true })).then((d) => {
        const items = Array.isArray(d.items) ? d.items.filter((it) => it && it.src && it.name) : [];
        if (d.error && !items.length) setTimeout(() => asked.delete(key), 30000);  // 這次沒連上：過一下再出現同一張圖時重問
        else found.set(key, items);
        return items;
      }));
    }
    return asked.get(key);
  };
  // 一張圖的兩段 HTML：圖本身（連到共享資源那一頁）＋「換一張」，和下面那行出處。again＝這張已經載入過（重排時不要再慢慢淡進來）
  function parts(items, i, again) {
    const it = items[i], credit = [it.artist, it.license].filter(Boolean).map(esc).join(" · ");
    return {
      slot: '<a class="pic-img" href="' + esc(it.page) + '" target="_blank" rel="noopener" title="' + esc(PR.t("在維基共享資源看原圖")) + '">' +
        '<img src="' + esc(it.src) + '" alt=""' + (it.w && it.h ? ' width="' + +it.w + '" height="' + +it.h + '"' : "") + (again ? ' decoding="sync"' : ' loading="lazy" decoding="async"') + "></a>" +
        (items.length > 1 ? '<button class="pic-next btn icon" type="button" title="' + esc(PR.t("換一張（{i}／{n}）", { i: i + 1, n: items.length })) + '">' + PR.icon("redo", "sm") + "</button>" : ""),
      src: '<a href="' + esc(it.page) + '" target="_blank" rel="noopener">' + esc(it.name.replace(/\.[a-z]{3,4}$/i, "")) + "</a>" + (credit ? " · " + credit : "") + " · " + esc(PR.t("維基共享資源")),
    };
  }
  PR.picCached = function (p) {
    const key = [p.article || "", p.q || "", p.file || ""].join("|"), items = found.get(key);
    if (!items || !items.length) return null;
    const i = picked(key, items);
    return Object.assign({ i }, parts(items, i, true));
  };
  function paint(el, items, i) {
    const slot = el.querySelector(".pic-slot");
    if (!slot || !items[i]) return;
    const p = parts(items, i, false);
    slot.innerHTML = p.slot;
    let src = el.querySelector(".pic-src");
    if (!src) { src = document.createElement("div"); src.className = "pic-src"; el.append(src); }
    src.innerHTML = p.src;
    el.dataset.i = i;
    el.classList.add("ready");
    tell(el);
  }
  const same = (key, fn) => document.querySelectorAll(".md-pic").forEach((el) => { if (keyOf(el) === key) fn(el); });
  function fill(el) {
    if (el.dataset.asked) return;
    el.dataset.asked = "1";
    ask(el).then((items) => { if (el.isConnected && items.length) paint(el, items, picked(keyOf(el), items)); });
  }
  // 「換一張」：同一張圖在別處（卡片和聊天裡各有一份）也跟著換。在最外層先攔下來，卡片自己的點擊（展開、選取）就不會跟著動
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".md-pic .pic-next") : null;
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const el = btn.closest(".md-pic"), key = keyOf(el), items = found.get(key);
    if (!items || items.length < 2) return;
    const j = ((+el.dataset.i || 0) + 1) % items.length, saved = picks();
    saved[key] = j;
    if (PR.ls) PR.ls.set("easyread-webimg-pick", saved);
    same(key, (other) => { if (other.classList.contains("ready")) paint(other, items, j); });
  }, true);
  // 圖拿不到（共享資源那邊刪了、離線又沒抓過）：這張之後不用，換下一張；一張都沒有就整塊收起來。error、load 不會往上冒，要在捕獲階段聽
  const picOf = (img) => (img && img.tagName === "IMG" && img.parentElement && img.parentElement.classList.contains("pic-img") ? img.closest(".md-pic") : null);
  document.addEventListener("error", (e) => {
    const el = picOf(e.target);
    if (!el) return;
    const key = keyOf(el), items = found.get(key) || [], at = items.findIndex((it) => it.src === e.target.getAttribute("src"));
    if (at >= 0) items.splice(at, 1);
    same(key, (other) => {
      if (items.length) paint(other, items, picked(key, items));
      else if (other.classList.contains("ready")) { other.classList.remove("ready"); tell(other); }
    });
  }, true);
  document.addEventListener("load", (e) => { const el = picOf(e.target); if (el && !e.target.hasAttribute("width")) tell(el); }, true);  // 不知道尺寸的圖：載入後高度才定
  let queued = false;
  const run = () => { queued = false; document.querySelectorAll(".md-pic:not([data-asked])").forEach(fill); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(document.body, { childList: true, subtree: true });
  run();
})(window.PR);
