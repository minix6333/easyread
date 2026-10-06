/* 外殼：一個視窗裡開好幾份文件，上面一排分頁切換；可以分割成兩三格並排看（每格一個分頁），格子之間拖寬度。
   - 第一個分頁永遠是文獻庫（/library）；在文獻庫裡點一篇，就在這裡開成新分頁（frame-bridge.js 把連結轉過來）。
   - 每個分頁是一個 iframe（/read/<id>），切走的只是藏起來，捲到哪、問到哪都還在；關閉分頁才卸掉。
   - 分割：工具列的分割鍵（或 ⌘\）：有還沒顯示的分頁就把它擺到新的一格，沒有就把目前這份再開一份並排（比對兩頁時用）。
   - 哪些分頁開著、怎麼分割都記著（localStorage），下次開 App 原樣回來；分頁用到才載入。
   - 快捷鍵：⌘1–9 切分頁，⌘⇧[ ] 上一個／下一個，⌘\ 分割。
   PR.shellModel 是純函式（tests/test_shell.cjs）。 */
(function (PR) {
  "use strict";
  const KEY = "easyread-shell";
  const LIB = "lib";
  const paperOf = (url) => { const m = /^\/read\/([^/?#]+)/.exec(url || ""); return m ? m[1] : null; };

  /* ---------- 狀態的純操作：st = {tabs:[{id, kind, url, title}], panes:[{tab, w}], focus, seq} ---------- */
  const M = (PR.shellModel = {
    blank: () => ({ tabs: [{ id: LIB, kind: "library", url: "/library", title: "" }], panes: [{ tab: LIB, w: 1 }], focus: 0, seq: 0 }),
    paneOf: (st, tabId) => st.panes.findIndex((p) => p.tab === tabId),
    focused: (st) => st.panes[st.focus] || st.panes[0],
    /* 開一份：已經開著（同一篇）就切過去；不然加在目前分頁後面。在文獻庫那一格點的、而且還有別格 → 開到別格（文獻庫留著看） */
    open(st, url, title) {
      const pid = paperOf(url);
      let tab = pid ? st.tabs.find((t) => paperOf(t.url) === pid) : null;
      if (!tab) {
        tab = { id: "t" + ++st.seq, kind: "paper", url, title: title || "" };
        const cur = M.focused(st).tab, at = st.tabs.findIndex((t) => t.id === cur);
        st.tabs.splice(at < 0 ? st.tabs.length : at + 1, 0, tab);
      } else if (url && (url.includes("#") || url.length > tab.url.length) && tab.url !== url) tab.url = url;  // 帶了段落錨點：換成新的
      let pane = st.focus;
      const shownAt = M.paneOf(st, tab.id);
      if (shownAt >= 0) pane = shownAt;
      else if (M.focused(st).tab === LIB && st.panes.length > 1) pane = st.panes.findIndex((p) => p.tab !== LIB);
      if (pane < 0) pane = st.focus;
      st.panes[pane].tab = tab.id;
      st.focus = pane;
      return tab;
    },
    show(st, tabId, pane) {
      if (!st.tabs.some((t) => t.id === tabId)) return;
      const at = M.paneOf(st, tabId);
      if (at >= 0) { st.focus = at; return; }  // 已經在某一格：只是把焦點移過去
      const i = pane == null ? st.focus : pane;
      st.panes[i].tab = tabId;
      st.focus = i;
    },
    close(st, tabId) {
      if (tabId === LIB) return;
      const i = st.tabs.findIndex((t) => t.id === tabId);
      if (i < 0) return;
      st.tabs.splice(i, 1);
      st.panes.forEach((p) => {
        if (p.tab !== tabId) return;
        // 這一格改顯示鄰近的、而且沒在別格顯示的分頁；沒有就文獻庫
        const shown = new Set(st.panes.filter((x) => x !== p).map((x) => x.tab));
        const pick = [st.tabs[i - 1], st.tabs[i]].concat(st.tabs).find((t) => t && !shown.has(t.id));
        p.tab = pick ? pick.id : LIB;
      });
      // 兩格顯示同一個分頁沒意義：多的那格收掉
      for (let k = st.panes.length - 1; k > 0 && st.panes.length > 1; k--) if (st.panes.slice(0, k).some((p) => p.tab === st.panes[k].tab)) M.closePane(st, k);
    },
    split(st) {
      if (st.panes.length >= 3) return null;
      const shown = new Set(st.panes.map((p) => p.tab));
      const cur = M.focused(st), at = st.tabs.findIndex((t) => t.id === cur.tab);
      const order = st.tabs.slice(at + 1).concat(st.tabs.slice(0, at));
      let tab = order.find((t) => !shown.has(t.id) && t.id !== LIB) || order.find((t) => !shown.has(t.id));  // 先找別的文件，最後才輪到文獻庫
      if (!tab) {  // 全都顯示著：把目前這份再開一份並排
        const src = st.tabs[at] || st.tabs[0];
        tab = { id: "t" + ++st.seq, kind: src.kind, url: src.url, title: src.title };
        st.tabs.splice(at + 1, 0, tab);
      }
      st.panes.splice(st.focus + 1, 0, { tab: tab.id, w: 1 });
      st.panes.forEach((p) => (p.w = 1 / st.panes.length));
      st.focus += 1;
      return tab;
    },
    closePane(st, i) {
      if (st.panes.length <= 1) return;
      st.panes.splice(i, 1);
      const total = st.panes.reduce((a, p) => a + p.w, 0) || 1;
      st.panes.forEach((p) => (p.w = p.w / total));
      st.focus = Math.max(0, Math.min(st.focus >= i ? st.focus - 1 : st.focus, st.panes.length - 1));
    },
    move(st, tabId, before) {  // 拖排順序：放到 before 這個分頁前面（null＝最後）；文獻庫永遠第一個
      if (tabId === LIB || tabId === before) return;
      const t = st.tabs.find((x) => x.id === tabId);
      if (!t) return;
      st.tabs = st.tabs.filter((x) => x.id !== tabId);
      let i = before ? st.tabs.findIndex((x) => x.id === before) : st.tabs.length;
      if (i < 1) i = 1;
      st.tabs.splice(i, 0, t);
    },
    step(st, dir) {  // 上一個／下一個分頁（在目前這一格）
      const cur = M.focused(st).tab, at = st.tabs.findIndex((t) => t.id === cur);
      const n = st.tabs.length;
      for (let k = 1; k < n; k++) {
        const t = st.tabs[((at + dir * k) % n + n) % n];
        if (M.paneOf(st, t.id) < 0) { st.panes[st.focus].tab = t.id; return t; }
      }
      return null;
    },
  });
  if (typeof document === "undefined" || !document.getElementById("tabs")) return;

  /* ---------- 存取 ---------- */
  function load() {
    const saved = PR.ls.get(KEY, null);
    const st = M.blank();
    if (saved && Array.isArray(saved.tabs)) {
      const tabs = saved.tabs.filter((t) => t && t.id && t.kind === "paper" && paperOf(t.url)).map((t) => ({ id: String(t.id), kind: "paper", url: String(t.url), title: String(t.title || "") }));
      st.tabs = st.tabs.concat(tabs);
      st.seq = Number(saved.seq) || tabs.length;
      const ids = new Set(st.tabs.map((t) => t.id));
      const panes = (Array.isArray(saved.panes) ? saved.panes : []).filter((p) => p && ids.has(p.tab)).map((p) => ({ tab: p.tab, w: Number(p.w) > 0 ? Number(p.w) : 1 }));
      const seen = new Set();
      st.panes = panes.filter((p) => !seen.has(p.tab) && seen.add(p.tab)).slice(0, 3);
      if (!st.panes.length) st.panes = [{ tab: LIB, w: 1 }];
      st.focus = Math.max(0, Math.min(Number(saved.focus) || 0, st.panes.length - 1));
    }
    return st;
  }
  const st = load();
  const save = () => PR.ls.set(KEY, { tabs: st.tabs.filter((t) => t.kind === "paper"), panes: st.panes, focus: st.focus, seq: st.seq });

  /* ---------- iframe ---------- */
  const frames = {};  // tab id → iframe
  const framesBox = PR.$("#frames");
  function frame(tab) {
    let f = frames[tab.id];
    if (f) return f;
    f = document.createElement("iframe");
    f.src = tab.url;
    f.title = tab.title || tab.id;
    f.className = "hidden";
    framesBox.append(f);
    frames[tab.id] = f;
    return f;
  }
  function tabOfSource(src) {
    return st.tabs.find((t) => frames[t.id] && frames[t.id].contentWindow === src) || null;
  }

  /* ---------- 畫 ---------- */
  const tabsEl = PR.$("#tabs"), panesEl = PR.$("#panes");
  const tabTitle = (t) => (t.kind === "library" ? PR.t("文獻庫") : t.title || paperOf(t.url) || "");
  function renderTabs() {
    const shown = new Set(st.panes.map((p) => p.tab)), cur = M.focused(st).tab;
    tabsEl.innerHTML = st.tabs.map((t) => '<div class="tab' + (t.id === cur ? " on" : "") + (shown.has(t.id) ? " shown" : "") + (t.kind === "library" ? " lib" : "") + '" data-tab="' + PR.esc(t.id) + '" role="tab" aria-selected="' + (t.id === cur) + '"' +
      (t.kind === "paper" ? ' draggable="true"' : "") + ' title="' + PR.esc(tabTitle(t)) + '">' + PR.icon(t.kind === "library" ? "folder" : "book", "sm") +
      (t.kind === "library" ? "" : '<span class="tt">' + PR.esc(tabTitle(t)) + '</span><button class="x" data-x="' + PR.esc(t.id) + '" title="' + PR.t("关闭") + '">' + PR.icon("x", "sm") + "</button>") + "</div>").join("") +
      '<span class="grow"></span>' + (st.panes.length > 1 ? '<button class="btn icon" data-act="closepane" title="' + PR.t("收起這一格") + '">' + PR.icon("x", "sm") + "</button>" : "") +
      '<button class="btn icon" data-act="split" title="' + PR.t("分割視窗：並排再開一格（⌘\\）") + '"' + (st.panes.length >= 3 ? " disabled" : "") + ">" + PR.icon("panel", "sm") + "</button>";
    document.title = (cur === LIB ? "" : tabTitle(st.tabs.find((t) => t.id === cur) || {}) + " · ") + "EasyRead";
  }
  function renderPanes() {
    document.body.classList.toggle("split", st.panes.length > 1);
    panesEl.innerHTML = st.panes.map((p, i) => (i ? '<div class="gap" data-gap="' + i + '"></div>' : "") +
      '<div class="pane' + (i === st.focus ? " on" : "") + '" data-pane="' + i + '" style="flex-grow:' + (p.w * 1000).toFixed(0) + '"></div>').join("");
    layout();
  }
  /* 把每一格的 iframe 蓋到格子上；其他的藏起來（尺寸跟著目前那一格，裡面的排版才不會亂） */
  function layout() {
    const slots = PR.$$(".pane", panesEl).map((el) => el.getBoundingClientRect());
    const cur = slots[st.focus] || slots[0];
    for (const t of st.tabs) {
      const f = frames[t.id];
      if (!f) continue;
      const i = M.paneOf(st, t.id), r = i >= 0 ? slots[i] : cur;
      if (!r) continue;
      Object.assign(f.style, { left: Math.round(r.left) + "px", top: Math.round(r.top) + "px", width: Math.round(r.width) + "px", height: Math.round(r.height) + "px" });
      f.classList.toggle("hidden", i < 0);
    }
  }
  function render() {
    for (const p of st.panes) frame(st.tabs.find((t) => t.id === p.tab));  // 顯示中的才載入
    renderTabs(); renderPanes(); save();
  }
  window.addEventListener("resize", layout);

  /* ---------- 動作 ---------- */
  function openUrl(url, title) {
    if (/^https?:/.test(url)) { try { const u = new URL(url); if (u.origin !== location.origin) return; url = u.pathname + u.search + u.hash; } catch (e) { return; } }
    if (url.startsWith("/open")) {  // 桌面版的 easyread:// 連結：請伺服器找出是哪一篇
      fetch(url).then((r) => { const o = new URL(r.url).searchParams.get("open"); if (o) openUrl(o); }).catch(() => {});
      return;
    }
    if (!paperOf(url)) return;
    const tab = M.open(st, url, title);
    const f = frames[tab.id];
    if (f && url.includes("#") && f.contentWindow) { try { f.contentWindow.location.hash = url.split("#")[1]; } catch (e) { /* 不同來源不會發生 */ } }
    render();
    focusFrame(tab.id);
  }
  window.easyreadOpen = openUrl;
  function focusFrame(id) { const f = frames[id]; if (f && f.contentWindow) setTimeout(() => f.contentWindow.focus(), 0); }
  function closeTab(id) {
    const f = frames[id];
    if (f) { f.remove(); delete frames[id]; }  // 卸掉前 iframe 裡的 pagehide 會把進度送出去
    M.close(st, id);
    render();
  }
  function goHome(url) {
    const lib = frames[LIB];
    if (lib && url && url.includes("?")) lib.src = url;  // 帶著「回到哪個分類」的狀態：重新載入文獻庫那一頁
    M.show(st, LIB);
    render();
    focusFrame(LIB);
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.easyread) return;
    const from = tabOfSource(e.source), d = e.data;
    if (d.type === "open") openUrl(String(d.url || ""));
    else if (d.type === "home") goHome(String(d.url || ""));
    else if (d.type === "title" && from) { from.title = String(d.title || "").replace(/\s*·\s*EasyRead$/, ""); renderTabs(); save(); }
    else if (d.type === "focus" && from) { const i = M.paneOf(st, from.id); if (i >= 0 && i !== st.focus) { st.focus = i; renderTabs(); renderPanes(); save(); } }
    else if (d.type === "key") key(String(d.key), !!d.shift);
    else if (d.type === "theme" && from && d.theme && document.documentElement.dataset.theme !== d.theme) {
      document.documentElement.dataset.theme = d.theme;
      for (const t of st.tabs) {  // 其他格先把顏色換過去（它們自己的設定下一次讀到時會再對一次）
        const f = frames[t.id];
        if (!f || t.id === from.id) continue;
        try { f.contentDocument.documentElement.dataset.theme = d.theme; } catch (e) { /* 還沒載好 */ }
      }
    }
  });
  function key(k, shift) {
    if (k === "\\") { if (M.split(st)) { render(); focusFrame(M.focused(st).tab); } return; }
    if (/^[1-9]$/.test(k)) { const t = st.tabs[+k - 1]; if (t) { M.show(st, t.id); render(); focusFrame(t.id); } return; }
    if (shift && (k === "[" || k === "{" || k === "]" || k === "}")) { const t = M.step(st, k === "[" || k === "{" ? -1 : 1); if (t) { render(); focusFrame(t.id); } }
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (/^[1-9]$/.test(e.key) || e.key === "\\" || (e.shiftKey && "[]{}".includes(e.key))) { e.preventDefault(); key(e.key, e.shiftKey); }
  });
  tabsEl.addEventListener("click", (e) => {
    const x = e.target.closest("[data-x]");
    if (x) { closeTab(x.dataset.x); return; }
    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "split") { if (M.split(st)) { render(); focusFrame(M.focused(st).tab); } return; }
    if (act && act.dataset.act === "closepane") { M.closePane(st, st.focus); render(); focusFrame(M.focused(st).tab); return; }
    const tab = e.target.closest(".tab[data-tab]");
    if (tab) { M.show(st, tab.dataset.tab); render(); focusFrame(tab.dataset.tab); }
  });
  tabsEl.addEventListener("auxclick", (e) => { const tab = e.target.closest(".tab[data-tab]"); if (tab && e.button === 1 && tab.dataset.tab !== LIB) { e.preventDefault(); closeTab(tab.dataset.tab); } });

  /* 拖分頁排順序 */
  let dragId = null, dropOn = null;
  const clearDrop = () => { if (dropOn) { dropOn.classList.remove("drop-before", "drop-after"); dropOn = null; } };
  tabsEl.addEventListener("dragstart", (e) => { const t = e.target.closest(".tab[draggable]"); if (!t) return; dragId = t.dataset.tab; t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  tabsEl.addEventListener("dragover", (e) => {
    const t = dragId && e.target.closest(".tab[data-tab]");
    if (!t || t.dataset.tab === dragId || t.dataset.tab === LIB) { clearDrop(); return; }
    e.preventDefault();
    const r = t.getBoundingClientRect(), before = e.clientX < r.left + r.width / 2;
    clearDrop(); dropOn = t; t.classList.add(before ? "drop-before" : "drop-after");
  });
  tabsEl.addEventListener("drop", (e) => {
    if (!dragId || !dropOn) return;
    e.preventDefault();
    const before = dropOn.classList.contains("drop-before"), id = dropOn.dataset.tab;
    const next = before ? id : (st.tabs[st.tabs.findIndex((t) => t.id === id) + 1] || {}).id || null;
    M.move(st, dragId, next);
    clearDrop(); render();
  });
  tabsEl.addEventListener("dragend", () => { PR.$$(".tab.dragging", tabsEl).forEach((t) => t.classList.remove("dragging")); clearDrop(); dragId = null; });

  /* 拖格子之間的分隔線。拖的時候只移動那條線（和一層淡淡的預覽），放開才真的改兩邊 iframe 的大小：
     兩份文件（幾千個絕對定位的文字塊）每一幀都重排會卡 */
  panesEl.addEventListener("mousedown", (e) => {
    const gap = e.target.closest(".gap");
    if (!gap || e.button !== 0) return;
    e.preventDefault();
    const i = +gap.dataset.gap, a = st.panes[i - 1], b = st.panes[i];
    const total = panesEl.clientWidth || 1, x0 = e.clientX, wa = a.w, wb = b.w, min = 180 / total;
    document.body.classList.add("sizing");
    const ghost = document.createElement("div");
    ghost.className = "gap-ghost";
    document.body.append(ghost);
    const slots = PR.$$(".pane", panesEl);
    const place = () => {
      slots.forEach((el, k) => (el.style.flexGrow = (st.panes[k].w * 1000).toFixed(0)));
      const r = slots[i].getBoundingClientRect();  // 新的分隔位置：右邊那格的左緣
      Object.assign(ghost.style, { left: Math.round(r.left) + "px", top: Math.round(r.top) + "px", height: Math.round(r.height) + "px" });
    };
    let raf = 0;
    const move = (ev) => {
      const d = Math.max(-(wa - min), Math.min(wb - min, (ev.clientX - x0) / total));
      a.w = wa + d; b.w = wb - d;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); });
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      cancelAnimationFrame(raf); raf = 0;
      ghost.remove();
      document.body.classList.remove("sizing");
      place(); layout(); save();
    };
    place();
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  window.addEventListener("blur", () => setTimeout(() => {  // 點進某一格的 iframe：焦點跟過去
    const el = document.activeElement, t = el && el.tagName === "IFRAME" && st.tabs.find((x) => frames[x.id] === el);
    const i = t ? M.paneOf(st, t.id) : -1;
    if (i >= 0 && i !== st.focus) { st.focus = i; renderTabs(); renderPanes(); save(); }
  }, 0));

  /* ---------- 開場 ---------- */
  render();
  const want = new URLSearchParams(location.search).get("open");
  if (want) { history.replaceState(null, "", "/"); openUrl(want); }
})(window.PR);
