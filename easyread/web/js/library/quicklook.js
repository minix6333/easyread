/* 快速查看（文獻庫）：選著一篇按空白鍵——不用開成分頁，先翻一翻。像 Finder 的「快速查看」：
   再按空白鍵或 Esc 收掉、↑↓ 換上一篇／下一篇（清單上選的也跟著走）、Enter 才真的打開。右鍵選單裡也有一項。
   論文：直接排出每一頁的圖（捲到才載入，用的是已經做好的那批 1000 像素寬的圖）；
   筆記：把內文畫出來（要用到 markup.js 和 KaTeX——文獻庫這一頁平常不載，第一次看筆記時才載入）。
   鍵盤叫出來的東西：只有一下很短的淡入，沒有縮放、滑動。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  let box = null, cur = null, seq = 0;
  const loaded = {};
  const need = (src, css) => loaded[src] || (loaded[src] = new Promise((ok) => {
    const el = css ? Object.assign(document.createElement("link"), { rel: "stylesheet", href: src }) : Object.assign(document.createElement("script"), { src });
    el.onload = ok; el.onerror = ok;
    document.head.append(el);
  }));
  const noteTitle = (n) => n.title || PR.t("未命名筆記");

  /* 現在畫面上列出來的那幾份，照畫面上的順序（筆記在前、論文在後，和 L.render 一樣） */
  function order() {
    const out = (L.notesShown ? L.notesShown() : []).map((n) => ({ kind: "note", id: n.id }));
    if (!(L.view === "notes" && !L.tag)) L.filtered().forEach((i) => out.push({ kind: "paper", id: i.id }));
    return out;
  }
  function paperBody(i) {
    const n = Math.max(1, i.pages || 1);
    let h = "";
    for (let k = 1; k <= n; k++) h += '<div class="ql-page"><img alt="" loading="lazy" decoding="async" src="/p/' + i.id + "/pages/page-" + String(k).padStart(3, "0") + '.webp?w=1000&v=2"></div>';
    return h;
  }
  async function noteBody(id, mine) {
    const [n] = await Promise.all([PR.api("/api/notes/" + encodeURIComponent(id)), need("/web/vendor/katex/katex.min.css", true), need("/web/vendor/katex/katex.min.js").then(() => need("/web/js/common/markup.js"))]);
    if (mine !== seq || !box) return;
    const keep = PR.imageUrl;
    PR.imageUrl = (src) => "/n/" + encodeURIComponent(id) + "/" + src;  // 筆記裡貼的圖（markup.js 畫 ![](clips/…) 時用）
    let html;
    try { html = (n.body || "").trim() ? (PR.mdBlocks ? PR.mdBlocks(n.body) : "<pre>" + PR.esc(n.body) + "</pre>") : '<p class="ql-empty">' + PR.t("空白的筆記") + "</p>"; } finally { PR.imageUrl = keep; }
    box.querySelector(".ql-body").innerHTML = '<div class="ql-note"><h1>' + PR.esc(noteTitle(n)) + "</h1>" + html + "</div>";
  }

  function paint() {
    const body = box.querySelector(".ql-body"), mine = ++seq;
    let title = "", sub = "", icon = "";
    if (cur.kind === "paper") {
      const i = L.byId(cur.id);
      if (!i) return close();
      const tt = PR.titles ? PR.titles(i) : { main: i.title_zh || i.title_en || i.id };
      title = tt.main;
      sub = [i.authors && i.authors.split(",").slice(0, 2).join(",") + (i.authors.split(",").length > 2 ? PR.t(" 等") : ""), i.year, i.pages ? PR.t("{n} 页", { n: i.pages }) : ""].filter(Boolean).join(" · ");
      icon = PR.icon(i.kind === "slides" ? "page" : "book", "sm");
      body.className = "ql-body" + (i.kind === "slides" ? " wide" : "");
      body.innerHTML = paperBody(i);
      const first = body.querySelector("img");  // 第一張圖來了才知道頁面的長寬比：其餘還沒載的頁照這個比例先留好位置
      if (first) first.addEventListener("load", () => { if (mine === seq && first.naturalWidth) body.style.setProperty("--ar", String(first.naturalWidth / first.naturalHeight)); }, { once: true });
    } else {
      const n = (L.notes || []).find((x) => x.id === cur.id);
      if (!n) return close();
      title = noteTitle(n);
      sub = [n.folder, PR.relTime ? PR.relTime(n.updated) : ""].filter(Boolean).join(" · ");
      icon = PR.tintIcon ? PR.tintIcon(n.icon, n.color, PR.hasIcon("notes") ? "notes" : "notebook") : PR.icon("notebook", "sm");
      body.className = "ql-body note";
      body.innerHTML = "";
      noteBody(cur.id, mine).catch((e) => { if (mine === seq && box) body.innerHTML = '<p class="ql-empty">' + PR.esc(e.message) + "</p>"; });
    }
    body.scrollTop = 0;
    box.querySelector(".ql-ic").innerHTML = icon;
    box.querySelector(".ql-t").textContent = title;
    box.querySelector(".ql-s").textContent = sub;
  }
  function open(kind, id) {
    if (PR.closeMenu) PR.closeMenu();
    cur = { kind, id };
    if (!box) {
      box = PR.el("div", { id: "ql" }, '<div class="ql" role="dialog" aria-label="' + PR.esc(PR.t("快速查看")) + '"><div class="ql-hd"><span class="ql-ic"></span><div class="ql-tt"><b class="ql-t"></b><span class="ql-s"></span></div>' +
        '<button class="btn sm" data-ql="open">' + PR.t("打開") + '<kbd>' + PR.kbd("↩") + '</kbd></button><button class="btn icon" data-ql="x" title="' + PR.esc(PR.t("关闭")) + '">' + PR.icon("x", "sm") + '</button></div><div class="ql-body"></div></div>');
      document.body.append(box);
      box.addEventListener("mousedown", (e) => { if (e.target === box) close(); });
      box.addEventListener("click", (e) => { const b = e.target.closest("[data-ql]"); if (b) (b.dataset.ql === "open" ? go : close)(); });
    }
    paint();
  }
  function close() {
    if (!box) return;
    seq++;
    box.remove(); box = null; cur = null;
  }
  function go() {
    const c = cur;
    close();
    if (c) (c.kind === "paper" ? L.openReader(c.id) : PR.navigate("/note/" + c.id));
  }
  function step(d) {
    const list = order(), at = list.findIndex((x) => x.kind === cur.kind && x.id === cur.id);
    const next = list[at + d];
    if (!next) return;
    cur = next;
    if (next.kind === "paper") { L.select(next.id); const row = PR.$('.row[data-id="' + next.id + '"]'); if (row) row.scrollIntoView({ block: "nearest" }); }
    paint();
  }
  PR.quickLook = { open, close, isOpen: () => !!box };

  /* 鍵盤：開著的時候這幾個鍵是它的（搶在清單自己的 ↑↓／Enter 前面）；沒開的時候，選著一篇按空白鍵就開 */
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (box) {
      const k = e.key;
      if (k === " " || k === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (k === "ArrowDown" || k === "ArrowRight" || k === "j") { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (k === "ArrowUp" || k === "ArrowLeft" || k === "k") { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (k === "Enter") { e.preventDefault(); e.stopPropagation(); go(); }
      return;
    }
    if (e.key !== " " || !L.selected || (e.target && e.target.closest && e.target.closest("input, textarea, select, button, [contenteditable]")) || PR.$(".dialog-backdrop.open") || (PR.menuOpen && PR.menuOpen())) return;
    e.preventDefault();
    open("paper", L.selected);
  }, true);
})(window.PR);
