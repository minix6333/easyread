/* 在整份 PDF 裡找字（⌘F）：Enter 下一個、Shift+Enter 上一個、Esc 關掉。
   用的是抽取的字元（和文字層同一份）：每一頁按閱讀順序串成文字再比對（不分大小寫、行尾斷字接回去），
   找到的地方按字元框畫出來。各頁的字元資料第一次搜尋時才載入，之後留著。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const index = {};  // 頁碼 → { low: 小寫文字, map: [字元編號 | -1], seg: [第幾行], chars }
  let bar = null, hits = [], cur = -1, token = 0;
  const pageCount = () => ((S.paper.meta || {}).pages || []).length;
  const SOFT = /[\u0002­]/;

  async function pageIndex(n) {
    if (index[n]) return index[n];
    const { chars, segs } = await PR.pageSegs(n);
    let low = "";
    const map = [], seg = [];
    const push = (ch, i, k) => { for (const u of ch) { const l = u.toLowerCase(); low += l.length === u.length ? l : u; for (let j = 0; j < u.length; j++) { map.push(i); seg.push(k); } } };
    segs.forEach((s, k) => {
      s.items.forEach((i) => (i < 0 ? push(" ", -1, k) : SOFT.test(chars[i][0]) ? null : push(chars[i][0], i, k)));
      const last = s.items[s.items.length - 1];
      const lastCh = last >= 0 ? chars[last][0] : "";
      const next = segs[k + 1], nextCh = next && next.items[0] >= 0 ? chars[next.items[0]][0] : "";
      if (SOFT.test(lastCh) || (lastCh === "-" && /[a-z]/.test(nextCh))) return;  // 行尾斷字：直接接下一行
      push(" ", -1, k);
    });
    return (index[n] = { low, map, seg, chars });
  }

  function paint() {
    const nodes = PR.pageNodes ? PR.pageNodes() : [];
    const by = {};
    hits.forEach((h, i) => (by[h.page] = by[h.page] || []).push(i));
    nodes.forEach((entry, k) => {
      const list = by[k + 1];
      if (!list) { if (entry.find) entry.find.innerHTML = ""; return; }
      if (!entry.find) { entry.find = document.createElement("div"); entry.find.className = "pv-find"; entry.node.append(entry.find); }
      entry.find.innerHTML = list.map((i) => hits[i].rects.map(([x0, y0, x1, y1]) => '<div class="pv-hit' + (i === cur ? " cur" : "") + '" style="left:' + (x0 * 100).toFixed(3) + "%;top:" + (y0 * 100).toFixed(3) +
        "%;width:" + ((x1 - x0) * 100).toFixed(3) + "%;height:" + ((y1 - y0) * 100).toFixed(3) + '%"></div>').join("")).join("");
    });
    const n = bar && bar.querySelector(".n");
    if (n) n.textContent = hits.length ? cur + 1 + " / " + hits.length : bar.querySelector("input").value.trim() ? PR.t("找不到") : "";
  }
  function go(d) {
    if (!hits.length) return;
    cur = (cur + d + hits.length) % hits.length;
    paint();
    const el = PR.$(".pv-hit.cur");
    if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
  }
  async function search(text) {
    const mine = ++token;
    const q = text.trim().toLowerCase();
    hits = []; cur = -1;
    if (!q) return paint();
    const n = bar.querySelector(".n");
    if (n) n.innerHTML = '<span class="spin"></span>';
    const found = [];
    for (let p = 1; p <= pageCount(); p++) {
      const ix = await pageIndex(p);
      if (mine !== token) return;
      for (let at = ix.low.indexOf(q); at >= 0 && found.length < 2000; at = ix.low.indexOf(q, at + Math.max(1, q.length))) {
        const rects = [];
        let line = -1, box = null;
        for (let j = at; j < at + q.length; j++) {
          const i = ix.map[j];
          if (i < 0) continue;
          const c = ix.chars[i];
          if (ix.seg[j] !== line || !box) { box = [c[1], c[2], c[3], c[4]]; rects.push(box); line = ix.seg[j]; }
          else { box[0] = Math.min(box[0], c[1]); box[1] = Math.min(box[1], c[2]); box[2] = Math.max(box[2], c[3]); box[3] = Math.max(box[3], c[4]); }
        }
        if (rects.length) found.push({ page: p, rects });
      }
    }
    hits = found;
    // 從現在看的這一頁開始往後找第一個
    const here = PR.pdfPage ? PR.pdfPage() : 1;
    const first = hits.findIndex((h) => h.page >= here);
    cur = (first >= 0 ? first : 0) - 1;
    if (hits.length) go(1); else paint();
  }
  const searchSoon = PR.debounce((v) => search(v), 220);

  PR.findOpen = () => !!bar;
  PR.openFind = function () {
    if (!(PR.pdfMain && PR.pdfMain())) return false;
    if (!bar) {
      bar = PR.el("div", { id: "findbar" }, PR.icon("search", "sm") + '<input placeholder="' + PR.esc(PR.t("搜尋這份文件")) + '"><span class="n"></span>' +
        '<button data-f="prev" title="' + PR.esc(PR.t("上一個（Shift+Enter）")) + '">' + PR.icon("back", "sm") + '</button><button data-f="next" title="' + PR.esc(PR.t("下一個（Enter）")) + '">' + PR.icon("next", "sm") +
        '</button><button data-f="close" title="' + PR.esc(PR.t("关闭")) + '">' + PR.icon("x", "sm") + "</button>");
      PR.$("#pageview").append(bar);
      bar.addEventListener("input", (e) => searchSoon(e.target.value));
      bar.addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; b.dataset.f === "close" ? PR.closeFind() : go(b.dataset.f === "next" ? 1 : -1); });
      bar.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (e.isComposing) return; hits.length ? go(e.shiftKey ? -1 : 1) : search(e.target.value); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); PR.closeFind(); }
      });
    }
    const input = bar.querySelector("input");
    const sel = String(window.getSelection() || "").trim();
    if (sel && sel.length < 80 && !/\n/.test(sel)) { input.value = sel; search(sel); }  // 選著字按 ⌘F：直接找那個詞
    input.focus(); input.select();
    return true;
  };
  PR.closeFind = function () {
    if (!bar) return;
    token++;
    bar.remove(); bar = null;
    hits = []; cur = -1;
    (PR.pageNodes ? PR.pageNodes() : []).forEach((entry) => { if (entry.find) entry.find.innerHTML = ""; });
  };
  PR.on("pages-built", () => { hits = []; cur = -1; });
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "f" && !e.shiftKey && PR.openFind()) e.preventDefault();
    else if (k === "g" && bar) { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
  });
})(window.PR);
