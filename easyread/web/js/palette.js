/* 快速開啟（⌘K、⌘T；外殼才有）：打幾個字，跳到開著的分頁、任何一份文件或筆記，或做一件事；
   標題對不到的，還會到所有文件的內文、文件上自己寫的筆記、獨立筆記裡找（伺服器的 /api/search），結果直接開到那一頁、把那個詞標出來。
   - 鍵盤叫出來的東西不做開合動畫：一天按上百次，動畫只會讓它變慢。↑↓ 選、Enter 開、⌘Enter 在旁邊並排開、Esc 關。
   - 清單的資料：開的時候跟伺服器要一次（文件、筆記各一份），上一次的先拿來用，不用等。
   PR.paletteRank 是純函式（tests/test_palette.cjs）。 */
(function (PR) {
  "use strict";
  /* q 的每個詞都要出現在這一筆裡；分數：標題開頭 > 標題裡某個詞的開頭 > 標題中間 > 其他欄位（作者、分類…）。對不上回 -1 */
  PR.paletteRank = function (q, title, extra) {
    const terms = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return 0;
    const t = String(title || "").toLowerCase(), x = String(extra || "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      const i = t.indexOf(term);
      if (i === 0) score += 100;
      else if (i > 0) score += /[\s\-_:：，、（(／/·]/.test(t[i - 1]) ? 70 : 50;
      else if (x.includes(term)) score += 15;
      else return -1;
    }
    return score - Math.min(20, t.length / 12);  // 一樣對得上的，標題短的在前
  };
  if (typeof document === "undefined" || !PR.shell) return;

  const S = PR.shell;
  const MAX = 7;  // 每一段最多列幾筆
  let box = null, input = null, list = null, rows = [], sel = 0, moved = false;
  let data = { papers: [], notes: [] }, hits = [], hitsFor = "", seq = 0, timer = 0;
  const dark = () => document.documentElement.dataset.theme === "dark";
  const paperTitle = (p) => p.title_en || p.title_zh || p.short_zh || p.id;  // 和主頁卡片一樣：原文標題
  const noteTitle = (n) => n.title || PR.t("未命名筆記");
  const noteIcon = (n) => (PR.tintIcon ? PR.tintIcon(n.icon, n.color, PR.hasIcon("notes") ? "notes" : "notebook") : PR.icon("notebook", "sm"));
  const byTime = (k1, k2) => (a, b) => String(b[k1] || b[k2] || "").localeCompare(String(a[k1] || a[k2] || ""));

  async function load() {
    try {
      const [lib, notes] = await Promise.all([PR.api("/api/library"), PR.api("/api/notes")]);
      data = { papers: lib.items || [], notes: notes.items || [] };
      PR.token = lib.token || notes.token || PR.token;  // 外殼自己沒有權杖：建筆記、存主題要用
      if (box) render();
    } catch (e) { /* 連不上：用上一次的 */ }
  }

  /* ---------- 可以做的事 ---------- */
  async function newNote() {
    try {
      const n = await PR.api("/api/notes", { method: "POST", body: {} });
      S.changed();
      S.open("/note/" + n.id, "");
    } catch (e) { PR.toast(PR.t("沒建成：{msg}", { msg: PR.esc(e.message) })); }
  }
  function settings() {
    S.home();
    let n = 0;
    const t = setInterval(() => {  // 文獻庫那一格可能這時候才載入
      const w = S.lib();
      if (w && w.PR && w.PR.openSettings) { clearInterval(t); w.PR.openSettings(); } else if (++n > 40) clearInterval(t);
    }, 100);
  }
  const acts = () => [
    { title: PR.t("新筆記"), icon: "plus", words: "new note 新增 建立 筆記", run: newNote },  // i18n-ok 搜尋用的關鍵字，不顯示
    { title: PR.t("分割視窗"), icon: "panel", kbd: PR.kbd("⌘\\"), words: "split 並排 分割", run: () => S.split() },  // i18n-ok
    { title: dark() ? PR.t("换成浅色") : PR.t("换成深色"), icon: dark() ? "sun" : "moon", words: "theme dark light 主題 外觀 深色 淺色", run: () => PR.toggleTheme && PR.toggleTheme() },  // i18n-ok
    { title: PR.t("设置"), icon: "gear", words: "settings preferences 設定 偏好 模型", run: settings },  // i18n-ok
    S.closed() ? { title: PR.t("重新開啟關掉的分頁"), icon: "redo", kbd: PR.kbd("⌘⇧T"), words: "reopen closed tab 復原", run: () => S.reopen() } : null,  // i18n-ok
  ].filter(Boolean);

  /* ---------- 這一輪要列什麼 ---------- */
  function build(q) {
    const out = [], tabs = S.tabs(), open = new Set(tabs.map((t) => t.doc).filter(Boolean));
    const sec = (name, list) => { if (list.length) { out.push({ sec: name }); list.forEach((x) => out.push(x)); } };
    const tabRow = (t) => ({ title: t.title, icon: PR.icon(t.kind === "library" ? "folder" : t.kind === "note" ? "notebook" : "book", "sm"), hint: PR.t("已開啟"), run: (beside) => (beside && t.doc ? S.open(t.url, t.title, true) : S.show(t.id)) });
    const paperRow = (p) => ({ title: paperTitle(p), sub: [String(p.authors || "").split(/[,;，、]/).slice(0, 2).join(", "), p.year].filter(Boolean).join(" · "), icon: PR.icon(p.kind === "slides" ? "page" : "book", "sm"),
      hint: open.has(p.id) ? PR.t("已開啟") : "", url: "/read/" + p.id, run: (beside) => S.open("/read/" + p.id, p.short_zh || paperTitle(p), beside) });
    const noteRow = (n) => ({ title: noteTitle(n), sub: n.folder || "", icon: noteIcon(n), hint: open.has(n.id) ? PR.t("已開啟") : "", url: "/note/" + n.id, run: (beside) => S.open("/note/" + n.id, noteTitle(n), beside) });
    if (!q) {  // 還沒打字：別的分頁、最近看的
      sec(PR.t("分頁"), tabs.filter((t) => !t.on).slice(0, MAX).map(tabRow));
      sec(PR.t("最近"), data.papers.filter((p) => !open.has(p.id)).sort(byTime("last_opened", "added")).slice(0, 5).map(paperRow)
        .concat(data.notes.filter((n) => !open.has(n.id)).sort(byTime("updated", "created")).slice(0, 3).map(noteRow)));
      sec(PR.t("動作"), acts());
      return out;
    }
    const top = (list, score, row) => list.map((x) => [score(x), x]).filter((x) => x[0] >= 0).sort((a, b) => b[0] - a[0]).slice(0, MAX).map((x) => row(x[1]));
    sec(PR.t("分頁"), top(tabs.filter((t) => !t.on && t.kind !== "library"), (t) => PR.paletteRank(q, t.title, ""), tabRow));
    sec(PR.t("文件"), top(data.papers.filter((p) => !tabs.some((t) => !t.on && t.doc === p.id)), (p) => PR.paletteRank(q, paperTitle(p), [p.title_en, p.short_zh, p.authors, p.venue, p.year, (p.tags || []).join(" ")].join(" ")), paperRow));
    sec(PR.t("筆記"), top(data.notes.filter((n) => !tabs.some((t) => !t.on && t.doc === n.id)), (n) => PR.paletteRank(q, noteTitle(n), [n.folder, n.preview].join(" ")), noteRow));
    sec(PR.t("動作"), top(acts(), (a) => PR.paletteRank(q, a.title, a.words), (a) => a));
    if (hitsFor === q) sec(PR.t("內文"), hits);
    return out;
  }
  /* 內文裡找到的：一筆一列，開到那一頁、把那個詞標出來 */
  function hitRows(res, q) {
    const out = [];
    for (const r of res) {
      const doc = r.kind === "note" ? data.notes.find((n) => n.id === r.id) : data.papers.find((p) => p.id === r.id);
      if (!doc) continue;
      const title = r.kind === "note" ? noteTitle(doc) : paperTitle(doc);
      for (const h of r.hits.slice(0, r.kind === "note" ? 1 : 2)) {
        const s = String(h.snippet || ""), a = h.mark ? h.mark[0] : 0, b = h.mark ? h.mark[1] : 0;
        const url = r.kind === "note" ? "/note/" + r.id : "/read/" + r.id + "#" + (h.page ? "page=" + h.page + "&" : "") + "find=" + encodeURIComponent(q);
        out.push({ title, where: h.page ? PR.t("第 {page} 页", { page: h.page }) + (h.where === "note" ? " · " + PR.t("我的筆記") : "") : "",
          snip: PR.esc(s.slice(0, a)) + "<mark>" + PR.esc(s.slice(a, b)) + "</mark>" + PR.esc(s.slice(b)), icon: r.kind === "note" ? noteIcon(doc) : PR.icon("quote", "sm"),
          run: (beside) => S.open(url, r.kind === "note" ? title : doc.short_zh || title, beside) });
      }
      if (out.length >= 10) break;
    }
    return out;
  }
  function searchSoon(q) {
    clearTimeout(timer);
    if (q.length < 2) { hits = []; hitsFor = ""; return; }
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const r = await PR.api("/api/search?q=" + encodeURIComponent(q) + "&limit=8");
        if (mine !== seq || !box || input.value.trim() !== q) return;
        hits = hitRows(r.results || [], q); hitsFor = q;
        render(true);
      } catch (e) { /* 找不到就只列標題對得上的 */ }
    }, 180);
  }

  /* ---------- 畫 ---------- */
  function render(keep) {
    const q = input.value.trim();
    const all = build(q);
    rows = all.filter((x) => !x.sec);
    if (!keep) sel = 0;
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    let i = -1;
    list.innerHTML = all.length ? all.map((x) => {
      if (x.sec) return '<div class="pal-sec">' + PR.esc(x.sec) + "</div>";
      i++;
      return '<div class="pal-row' + (i === sel ? " on" : "") + (x.snip ? " hit" : "") + '" data-i="' + i + '" role="option" aria-selected="' + (i === sel) + '"><span class="pal-ic">' + (/^</.test(x.icon || "") ? x.icon : PR.icon(x.icon || "book", "sm")) + "</span>" +
        '<span class="pal-main"><span class="pal-t">' + PR.esc(x.title) + (x.where ? "<i>" + PR.esc(x.where) + "</i>" : "") + "</span>" + (x.snip ? '<span class="pal-s">' + x.snip + "</span>" : x.sub ? '<span class="pal-s">' + PR.esc(x.sub) + "</span>" : "") + "</span>" +
        (x.kbd ? '<span class="pal-hint kbd">' + PR.esc(x.kbd) + "</span>" : x.hint ? '<span class="pal-hint">' + PR.esc(x.hint) + "</span>" : "") + "</div>";
    }).join("") : '<div class="pal-none">' + (q ? PR.t("找不到「{q}」", { q: PR.esc(q) }) : PR.t("還沒有文件")) + "</div>";
    if (!keep) list.scrollTop = 0;
  }
  function pick(n) {
    if (!rows.length) return;
    sel = (n + rows.length) % rows.length;
    PR.$$(".pal-row", list).forEach((el) => { const on = +el.dataset.i === sel; el.classList.toggle("on", on); el.setAttribute("aria-selected", String(on)); if (on) el.scrollIntoView({ block: "nearest" }); });
  }
  function run(beside) {
    const r = rows[sel];
    if (!r) return;
    close(true);
    r.run(!!beside);
  }

  /* ---------- 開關 ---------- */
  function open() {
    if (box) return;
    if (PR.closeMenu) PR.closeMenu();
    box = PR.el("div", { id: "palette" }, '<div class="pal" role="dialog" aria-label="' + PR.esc(PR.t("快速開啟")) + '"><label class="pal-in">' + PR.icon("search", "sm") +
      '<input type="text" spellcheck="false" autocomplete="off" placeholder="' + PR.esc(PR.t("搜尋文件、筆記，或內文裡的字")) + '"></label><div class="pal-list" role="listbox"></div></div>');
    document.body.append(box);
    input = box.querySelector("input"); list = box.querySelector(".pal-list");
    hits = []; hitsFor = ""; moved = false;
    input.addEventListener("input", () => { const q = input.value.trim(); if (hitsFor !== q) { hits = []; hitsFor = ""; } render(); searchSoon(q); });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;  // 選字中的 Enter、方向鍵是輸入法的
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { e.preventDefault(); pick(sel + 1); }
      else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { e.preventDefault(); pick(sel - 1); }
      else if (e.key === "Enter") { e.preventDefault(); run(e.metaKey || e.ctrlKey); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    box.addEventListener("mousedown", (e) => { if (e.target === box) { e.preventDefault(); close(); } });
    list.addEventListener("mousemove", (e) => { const r = e.target.closest(".pal-row"); if (!r) return; if (!moved) { moved = true; return; } if (+r.dataset.i !== sel) pick(+r.dataset.i); });  // 第一下不算：清單剛好畫在游標底下而已
    list.addEventListener("click", (e) => { const r = e.target.closest(".pal-row"); if (!r) return; sel = +r.dataset.i; run(e.metaKey || e.ctrlKey); });
    render();
    input.focus();
    load();
  }
  function close(acting) {
    if (!box) return;
    clearTimeout(timer); seq++;
    box.remove(); box = input = list = null; rows = [];
    if (!acting) S.refocus();  // 沒有要去哪裡：焦點還給剛才那一格
  }
  PR.palette = { open, close, toggle: () => (box ? close() : open()), isOpen: () => !!box };
  load();
})(window.PR);
