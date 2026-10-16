/* 問 AI 的範圍：這份文件（預設）、這份所在的分類、整個文獻庫、挑幾份。範圍記在對話上（chat_store），一串對話一個範圍；
   新對話回到「這份文件」。範圍不是這份時，伺服器（libask.py）挑出相關幾份的全文筆記和幾頁原文給模型，
   回答裡的出處寫〔D3 p.5〕——寫到一半這裡就把它畫成連結（存的時候伺服器也換成連結），點了在旁邊打開那份文件的那一頁。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let items = null, loading = null;
  const load = () => loading || (loading = PR.api("/api/library").then((d) => (items = d.items || []), () => (items = [])));
  const tags = () => ((S.item || {}).tags || []).filter(Boolean);
  const others = () => (items || []).filter((i) => i.id !== PR.pid);
  const nameOf = (i) => i.title_en || i.title_zh || i.short_zh || PR.t("（未命名）");

  function count(scope) {
    if (!scope) return 1;
    if (scope.kind === "docs") return scope.ids.length + 1;
    if (!items) return null;
    if (scope.kind === "tag") return others().filter((i) => (i.tags || []).includes(scope.tag)).length + 1;
    return others().length + 1;
  }
  function label(scope) {
    if (!scope) return PR.t("這份文件");
    if (scope.kind === "all") return PR.t("整個文獻庫");
    if (scope.kind === "tag") return PR.t("分類「{tag}」", { tag: scope.tag });
    return PR.t("{n} 份文件", { n: scope.ids.length + 1 });
  }
  const ICON = (scope) => (!scope ? "page" : scope.kind === "tag" ? "folder" : scope.kind === "all" ? "layers" : "list");
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

  /* 輸入框底下那一顆：範圍不是這份文件時亮起來 */
  function button(st) {
    return '<button class="ch-scope' + (st.scope ? " on" : "") + (st.scopeOpen ? " open" : "") + '" data-c="scope"' + (st.streaming ? " disabled" : "") +
      ' title="' + PR.esc(PR.t("問的範圍：{what}", { what: label(st.scope) })) + '" aria-label="' + PR.esc(PR.t("問的範圍")) + '">' + PR.icon("layers", "sm") + "</button>";
  }
  /* 輸入框上面的標籤：「整個文獻庫 · 21」，× 回到這份文件 */
  function chip(st) {
    if (!st.scope) return "";
    const n = count(st.scope);
    return '<span class="chip-ctx scope" title="' + PR.esc(PR.t("這一問會看範圍裡的每一份（最相關的幾份看得最仔細），回答標出處")) + '">' + PR.icon(ICON(st.scope), "sm") +
      "<span>" + PR.esc(label(st.scope)) + (n && st.scope.kind !== "docs" ? " · " + n : "") + '</span><button data-c="unscope" title="' + PR.t("只問這份文件") + '">×</button></span>';
  }
  function menu(st) {
    if (!st.scopeOpen) return "";
    const row = (scope, icon, text, n, attrs) => '<button data-c="scope-set" ' + attrs + ' class="' + (same(st.scope, scope) ? "on" : "") + '">' + PR.icon(icon, "sm") +
      "<b>" + PR.esc(text) + "</b>" + (n != null ? "<small>" + n + "</small>" : "") + (same(st.scope, scope) ? '<span class="ch-model-check">✓</span>' : "") + "</button>";
    return '<div class="ch-menu ch-scope-menu"><div class="ch-menu-h">' + PR.t("問的範圍") + "</div>" +
      row(null, "page", PR.t("這份文件"), null, 'data-k="here"') +
      tags().map((t) => row({ kind: "tag", tag: t }, "folder", PR.t("分類「{tag}」", { tag: t }), count({ kind: "tag", tag: t }), 'data-k="tag" data-tag="' + PR.esc(t) + '"')).join("") +
      row({ kind: "all" }, "layers", PR.t("整個文獻庫"), count({ kind: "all" }), 'data-k="all"') +
      '<button data-c="scope-pick" class="' + (st.scope && st.scope.kind === "docs" ? "on" : "") + '">' + PR.icon("list", "sm") + "<b>" + PR.t("挑幾份…") + "</b>" +
      (st.scope && st.scope.kind === "docs" ? "<small>" + (st.scope.ids.length + 1) + "</small>" : "") + "</button></div>";
  }
  /* 挑幾份：一張清單（可以搜尋），這份文件一定在裡面 */
  function picker(st) {
    if (!st.scopePick) return "";
    const picked = new Set(st.scopePick.ids), q = (st.scopePick.q || "").toLowerCase();
    const rows = others().filter((i) => !q || (nameOf(i) + " " + (i.title_zh || "") + " " + (i.authors || "")).toLowerCase().includes(q));
    const one = (i) => '<label class="ch-pick-row"><input type="checkbox" data-pick="' + PR.esc(i.id) + '"' + (picked.has(i.id) ? " checked" : "") + ">" +
      '<span class="t">' + PR.esc(nameOf(i)) + '</span><span class="y">' + PR.esc(String(i.year || "")) + "</span></label>";
    return '<div class="ch-pick"><div class="ch-pick-h"><b>' + PR.t("一起問哪幾份") + '</b><span class="grow"></span><button data-c="scope-pick-x" title="' + PR.t("取消") + '">' + PR.icon("x", "sm") + "</button></div>" +
      '<label class="ch-find">' + PR.icon("search", "sm") + '<input type="search" data-c="scope-q" placeholder="' + PR.t("找文件") + '" value="' + PR.esc(st.scopePick.q || "") + '" autocomplete="off"></label>' +
      '<div class="ch-pick-list"><label class="ch-pick-row here"><input type="checkbox" checked disabled><span class="t">' + PR.esc(nameOf(S.item ? Object.assign({}, S.item, (S.paper || {}).meta) : {})) + '</span><span class="y">' + PR.t("這份") + "</span></label>" +
      (items ? rows.map(one).join("") || '<p class="hint">' + PR.t("沒有對得上的文件") + "</p>" : '<p class="hint">' + PR.t("加载中…") + "</p>") + "</div>" +
      '<div class="ch-pick-f"><span>' + PR.t("已選 {n} 份", { n: picked.size + 1 }) + '</span><span class="grow"></span><button class="btn sm accent" data-c="scope-pick-ok"' + (picked.size ? "" : " disabled") + ">" + PR.t("完成") + "</button></div></div>";
  }
  /* 點了範圍相關的東西：處理完回傳 true（chat.js 接著重畫） */
  function act(c, b, st) {
    if (c === "scope") { st.scopeOpen = !st.scopeOpen; st.menuOpen = st.listOpen = st.usageOpen = false; if (st.scopeOpen && !items) load().then(() => PR.chatRender && PR.chatRender()); return true; }
    if (c === "unscope") { st.scope = null; return true; }
    if (c === "scope-set") {
      const k = b.dataset.k;
      st.scope = k === "all" ? { kind: "all" } : k === "tag" ? { kind: "tag", tag: b.dataset.tag } : null;
      st.scopeOpen = false;
      return true;
    }
    if (c === "scope-pick") { st.scopeOpen = false; st.scopePick = { ids: st.scope && st.scope.kind === "docs" ? st.scope.ids.slice() : [], q: "" }; if (!items) load().then(() => PR.chatRender && PR.chatRender()); return true; }
    if (c === "scope-pick-x") { st.scopePick = null; return true; }
    if (c === "scope-pick-ok" && st.scopePick) { st.scope = st.scopePick.ids.length ? { kind: "docs", ids: st.scopePick.ids.slice(0, 79) } : null; st.scopePick = null; return true; }
    return false;
  }
  /* 勾選、搜尋：只改清單，不整個重畫（游標不跳） */
  document.addEventListener("change", (e) => {
    const box = e.target.closest && e.target.closest("#chatpanel [data-pick]");
    const st = PR.chatState && PR.chatState();
    if (!box || !st || !st.scopePick) return;
    const ids = new Set(st.scopePick.ids);
    if (box.checked) ids.add(box.dataset.pick); else ids.delete(box.dataset.pick);
    st.scopePick.ids = Array.from(ids);
    const f = PR.$("#chatpanel .ch-pick-f span"), ok = PR.$("#chatpanel [data-c=scope-pick-ok]");
    if (f) f.textContent = PR.t("已選 {n} 份", { n: ids.size + 1 });
    if (ok) ok.disabled = !ids.size;
  });
  document.addEventListener("input", (e) => {
    if (!(e.target.dataset && e.target.dataset.c === "scope-q")) return;
    const st = PR.chatState && PR.chatState();
    if (!st || !st.scopePick) return;
    st.scopePick.q = e.target.value;
    const q = e.target.value.trim().toLowerCase();
    PR.$$("#chatpanel .ch-pick-row:not(.here)").forEach((r) => { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); });
  });

  /* 回答裡的〔D3 p.5〕→ Markdown 連結（和伺服器 libask.link 一樣）；寫到一半就畫成連結，不會先露出代號再跳一下 */
  const CITE = /[〔[]\s*(D\d{1,3})((?:\s*[,，、;；]?\s*(?:p\.?|pp\.?|第)\s*\d{1,4}(?:\s*[-–~～]\s*\d{1,4})?\s*頁?)*)\s*[〕\]]/g;  // i18n-ok
  function cite(text, docs) {
    if (!docs || !text) return text;
    return text.replace(CITE, (m, code, pages) => {
      const d = docs[code];
      if (!d) return m;
      const name = String(d.who || "").replace(/[[\]]/g, "");
      const ps = Array.from(String(pages || "").matchAll(/(\d{1,4})(?:\s*[-–~～]\s*(\d{1,4}))?/g));
      if (!ps.length) return "[" + name + "](/read/" + d.id + ")";
      return ps.slice(0, 4).map((p) => "[" + name + " · p." + p[1] + (p[2] ? "–" + p[2] : "") + "](/read/" + d.id + "#page=" + p[1] + ")").join(" ");
    });
  }

  PR.chatScope = { button, chip, menu, picker, act, label, icon: ICON, cite, load };
})(window.PR);
