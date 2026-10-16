/* 比較表：勾幾篇（批量操作的「比較表」）或一個分類（側欄分類的選單）→ 文件 × 問題的一張表，AI 一篇一篇填，每一格附頁碼。
   - 欄：預設研究問題、方法、資料與實驗、主要結果、限制；可以拿掉，也可以打一個問題加一欄（加了就只填那一欄）。
   - 不會自己開始：按「開始填」才花模型額度。填好的一列馬上出現；頁碼點了打開那份文件的那一頁。
   - 結果記在這台的瀏覽器裡（同一組文件再打開時直接看到），可以複製成 Markdown 或存成一份獨立筆記（表格＋出處連結）。
   伺服器：POST /api/matrix（matrix.py），串流，一份一列。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const DEFAULT = () => [
    { name: PR.t("研究問題"), ask: PR.t("要解決什麼問題、為什麼重要") },
    { name: PR.t("方法"), ask: PR.t("核心做法：方法名稱、關鍵設計") },
    { name: PR.t("資料與實驗"), ask: PR.t("用了哪些資料集、模型、實驗設定") },
    { name: PR.t("主要結果"), ask: PR.t("最重要的數字和結論") },
    { name: PR.t("限制"), ask: PR.t("作者承認的或明顯的限制、還沒解決的地方") },
  ];
  let st = null, wrap = null;
  const KEY = (ids) => "easyread-matrix:" + ids.slice().sort().join(",");
  // 出處的名字：第一作者的姓＋年份（Karan 2026）；沒有作者用短標題（投影片檔名的「Microsoft PowerPoint -」「- Copy」拿掉，同 libask.py）
  const JUNK = /^(microsoft (powerpoint|word)|powerpoint presentation|untitled)\s*[-–:]?\s*|\s*[-–]\s*copy$|\.(pptx?|docx?|pdf)$/i;
  const who = (i) => {
    const first = String(i.authors || "").split(/,|，| and |;/)[0].trim(), last = first ? first.split(/\s+/).pop() : "";  // i18n-ok
    if (last && !/\d/.test(last)) return (last + " " + (i.year || "")).trim();
    let t = String(i.title_en || i.short_zh || i.title_zh || "");
    for (let k = 0; k < 3; k++) t = t.replace(JUNK, "").trim();
    return t.replace(/_/g, " ").split(/\s+/).slice(0, 4).join(" ").slice(0, 28) || String(i.short_zh || "").slice(0, 16);
  };
  const title = (i) => i.title_en || i.title_zh || PR.t("（未命名）");
  const save = () => { try { PR.ls.set(KEY(st.items.map((i) => i.id)), { columns: st.columns, rows: st.rows, model: st.model, at: Date.now() }); } catch (e) { /* 存不了就算了 */ } };

  /* papers：要比較的文件（library 清單裡的項目）；name：從哪裡來（分類名），筆記標題用 */
  L.openMatrix = function (papers, name) {
    const items = (papers || []).filter((i) => i && i.id).slice(0, 30);
    if (items.length < 2) return PR.toast(PR.t("至少挑兩份來比較"));
    const kept = PR.ls.get(KEY(items.map((i) => i.id)), null) || {};
    st = { items, name: name || "", columns: Array.isArray(kept.columns) && kept.columns.length ? kept.columns : DEFAULT(), rows: kept.rows || {}, errors: {}, busy: new Set(), model: kept.model || "", ctrl: null };
    if (!wrap) {
      wrap = PR.el("div", { class: "mx-wrap", role: "dialog", "aria-modal": "true" });
      document.body.append(wrap);
      wrap.addEventListener("click", onClick);
      wrap.addEventListener("keydown", onKey);
    }
    render();
    wrap.classList.add("open");
    setTimeout(() => { const b = wrap.querySelector("[data-mx=run]"); if (b) b.focus(); }, 60);
  };
  function close() {
    if (st && st.ctrl) st.ctrl.abort();
    if (wrap) wrap.classList.remove("open");
  }

  /* ---------- 畫 ---------- */
  const filled = () => st.items.filter((i) => st.rows[i.id] && st.columns.every((c) => st.rows[i.id][c.name])).length;
  function cellHtml(i, c) {
    const cell = (st.rows[i.id] || {})[c.name];
    if (!cell) {
      if (st.busy.has(i.id + "\u0000" + c.name)) return '<td class="mx-c busy"><span class="mx-dots"><i></i><i class="d2"></i><i class="d3"></i></span></td>';
      return '<td class="mx-c empty">' + (st.errors[i.id] ? '<span class="mx-err" title="' + PR.esc(st.errors[i.id]) + '">' + PR.icon("alert", "sm") + "</span>" : "") + "</td>";
    }
    const none = /^(未提及|未提到|沒有提到|not mentioned)/i.test(cell.text || "");  // i18n-ok
    const pages = (cell.pages || []).map((p) => '<a class="mx-pg" href="/read/' + PR.esc(i.id) + "#page=" + p + '" title="' + PR.esc(PR.t("打開第 {page} 頁", { page: p })) + '">p.' + p + "</a>").join("");
    return '<td class="mx-c' + (none ? " none" : "") + '"><span class="mx-t">' + PR.esc(cell.text || "") + "</span>" + (pages ? '<span class="mx-pgs">' + pages + "</span>" : "") + "</td>";
  }
  function render() {
    if (!wrap || !st) return;
    const running = !!st.ctrl, done = filled(), total = st.items.length;
    const head = '<div class="mx-head"><span class="mx-ic">' + PR.icon("table", "sm") + '</span><b>' + PR.esc(st.name ? PR.t("比較表 · {name}", { name: st.name }) : PR.t("比較表")) + "</b>" +
      '<span class="mx-sub">' + PR.esc(PR.t("{n} 份", { n: total })) + "</span><span class=\"grow\"></span>" +
      '<button class="mx-ib" data-mx="copy" title="' + PR.t("複製成 Markdown 表格") + '"' + (done || Object.keys(st.rows).length ? "" : " disabled") + ">" + PR.icon("copy", "sm") + "</button>" +
      '<button class="mx-ib" data-mx="note" title="' + PR.t("存成筆記（表格和出處連結）") + '"' + (Object.keys(st.rows).length ? "" : " disabled") + ">" + PR.icon("notebook", "sm") + "</button>" +
      '<button class="mx-ib" data-mx="close" title="' + PR.t("关闭") + '">' + PR.icon("x", "sm") + "</button></div>";
    const cols = '<div class="mx-cols">' + st.columns.map((c, k) => '<span class="mx-col" title="' + PR.esc(c.ask || c.name) + '">' + PR.esc(c.name) +
      (running ? "" : '<button data-mx="drop" data-k="' + k + '" title="' + PR.t("拿掉這一欄") + '">×</button>') + "</span>").join("") +
      (st.columns.length < 10 ? '<label class="mx-add">' + PR.icon("plus", "sm") + '<input data-mx="add" placeholder="' + PR.t("加一欄：打一個問題，例如「有沒有用強化學習？」") + '"' + (running ? " disabled" : "") + "></label>" : "") + "</div>";
    const table = '<div class="mx-scroll"><table class="mx"><thead><tr><th class="mx-doc">' + PR.t("文件") + "</th>" + st.columns.map((c) => "<th>" + PR.esc(c.name) + "</th>").join("") + "</tr></thead><tbody>" +
      st.items.map((i) => '<tr><th class="mx-doc"><a href="/read/' + PR.esc(i.id) + '" class="mx-who">' + PR.esc(who(i)) + '</a><span class="mx-title">' + PR.esc(title(i)) + "</span></th>" +
        st.columns.map((c) => cellHtml(i, c)).join("") + "</tr>").join("") + "</tbody></table></div>";
    const missing = st.items.filter((i) => st.columns.some((c) => !(st.rows[i.id] || {})[c.name])).length;
    const foot = '<div class="mx-foot"><span class="mx-state">' + (running ? '<span class="spin"></span>' + PR.esc(PR.t("正在填：{done}／{n} 份", { done, n: total })) :
      done === total ? PR.esc(PR.t("填好了 · {model}", { model: st.model || "AI" })) : PR.esc(PR.t("每份請 AI 讀一次（用預讀筆記和相關的幾頁），大約一份十幾秒"))) + '</span><span class="grow"></span>' +
      (running ? '<button class="btn sm line" data-mx="stop">' + PR.t("停止") + "</button>"
        : missing ? '<button class="btn sm accent" data-mx="run">' + PR.icon("sparkle", "sm") + (Object.keys(st.rows).length ? PR.t("填完剩下的") : PR.t("開始填")) + "</button>" : "") + "</div>";
    wrap.innerHTML = '<div class="mx-sheet">' + head + cols + table + foot + "</div>";
  }

  /* ---------- 填 ---------- */
  async function run(onlyCols) {
    if (st.ctrl) return;
    const cols = onlyCols || st.columns;
    const ids = st.items.filter((i) => cols.some((c) => !(st.rows[i.id] || {})[c.name])).map((i) => i.id);
    if (!ids.length) return;
    const want = cols.filter((c) => ids.some((id) => !(st.rows[id] || {})[c.name]));
    ids.forEach((id) => want.forEach((c) => st.busy.add(id + "\u0000" + c.name)));
    ids.forEach((id) => delete st.errors[id]);
    const ctrl = new AbortController();
    st.ctrl = ctrl;
    render();
    try {
      const res = await fetch("/api/matrix", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" }, body: JSON.stringify({ ids, columns: want }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.model) st.model = ev.model;
          if (ev.row) {
            want.forEach((c) => st.busy.delete(ev.row + "\u0000" + c.name));
            if (ev.error) st.errors[ev.row] = ev.error;
            else st.rows[ev.row] = Object.assign({}, st.rows[ev.row] || {}, ev.cells || {});
            save();
            if (st.ctrl === ctrl) render();
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") PR.toast(PR.t("比較表沒填完：{msg}", { msg: PR.esc(e.message) }));
    }
    st.busy.clear();
    if (st.ctrl === ctrl) st.ctrl = null;
    save();
    render();
  }

  /* ---------- 輸出 ---------- */
  const cellMd = (i, c, links) => {
    const cell = (st.rows[i.id] || {})[c.name];
    if (!cell) return "";
    const text = String(cell.text || "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
    const pages = (cell.pages || []).map((p) => (links ? "[p." + p + "](/read/" + i.id + "#page=" + p + ")" : "p." + p)).join(" ");
    return text + (pages ? " " + pages : "");
  };
  function markdown(links) {
    const esc = (s) => String(s).replace(/\|/g, "\\|");
    const head = "| " + [PR.t("文件")].concat(st.columns.map((c) => esc(c.name))).join(" | ") + " |";
    const rule = "| " + ["---"].concat(st.columns.map(() => "---")).join(" | ") + " |";
    const rows = st.items.map((i) => "| " + [(links ? "[" + esc(who(i)) + "](/read/" + i.id + ")" : esc(who(i))) + " " + esc(title(i)).slice(0, 60)].concat(st.columns.map((c) => cellMd(i, c, links))).join(" | ") + " |");
    return [head, rule].concat(rows).join("\n");
  }
  async function toNote() {
    const name = st.name ? PR.t("比較表：{name}", { name: st.name }) : PR.t("比較表：{n} 份文件", { n: st.items.length });
    const body = markdown(true) + "\n\n" + PR.t("（AI 根據每份的預讀筆記和相關頁面填的，數字和說法請點頁碼對照原文。）") + "\n";
    try {
      const n = await PR.api("/api/notes", { method: "POST", body: { title: name, body, papers: st.items.map((i) => i.id) } });
      if (PR.notesChanged) PR.notesChanged();
      if (L.loadNotes) L.loadNotes(true);
      PR.toast(PR.t("已存成筆記「{t}」", { t: PR.esc(name) }), { label: PR.t("打開"), fn: () => { close(); PR.navigate("/note/" + n.id); } }, 5200);
    } catch (e) { PR.toast(PR.t("沒存成：{msg}", { msg: PR.esc(e.message) })); }
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    if (e.target === wrap) return close();  // 點外面
    const b = e.target.closest("[data-mx]");
    const pg = e.target.closest("a.mx-pg, a.mx-who");
    if (pg) { e.preventDefault(); e.stopPropagation(); return PR.navigate(pg.getAttribute("href")); }
    if (!b) return;
    const k = b.dataset.mx;
    if (k === "close") return close();
    if (k === "run") return run();
    if (k === "stop") { if (st.ctrl) st.ctrl.abort(); return; }
    if (k === "drop") { st.columns.splice(+b.dataset.k, 1); save(); return render(); }
    if (k === "copy") { navigator.clipboard.writeText(markdown(false)).then(() => PR.toast(PR.t("已複製表格")), () => PR.toast(PR.t("沒複製成"))); return; }
    if (k === "note") return toNote();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); return close(); }
    if (e.key === "Enter" && e.target.dataset && e.target.dataset.mx === "add" && !e.isComposing) {
      const q = e.target.value.trim().slice(0, 60);
      if (!q) return;
      if (st.columns.some((c) => c.name === q)) return PR.toast(PR.t("已經有這一欄了"));
      const col = { name: q, ask: "" };
      st.columns.push(col);
      save();
      render();
      if (Object.keys(st.rows).length) run([col]);  // 已經填過的表：只填這一欄
      setTimeout(() => { const i = wrap.querySelector("[data-mx=add]"); if (i && !i.disabled) i.focus(); }, 30);
    }
  }
})(window.PR);
