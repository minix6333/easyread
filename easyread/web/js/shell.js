/* 外殼：一個視窗裡開好幾份文件，上面一排分頁切換；可以分割成兩三格並排看（每格一個分頁），格子之間拖寬度。
   - 第一個分頁永遠是文獻庫（/library）；在文獻庫裡點一篇，就在這裡開成新分頁（frame-bridge.js 把連結轉過來）。
   - 每個分頁是一個 iframe（/read/<id>），切走的只是藏起來，捲到哪、問到哪都還在；關閉分頁才卸掉。
   - 分割：工具列的分割鍵（或 ⌘\）：有還沒顯示的分頁就把它擺到新的一格，沒有就把目前這份再開一份並排（比對兩頁時用）。
   - 哪些分頁開著、怎麼分割都記著（localStorage），下次開 App 原樣回來；分頁用到才載入。
   - 快捷鍵：⌘1–9 切分頁，⌘⇧[ ] 上一個／下一個，⌘\ 分割。
   - 右邊可以再開一欄「外部工具」（ChatGPT 之類的網頁，桌面版才有，見 dock.js）：格子會讓出那一欄的寬度。
   PR.shellModel 是純函式（tests/test_shell.cjs）。 */
(function (PR) {
  "use strict";
  const KEY = "easyread-shell";
  const LIB = "lib";
  const paperOf = (url) => { const m = /^\/(?:read|note)\/([^/?#]+)/.exec(url || ""); return m ? m[1] : null; };  // 論文（/read/）和獨立筆記（/note/）都是一個分頁
  const kindOf = (url) => (/^\/note\//.test(url || "") ? "note" : "paper");

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
        tab = { id: "t" + ++st.seq, kind: kindOf(url), url, title: title || "" };
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
    /* 文件不在了（刪掉、別台刪了同步過來）：指到它的分頁全部關掉——同一份可能並排開了兩個。回傳關掉的分頁 id */
    closeDocs(st, ids) {
      const set = new Set(ids);
      const gone = st.tabs.filter((t) => t.kind !== "library" && set.has(paperOf(t.url))).map((t) => t.id);
      gone.forEach((id) => M.close(st, id));
      return gone;
    },
    /* 分頁的右鍵選單：只留這一個（文獻庫永遠在）、關掉它右邊的。回傳關掉的分頁（{id, url, title, kind}，重開用） */
    closeOthers(st, keep) {
      const gone = st.tabs.filter((t) => t.kind !== "library" && t.id !== keep).map((t) => Object.assign({}, t));
      gone.forEach((t) => M.close(st, t.id));
      if (st.tabs.some((t) => t.id === keep)) M.show(st, keep);
      return gone;
    },
    closeRight(st, id) {
      const at = st.tabs.findIndex((t) => t.id === id);
      if (at < 0) return [];
      const gone = st.tabs.slice(at + 1).filter((t) => t.kind !== "library").map((t) => Object.assign({}, t));
      gone.forEach((t) => M.close(st, t.id));
      return gone;
    },
    /* 把一個還沒顯示的分頁擺到目前這一格旁邊的新格子（最多三格） */
    beside(st, tabId) {
      if (st.panes.length >= 3 || M.paneOf(st, tabId) >= 0 || !st.tabs.some((t) => t.id === tabId)) return false;
      st.panes.splice(st.focus + 1, 0, { tab: tabId, w: 1 });
      st.panes.forEach((p) => (p.w = 1 / st.panes.length));
      st.focus += 1;
      return true;
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
      const tabs = saved.tabs.filter((t) => t && t.id && (t.kind === "paper" || t.kind === "note") && paperOf(t.url)).map((t) => ({ id: String(t.id), kind: kindOf(t.url), url: String(t.url), title: String(t.title || "") }));
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
  const restored = new Set(st.tabs.filter((t) => t.kind !== "library").map((t) => t.id));  // 上次留下來的分頁（還沒對過它們的文件還在不在）
  const save = () => PR.ls.set(KEY, { tabs: st.tabs.filter((t) => t.kind !== "library"), panes: st.panes, focus: st.focus, seq: st.seq });

  /* ---------- iframe ---------- */
  const frames = {};  // tab id → iframe
  const framesBox = PR.$("#frames");
  function frame(tab) {
    let f = frames[tab.id];
    if (f) return f;
    f = document.createElement("iframe");
    f.src = tab.url + (tab.jump ? "#" + tab.jump : "");  // jump：這次要直接看哪裡（見 openUrl），只用一次
    delete tab.jump;
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
  /* 分頁列不整排重畫：照 id 對上已經有的元素，只改它的樣子。整排換掉的話滑鼠正停著的那顆會閃一下，
     新開的、關掉的也沒辦法單獨做「長出來／縮回去」（shell.css 的 @starting-style 和 .tab.out）。 */
  const tabsEnd = document.createElement("span");
  tabsEnd.className = "tabs-end";
  tabsEl.append(tabsEnd);
  const tabIcon = (t) => PR.icon(t.kind === "library" ? "folder" : t.kind === "note" ? "notebook" : "book", "sm");
  function makeTab(t) {
    const el = document.createElement("div");
    el.dataset.tab = t.id;
    el.setAttribute("role", "tab");
    if (t.kind !== "library") el.draggable = true;
    el.innerHTML = tabIcon(t) + (t.kind === "library" ? "" : '<span class="tt"></span><button class="x" data-x="' + PR.esc(t.id) + '" title="' + PR.t("关闭") + '">' + PR.icon("x", "sm") + "</button>");
    return el;
  }
  function renderTabs() {
    const shown = new Set(st.panes.map((p) => p.tab)), cur = M.focused(st).tab;
    const have = new Map(PR.$$(".tab[data-tab]:not(.out)", tabsEl).map((el) => [el.dataset.tab, el]));
    let prev = null;
    for (const t of st.tabs) {
      let el = have.get(t.id);
      if (el) have.delete(t.id); else el = makeTab(t);
      const cls = "tab" + (t.id === cur ? " on" : "") + (shown.has(t.id) ? " shown" : "") + (t.kind === "library" ? " lib" : "") + (el.classList.contains("dragging") ? " dragging" : "");
      if (el.className !== cls) el.className = cls;
      el.setAttribute("aria-selected", String(t.id === cur));
      const title = tabTitle(t), tt = el.querySelector(".tt");
      if (el.title !== title) el.title = title;
      if (tt && tt.textContent !== title) tt.textContent = title;
      let want = prev ? prev.nextSibling : tabsEl.firstChild;
      while (want && want !== el && want.classList && want.classList.contains("out")) want = want.nextSibling;  // 正在縮回去的不算位置
      if (want !== el) tabsEl.insertBefore(el, want);
      prev = el;
    }
    for (const el of have.values()) {  // 關掉的：縮回去再拿掉（動畫關著時 transitionend 不會來，用計時器保底）
      el.style.maxWidth = el.offsetWidth + "px";  // 從現在的寬度縮回去（從 max-width 的上限開始縮的話，前三分之一看起來沒動）
      void el.offsetWidth;
      el.classList.add("out");
      el.removeAttribute("draggable");
      setTimeout(() => el.remove(), 220);
    }
    const end = '<span class="grow"></span>' + (st.panes.length > 1 ? '<button class="btn icon" data-act="closepane" title="' + PR.t("收起這一格") + '">' + PR.icon("x", "sm") + "</button>" : "") +
      '<button class="btn icon" data-act="split" title="' + PR.t("分割視窗：並排再開一格（⌘\\）") + '"' + (st.panes.length >= 3 ? " disabled" : "") + ">" + PR.icon("panel", "sm") + "</button>" +
      (PR.dock ? PR.dock.button() : "");
    if (tabsEnd._html !== end) { tabsEnd._html = end; tabsEnd.innerHTML = end; }
    if (tabsEl.lastChild !== tabsEnd) tabsEl.append(tabsEnd);
    const on = tabsEl.querySelector(".tab.on");
    if (on && on.scrollIntoView && tabsEl.scrollWidth > tabsEl.clientWidth) on.scrollIntoView({ block: "nearest", inline: "nearest" });  // 分頁多到要捲：目前這個一定看得到
    document.title = (cur === LIB ? "" : tabTitle(st.tabs.find((t) => t.id === cur) || {}) + " · ") + "FOLI";
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
  PR.shellLayout = layout;  // 右邊的外部工具欄開關、改寬度後叫（dock.js）
  PR.on("dock-changed", () => { renderTabs(); layout(); });

  /* ---------- 動作 ---------- */
  function openUrl(url, title, beside) {
    if (/^https?:/.test(url)) { try { const u = new URL(url); if (u.origin !== location.origin) return; url = u.pathname + u.search + u.hash; } catch (e) { return; } }
    if (url.startsWith("/open")) {  // 桌面版的 easyread:// 連結：請伺服器找出是哪一篇
      fetch(url).then((r) => { const o = new URL(r.url).searchParams.get("open"); if (o) openUrl(o); }).catch(() => {});
      return;
    }
    if (!paperOf(url)) return;
    // #page=12、#find=詞：只是「這次開到哪裡」（全文搜尋的結果、筆記裡的出處），不是這個分頁的位址——不記在分頁上，
    // 不然下次開 App 又被帶回那一頁，而不是接著上次讀到的地方。#b-…（段落）照舊記著
    const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "", jump = /(^|&)(page|find)=/.test(hash);
    const tab = beside ? addBeside(jump ? url.split("#")[0] : url, title) : M.open(st, jump ? url.split("#")[0] : url, title);
    if (!tab) return;
    const f = frames[tab.id];
    if (f && hash && f.contentWindow) { try { f.contentWindow.location.hash = hash; } catch (e) { /* 不同來源不會發生 */ } }
    else if (!f && jump) tab.jump = hash;
    render();
    focusFrame(tab.id);
  }
  /* 在旁邊並排打開（快速開啟的 ⌘Enter）：目前這一格不動，新的一格擺它；已經三格了就照平常開 */
  function addBeside(url, title) {
    const pid = paperOf(url);
    let tab = st.tabs.find((t) => paperOf(t.url) === pid);
    if (!tab) {
      tab = { id: "t" + ++st.seq, kind: kindOf(url), url, title: title || "" };
      st.tabs.splice(st.tabs.findIndex((t) => t.id === M.focused(st).tab) + 1, 0, tab);
    }
    if (!M.beside(st, tab.id)) M.show(st, tab.id);
    return tab;
  }
  window.easyreadOpen = openUrl;
  function focusFrame(id) { const f = frames[id]; if (f && f.contentWindow) setTimeout(() => f.contentWindow.focus(), 0); }
  /* 剛關掉的分頁（最多記 12 個，只在這次開著的期間）：⌘⇧T、分頁的右鍵選單可以開回來。文件被刪掉而收掉的不記 */
  const closed = [];
  const remember = (t) => { if (t && t.kind !== "library") { closed.push({ url: t.url, title: t.title }); if (closed.length > 12) closed.shift(); } };
  function dropFrame(id) { const f = frames[id]; if (f) { f.remove(); delete frames[id]; } restored.delete(id); }  // 卸掉前 iframe 裡的 pagehide 會把進度送出去
  function closeTab(id) {
    if (id === LIB) return;
    remember(st.tabs.find((t) => t.id === id));
    dropFrame(id);
    M.close(st, id);
    render();
    focusFrame(M.focused(st).tab);
  }
  function reopen() {
    const t = closed.pop();
    if (t) openUrl(t.url, t.title);
    return !!t;
  }
  PR.shellClosed = () => closed.length;
  function goHome(url) {
    const lib = frames[LIB];
    if (lib && url && url.includes("?")) lib.src = url;  // 帶著「回到哪個分類」的狀態：重新載入文獻庫那一頁
    M.show(st, LIB);
    render();
    focusFrame(LIB);
  }

  /* 文件、筆記不在了：開著它的分頁跟著收（iframe 卸掉、狀態存好）。回傳收了幾個 */
  function closeDocs(ids) {
    const gone = M.closeDocs(st, ids);
    gone.forEach(dropFrame);
    if (gone.length) { render(); focusFrame(M.focused(st).tab); }
    return gone.length;
  }
  function tellLibrary(except) {
    const lib = frames[LIB];
    if (lib && lib.contentWindow && lib.contentWindow !== except) lib.contentWindow.postMessage({ easyread: true, type: "notes-changed" }, location.origin);
  }
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.easyread) return;
    const from = tabOfSource(e.source), d = e.data;
    if (d.type === "open") openUrl(String(d.url || ""));
    else if (d.type === "home") goHome(String(d.url || ""));
    else if (d.type === "title" && from) { from.title = String(d.title || "").replace(/\s*·\s*FOLI$/, ""); renderTabs(); save(); }
    else if (d.type === "focus" && from) { const i = M.paneOf(st, from.id); if (i >= 0 && i !== st.focus) { st.focus = i; renderTabs(); renderPanes(); save(); } }
    else if (d.type === "key") key(String(d.key), !!d.shift);
    else if (d.type === "drag-link") { if (PR.dockDragHint) PR.dockDragHint(); }  // 有人拖著連結經過某一格：右緣亮出可以放下的地方
    else if (d.type === "close-self" && from) { closeTab(from.id); goHome(""); tellLibrary(); }  // 筆記把自己刪了：關掉那個分頁、回文獻庫（那邊會出「復原」）
    else if (d.type === "notes-changed") tellLibrary(e.source);  // 筆記改了名字、圖示、建了副本…：文獻庫的清單馬上跟上
    else if (d.type === "gone" && Array.isArray(d.ids)) closeDocs(d.ids.map(String));  // 文獻庫說這幾份刪掉了（在那裡刪的、或清單裡不見了）
    else if (d.type === "docs" && Array.isArray(d.ids)) {
      // 文獻庫第一次拿到清單：上次留下來的分頁裡，文件已經不在的收掉（上次關掉 App 之後刪的、在別台刪的）。
      // 清單整個是空的不動手——文獻庫的資料夾暫時讀不到（雲端硬碟還沒掛上）時也會是空的；之後才開的分頁也不管（由 gone 處理）
      const have = new Set(d.ids.map(String)), kind = d.kind === "note" ? "note" : "paper";
      if (have.size) closeDocs(st.tabs.filter((t) => t.kind === kind && restored.has(t.id) && !have.has(paperOf(t.url))).map((t) => paperOf(t.url)));
      st.tabs.forEach((t) => { if (t.kind === kind) restored.delete(t.id); });
    }
    else if (d.type === "missing" && from) {  // 這一格打開才發現自己的文件已經不在了：收掉，說一聲
      const name = from.title;
      closeDocs([paperOf(from.url)]);
      PR.toast(name ? PR.t("「{t}」已經不在文獻庫裡，分頁關掉了", { t: PR.esc(name) }) : PR.t("那份文件已經不在文獻庫裡，分頁關掉了"), null, 5200);
    }
    else if (d.type === "close-papers") {  // 文獻庫要換位置了：論文分頁全部收掉（它們開著時後端不讓換）
      for (const t of st.tabs.filter((x) => x.kind === "paper")) { dropFrame(t.id); M.close(st, t.id); }
      render();
    }
    // 主題不靠這裡傳了：每一格、外殼自己都收得到 localStorage 的 storage 事件（util.js）。以前某一格主題一變就通知外殼、
    // 外殼再套到其他格——有一格記著舊主題時兩邊互相蓋，是 2.1.0-tw.5 換主題閃個不停的那條路
  });
  /* 鍵盤（外殼自己收到的、每一格轉過來的、桌面版選單送來的都走這裡）：
     ⌘W 關目前這個分頁（文獻庫關不掉；只剩文獻庫時桌面版照舊是關視窗）、⌘⇧T 把剛關掉的開回來、⌘K／⌘T 快速開啟（palette.js） */
  function key(k, shift) {
    const low = String(k).toLowerCase();
    if (low === "w" && !shift) {
      const cur = M.focused(st).tab;
      if (cur !== LIB) closeTab(cur);
      else if (st.tabs.length === 1 && window.easyreadDesktop) window.close();
      return;
    }
    if (low === "t" && shift) { reopen(); return; }
    if ((low === "k" || low === "t") && !shift) { if (PR.palette) PR.palette.toggle(); return; }
    if (k === "\\") { if (M.split(st)) { render(); focusFrame(M.focused(st).tab); } return; }
    if (/^[1-9]$/.test(k)) { const t = st.tabs[+k - 1]; if (t) { M.show(st, t.id); render(); focusFrame(t.id); } return; }
    if (shift && (k === "[" || k === "{" || k === "]" || k === "}")) { const t = M.step(st, k === "[" || k === "{" ? -1 : 1); if (t) { render(); focusFrame(t.id); } }
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const low = e.key.toLowerCase();
    if (/^[1-9]$/.test(e.key) || e.key === "\\" || (e.shiftKey && "[]{}".includes(e.key)) || low === "w" || low === "t" || (low === "k" && !e.shiftKey)) { e.preventDefault(); key(e.key, e.shiftKey); }
  });
  // 桌面版（macOS）：⌘W、⌘⇧T 是選單上的項目（不然 ⌘W 是系統的「關視窗」，整個視窗就沒了），按了由主程式送過來
  try { if (window.easyreadDesktop && window.easyreadDesktop.onShellKey) window.easyreadDesktop.onShellKey((m) => key(String((m && m.key) || ""), !!(m && m.shift))); } catch (e) { /* 不是桌面版 */ }
  tabsEl.addEventListener("click", (e) => {
    const x = e.target.closest("[data-x]");
    if (x) { closeTab(x.dataset.x); return; }
    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "split") { if (M.split(st)) { render(); focusFrame(M.focused(st).tab); } return; }
    if (act && act.dataset.act === "dock") { PR.dock.toggle(); return; }
    if (act && act.dataset.act === "closepane") { M.closePane(st, st.focus); render(); focusFrame(M.focused(st).tab); return; }
    const tab = e.target.closest(".tab[data-tab]");
    if (tab) { M.show(st, tab.dataset.tab); render(); focusFrame(tab.dataset.tab); }
  });
  tabsEl.addEventListener("auxclick", (e) => { const tab = e.target.closest(".tab[data-tab]"); if (tab && e.button === 1 && tab.dataset.tab !== LIB) { e.preventDefault(); closeTab(tab.dataset.tab); } });
  /* 分頁的右鍵選單 */
  tabsEl.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".tab[data-tab]:not(.out)");
    if (!el || !PR.menu) return;
    e.preventDefault();
    const id = el.dataset.tab, lib = id === LIB, at = st.tabs.findIndex((t) => t.id === id);
    const others = st.tabs.filter((t) => t.kind !== "library" && t.id !== id).length, right = st.tabs.slice(at + 1).filter((t) => t.kind !== "library").length;
    const drop = (gone) => { gone.forEach((t) => { remember(t); dropFrame(t.id); }); render(); focusFrame(M.focused(st).tab); };
    PR.menu({ x: e.clientX, y: e.clientY }, [
      lib ? null : { label: PR.t("關閉分頁"), icon: "x", kbd: PR.kbd("⌘W"), fn: () => closeTab(id) },
      { label: PR.t("關閉其他分頁"), disabled: !others, fn: () => drop(M.closeOthers(st, id)) },
      lib ? null : { label: PR.t("關閉右邊的分頁"), disabled: !right, fn: () => drop(M.closeRight(st, id)) },
      "-",
      M.paneOf(st, id) >= 0 ? null : { label: PR.t("在旁邊並排打開"), icon: "panel", disabled: st.panes.length >= 3, fn: () => { if (M.beside(st, id)) { render(); focusFrame(id); } } },
      { label: PR.t("重新開啟關掉的分頁"), icon: "redo", kbd: PR.kbd("⌘⇧T"), disabled: !closed.length, fn: reopen },
    ].filter(Boolean));
  });
  // 選單開著時點進某一格（iframe 裡的點擊外殼收不到）：焦點一離開外殼就收掉
  window.addEventListener("blur", () => { if (PR.closeMenu && PR.menuOpen && PR.menuOpen()) PR.closeMenu(); });

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

  /* 給別的地方用的入口（都是同一個來源，iframe 裡可以直接叫）：
     PR.shell.open(url, title)、PR.shell.tabs()（開著的分頁）、PR.shell.frameOf("/note/<id>")（那一份開著的話，它那一格的 window）、
     PR.shell.lib()（文獻庫那一格的 window，沒載入就先載入）、PR.shell.act(名字) */
  const libWin = () => { const t = st.tabs[0]; const f = frame(t); return f.contentWindow; };
  PR.shell = {
    open: openUrl,
    home: () => goHome(""),
    tabs: () => st.tabs.map((t) => ({ id: t.id, kind: t.kind, url: t.url, title: tabTitle(t), doc: paperOf(t.url), on: t.id === M.focused(st).tab })),
    show: (id) => { M.show(st, id); render(); focusFrame(id); },
    frameOf: (path) => { const t = st.tabs.find((x) => x.url.split(/[?#]/)[0] === path && frames[x.id]); return t ? frames[t.id].contentWindow : null; },
    lib: libWin,
    split: () => key("\\"),
    reopen, closed: () => closed.length,
    refocus: () => focusFrame(M.focused(st).tab),
    changed: () => tellLibrary(),  // 筆記的清單變了（外殼自己建了一份）：文獻庫那一格跟上
  };
  window.easyreadShell = PR.shell;

  /* ---------- 開場 ---------- */
  tabsEl.classList.add("booting");  // 上次留下來的分頁一開場就在那裡，不用一顆一顆長出來
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => tabsEl.classList.remove("booting")));
  // 上次留下來的分頁裡，文件已經不在的收掉。自己問一次伺服器：文獻庫那一格沒在顯示時不會載入，等不到它報清單
  if (restored.size) Promise.all([fetch("/api/library", { cache: "no-store" }).then((r) => r.json()), fetch("/api/notes", { cache: "no-store" }).then((r) => r.json())]).then(([lib, notes]) => {
    if (lib.library_status !== "idle" || !Array.isArray(lib.items) || !Array.isArray(notes.items)) return;
    const have = new Set(lib.items.concat(notes.items).map((i) => String(i.id)));
    if (!have.size) return;  // 整個是空的：文獻庫的資料夾暫時讀不到（雲端硬碟還沒掛上）時也是這樣，不動手
    closeDocs(st.tabs.filter((t) => t.kind !== "library" && restored.has(t.id) && !have.has(paperOf(t.url))).map((t) => paperOf(t.url)));
    restored.clear();
  }).catch(() => { /* 連不上就算了：打開那個分頁時它自己會發現 */ });
  const want = new URLSearchParams(location.search).get("open");
  if (want) { history.replaceState(null, "", "/"); openUrl(want); }
})(window.PR);
