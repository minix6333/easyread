/* 筆記頁的「在這一頁搜尋」（⌘F，像 Craft 的「在頁面中搜尋」；桌面版沒有瀏覽器內建的那一條）。
   找的是排好的字（不是 Markdown 原文）：用 CSS Custom Highlight 把每一處標出來，不動 DOM；Enter／⇧Enter（或 ⌘G／⇧⌘G）一處一處走，Esc 關掉。
   跨了粗體邊界的字串（「一**半**」裡找「一半」）找不到——每個文字節點各找各的，夠用而且不會把編輯器的節點弄亂。 */
(function (PR) {
  "use strict";
  const N = PR.note;
  if (!N || !window.CSS || !CSS.highlights || typeof Highlight === "undefined") return;
  const $ = PR.$;
  let bar = null, ranges = [], at = -1, timer = 0;
  const open = () => !!(bar && bar.classList.contains("open"));

  function build() {
    bar = PR.el("div", { id: "noteFind", class: "note-find" },
      PR.icon("search", "sm") + '<input type="search" placeholder="' + PR.t("在這份筆記裡找") + '" autocomplete="off" spellcheck="false">' +
      '<span class="nf-n"></span><button type="button" data-nf="prev" title="' + PR.kbd(PR.t("上一處（⇧Enter）")) + '">' + PR.icon("arrowUp", "sm") + "</button>" +
      '<button type="button" data-nf="next" title="' + PR.t("下一處（Enter）") + '">' + PR.icon("arrowUp", "sm") + '</button><button type="button" data-nf="close" title="' + PR.t("关闭") + '">' + PR.icon("x", "sm") + "</button>");
    document.body.appendChild(bar);
    const inp = bar.querySelector("input");
    inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(true), 80); });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    bar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-nf]"); if (!b) return;
      if (b.dataset.nf === "close") close(); else step(b.dataset.nf === "prev" ? -1 : 1);
    });
  }
  function clear() { CSS.highlights.delete("note-find"); CSS.highlights.delete("note-find-cur"); ranges = []; at = -1; }
  function search(jump) {
    const q = bar.querySelector("input").value.toLowerCase();
    clear();
    if (q) {
      const w = document.createTreeWalker($("#noteMain"), NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest(".katex, .bk-gut, textarea, .bk-ph") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const text = n.nodeValue.toLowerCase();
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + q.length); ranges.push(r); }
      }
      if (ranges.length) CSS.highlights.set("note-find", new Highlight(...ranges));
    }
    if (ranges.length && jump) { at = firstVisible(); show(); } else count();
  }
  const firstVisible = () => { const k = ranges.findIndex((r) => r.getBoundingClientRect().top >= 70); return k < 0 ? 0 : k; };
  function count() { bar.querySelector(".nf-n").textContent = bar.querySelector("input").value ? (ranges.length ? at + 1 + " / " + ranges.length : PR.t("找不到")) : ""; bar.classList.toggle("none", !!bar.querySelector("input").value && !ranges.length); }
  function show() {
    if (at < 0 || !ranges[at]) return count();
    CSS.highlights.set("note-find-cur", new Highlight(ranges[at]));
    const r = ranges[at].getBoundingClientRect();
    if (r.top < 90 || r.bottom > innerHeight - 80) scrollBy({ top: r.top - innerHeight * 0.4, behavior: "smooth" });
    count();
  }
  function step(d) { if (!ranges.length) return; at = (at + d + ranges.length) % ranges.length; show(); }
  function close() { if (!bar) return; bar.classList.remove("open"); clear(); }
  PR.noteFind = function () {
    if (!N.ed) return false;
    if (!bar) build();
    N.ed.blur();  // 正在編的那一塊是輸入框，裡面的字不在頁面的文字節點裡：先收起來才找得到
    bar.classList.add("open");
    const inp = bar.querySelector("input");
    const sel = String(getSelection()).trim();
    if (sel && sel.length < 60 && !/\n/.test(sel)) inp.value = sel;
    inp.focus(); inp.select();
    search(true);
    return true;
  };
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && k === "f") { if (PR.noteFind()) e.preventDefault(); return; }
    if (mod && !e.altKey && k === "g" && open()) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  });
  // 內容變了（打字、復原、AI 改了）：標記的位置會失效，開著就重找一次，位置留在原來那一處附近
  N.ready.then((ok) => {
    if (!ok) return;
    const again = () => { if (!open()) return; clearTimeout(timer); timer = setTimeout(() => { const keep = at; search(false); at = Math.min(keep, ranges.length - 1); if (at >= 0) CSS.highlights.set("note-find-cur", new Highlight(ranges[at])); count(); }, 120); };
    N.ed.on("render", again);
    N.ed.on("change", again);
  });
})(window.PR);
