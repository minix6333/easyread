/* 獨立筆記的頁面（/note/<id>，資料在文獻庫的 _notes/<id>，見 notes.py）：
   一個大標題（前面一顆可以換的圖示）、一個區塊編輯器（js/common/blocks.js）、最下面一欄筆記 AI
   （和閱讀頁的一樣：選幾塊叫它改、沒選就寫在最後，先預覽再採用）。打字就存（去抖 0.4 秒）；標題也是。
   這支管資料和存檔；左邊的目錄、右邊的面板（插入／格式／樣式／資訊）、右上角的選單在 note/panels.js，都透過 PR.note 拿東西：
     PR.note.st.note      現在這份筆記（標題、正文以外還有 icon、color、folder、star、wide、font，見 notes.py STYLE_KEYS）
     PR.note.patch(o)     改欄位：先改畫面、再排進存檔（和正文走同一條去抖的路）
     PR.note.ed           編輯器
     PR.note.on(ev, fn)   "note"（欄位變了）、"saved" */
(function (PR) {
  "use strict";
  const id = decodeURIComponent((location.pathname.match(/\/note\/([^/?#]+)/) || [])[1] || "");
  const url = "/api/notes/" + encodeURIComponent(id);
  PR.imageUrl = (src) => "/n/" + encodeURIComponent(id) + "/" + src;  // markup.js 畫 ![](clips/…) 時用
  const st = { note: null, ed: null, models: [], model: "", streaming: null, draft: "", aiOpen: false };
  const $ = PR.$;
  const subs = {};
  const fire = (ev, d) => (subs[ev] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } });
  const QUICK = () => [[PR.t("整理成條列"), PR.t("把這段整理成條列，每點一句，保留所有重點。")], [PR.t("補充說明"), PR.t("把這段補充完整：定義、原因、例子。")],
    [PR.t("改短"), PR.t("把這段改短一半，只留關鍵。")], [PR.t("改成表格"), PR.t("把這段的內容整理成一個 Markdown 表格。")], [PR.t("潤飾"), PR.t("把這段的語句理順，意思不變。")]];

  $("#backBtn").innerHTML = PR.icon("back");
  $("#noteMore").innerHTML = PR.icon("more", "sm");

  /* ---------- 存檔 ----------
     要存的欄位先併在 pending 裡，0.4 秒沒有新的改動才送；送出去的那一批收進 sending，失敗就併回 pending 下次再送。
     離開頁面（關分頁、回文獻庫）時把還沒送的用 keepalive 送完，連編輯器裡還在去抖的那一段正文一起。 */
  let pending = {}, sending = null, listTimer = 0;
  function setState(s, msg) {
    const el = $("#noteState");
    el.dataset.s = s;
    el.title = s === "error" ? PR.t("沒存進去：{msg}", { msg: msg || "" }) : s === "saving" ? PR.t("儲存中…") : PR.t("已儲存");
  }
  const LIST_KEYS = ["title", "icon", "color", "folder", "star", "banner"];  // 文獻庫的清單上看得到的：改了要叫它重新取
  const flushSoon = PR.debounce(flush, 400);
  async function flush() {
    if (sending || !Object.keys(pending).length) return;
    sending = pending; pending = {};
    setState("saving");
    try {
      const n = await PR.api(url, { method: "POST", body: sending });
      const list = LIST_KEYS.some((k) => k in sending);
      sending = null;
      st.note.updated = n.updated;
      setState(Object.keys(pending).length ? "saving" : "saved");
      fire("saved", n);
      if (list && PR.notesChanged) { clearTimeout(listTimer); listTimer = setTimeout(() => PR.notesChanged(), 900); }
      if (Object.keys(pending).length) flushSoon();
    } catch (e) {
      pending = Object.assign(sending, pending); sending = null;
      if (await isGone()) return;  // 筆記已經被刪了：不用再試
      setState("error", e.message);
      setTimeout(flushSoon, 4000);  // 伺服器暫時連不上（電腦剛醒）：過一下再試，不用等使用者再打字
    }
  }
  /* 存不進去時看一下是不是這份筆記已經不在了（在文獻庫刪的、別台刪了同步過來）。是的話就不再每四秒試一次：
     在外殼裡把這個分頁收掉（刪掉的筆記在回收站裡，找得回來）；自己一個視窗時留著內容讓人複製，說明一下 */
  let dead = false;
  async function isGone() {
    if (dead) return true;
    try { const r = await fetch(url, { cache: "no-store" }); if (r.status !== 404) return false; } catch (e) { return false; }
    dead = true; pending = {};
    setState("error", PR.t("這份筆記已經刪除"));
    if (!(PR.docMissing && PR.docMissing())) PR.toast(PR.t("這份筆記已經刪除，之後打的字不會存。可以到文獻庫的回收站把它復原。"), null, 12000);
    return true;
  }
  function queue(patch) { Object.assign(pending, patch); setState("saving"); flushSoon(); }
  function flushNow() {  // 頁面要走了：等不了去抖
    if (dead) return;
    if (st.ed && st.note) { const md = st.ed.getValue(); if (md !== st.note.body) { st.note.body = md; pending.body = md; } }
    const body = Object.assign({}, sending || {}, pending);
    if (!Object.keys(body).length) return;
    pending = {};
    try { fetch(url, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" }, body: JSON.stringify(body) }); } catch (e) { /* 送不出去也沒辦法了 */ }
  }
  window.addEventListener("pagehide", flushNow);
  // 這一格重新拿到焦點（切回這個分頁、切回 App）：看一下這份筆記還在不在——在別處被刪掉的，不用等到下一次存檔失敗才發現
  let lookedAt = 0;
  window.addEventListener("focus", () => { if (st.note && !dead && Date.now() - lookedAt > 5000) { lookedAt = Date.now(); isGone(); } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSoon.flush(); });
  function patch(o) {
    Object.assign(st.note, o);
    queue(o);
    paintHead();
    fire("note", o);
  }

  async function upload(file) {
    const r = await fetch(url + "/clip", { method: "POST", headers: { "Content-Type": file.type || "image/png", "X-Token": PR.token || "" }, body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d.src;
  }
  /* 選起來的幾塊搬成一份新的筆記（區塊選單的「移成新筆記」）：標題用第一行的字 */
  async function moveOut(md) {
    const first = PR.plain((md.split("\n").find((l) => l.trim()) || "").replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, "")).slice(0, 60);
    try {
      const n = await PR.api("/api/notes", { method: "POST", body: { title: first, body: md, folder: st.note.folder || "", papers: st.note.papers || [] } });
      if (PR.notesChanged) PR.notesChanged();
      PR.toast(PR.t("已移成新筆記"), { label: PR.t("打開"), fn: () => PR.navigate("/note/" + n.id) }, 6000);
      return true;
    } catch (e) { PR.toast(PR.t("沒建成：{msg}", { msg: PR.esc(e.message) })); return false; }
  }

  /* ---------- 標題那一排：圖示、標題；右上角的收藏 ---------- */
  function paintHead() {
    const n = st.note;
    $("#noteIcon").innerHTML = PR.tintIcon(n.icon, n.color, "notes");
    $("#noteIcon").classList.toggle("set", !!(n.icon || n.color));
    const star = $("#starBtn");
    star.innerHTML = PR.icon("star", "sm");
    star.classList.toggle("on", !!n.star);
    star.title = n.star ? PR.t("取消收藏") : PR.t("收藏");
    if (PR.noteWidth) PR.noteWidth.apply(); else document.body.classList.toggle("wide", !!n.wide);  // 寫字那一欄的寬度（note/width.js）
    if (n.font) document.body.dataset.font = n.font; else delete document.body.dataset.font;
    if (n.paper) document.body.dataset.paper = n.paper; else delete document.body.dataset.paper;  // 紙張：方格、點陣（notepage.css）
    paintBanner();
  }
  /* 封面：紙最上面的一張（漸層或自己的圖）。滑鼠移過去右上角才出現兩顆鈕：換封面、拿掉 */
  const banner = $("#noteBanner");
  function paintBanner() {
    const n = st.note, a = PR.bannerAttrs ? PR.bannerAttrs(n.banner, PR.imageUrl) : null;
    const key = a ? a.cls + "|" + a.style : "";
    document.body.classList.toggle("has-banner", !!a);
    if (banner.dataset.key === key) return;
    banner.dataset.key = key;
    banner.hidden = !a;
    banner.className = "note-banner" + (a ? " " + a.cls : "");
    banner.setAttribute("style", a ? a.style.replace(/&quot;/g, '"') : "");
    banner.innerHTML = a ? '<div class="nb-acts"><button type="button" class="nb-btn" data-nb="pick" title="' + PR.t("換封面") + '">' + PR.icon("image", "sm") + "</button>" +
      '<button type="button" class="nb-btn" data-nb="off" title="' + PR.t("拿掉封面") + '">' + PR.icon("x", "sm") + "</button></div>" : "";
  }
  PR.noteBanner = function (anchor) {  // 換封面的小框（封面上的鈕、檢閱器、更多選單都叫這個）
    PR.pickBanner(anchor, { value: st.note.banner || "", onChange: (v) => patch({ banner: v }), upload });
  };
  banner.addEventListener("click", (e) => {
    const b = e.target.closest("[data-nb]");
    if (!b) return;
    if (b.dataset.nb === "off") patch({ banner: "" });
    else PR.noteBanner(b);
  });
  $("#noteIcon").addEventListener("click", (e) => PR.pickIcon(e.currentTarget, { icon: st.note.icon, color: st.note.color, onChange: (v) => patch(v) }));
  $("#starBtn").addEventListener("click", () => patch({ star: !st.note.star }));
  const title = $("#noteTitle");
  const docTitle = () => { document.title = (title.value.trim() || PR.t("未命名筆記")) + " · FOLI"; };
  title.addEventListener("input", () => { PR.autosize(title); st.note.title = title.value.trim(); queue({ title: st.note.title }); docTitle(); fire("note", { title: st.note.title }); });
  title.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" && !e.isComposing) || e.key === "ArrowDown") { e.preventDefault(); st.ed && st.ed.focus("start"); }
  });

  /* ---------- 模型（和閱讀頁的問 AI 共用上次選的那一個） ---------- */
  async function loadModels() {
    try {
      const d = await PR.api("/api/chat/models");
      st.models = d.models || [];
      const last = PR.ls.get("easyread-chat-model", "");
      st.model = st.models.some((m) => m.id === last && m.ready !== false) ? last : d.default || (st.models[0] || {}).id || "";
    } catch (e) { st.models = []; }
    paintAi();
  }
  const modelLabel = () => (st.models.find((m) => m.id === st.model) || {}).label || PR.t("模型");

  /* ---------- 筆記 AI ----------
     平常收成右下角一顆「問 AI」（像 Craft 的助理鈕，不佔版面）；點它、按 ⌘↩、區塊選單的「問 AI 改這裡」、「/」選單的「AI 寫」才展開成輸入列。
     輸入框空著又離開（或按 Esc）就收回去；正在寫、有草稿時不收。 */
  function paintAi() {
    const busy = !!st.streaming;
    const ta = $("#noteAi .nai-in");
    const focused = ta && document.activeElement === ta;
    if (ta) st.draft = ta.value;
    const open = st.aiOpen || busy || !!st.draft.trim();
    $("#noteAi").classList.toggle("open", open);
    if (!open) {
      $("#noteAi").innerHTML = '<button type="button" class="nai-pill" data-nai="open" title="' + PR.kbd(PR.t("問 AI 寫或改（⌘↩）")) + '">' + PR.icon("sparkle", "sm") + "<span>" + PR.t("問 AI") + "</span></button>";
      return;
    }
    const qi = [PR.hasIcon("bullets") ? "bullets" : "list", "plus", "type", PR.hasIcon("table") ? "table" : "grid", "sparkle"];  // 條列、補充、改短、表格、潤飾
    $("#noteAi").innerHTML = '<div class="nai"><div class="nai-quick">' + QUICK().map(([l, q], i) => '<button data-nai="quick" data-q="' + PR.esc(q) + '"' + (busy ? " disabled" : "") + ">" + PR.icon(qi[i] || "sparkle", "sm") + "<span>" + PR.esc(l) + "</span></button>").join("") + "</div>" +
      '<div class="nai-box"><textarea class="nai-in" rows="1" placeholder="' + PR.t("想怎麼改？") + '"' + (busy ? " disabled" : "") + ">" + PR.esc(st.draft) + "</textarea>" +
      '<button class="nai-model" data-nai="model" title="' + PR.t("换模型") + '"><span>' + PR.esc(modelLabel()) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      (busy ? '<button class="nai-send stop" data-nai="stop" title="' + PR.t("停止") + '">' + PR.icon("stop", "sm") + "</button>" : '<button class="nai-send" data-nai="send" title="' + PR.t("送出（Enter）") + '">' + PR.icon("sparkle", "sm") + "</button>") + "</div></div>";
    if (focused && !busy) { const t2 = $("#noteAi .nai-in"); t2.focus(); t2.setSelectionRange(t2.value.length, t2.value.length); }
  }
  function openAi() {
    st.aiOpen = true;
    paintAi();
    const ta = $("#noteAi .nai-in");
    if (ta) { ta.focus(); PR.autosize(ta); }
  }
  function closeAi() {
    if (st.streaming || st.draft.trim()) return;
    st.aiOpen = false;
    paintAi();
  }
  document.addEventListener("focusout", (e) => {
    if (!e.target.closest || !e.target.closest("#noteAi")) return;
    setTimeout(() => { const a = document.activeElement; if (!(a && a.closest && a.closest("#noteAi")) && !(PR.menuOpen && PR.menuOpen())) closeAi(); }, 180);
  });
  function clean(md) {
    let s = md.replace(/^\s*(?:以下是|這是|改好的版本|修改後)[^\n]*[:：]\s*\n/, "");
    const m = /^\s*\x60\x60\x60(?:markdown|md)?\s*\n([\s\S]*?)\n\x60\x60\x60\s*$/.exec(s);
    return m ? m[1] : s;
  }
  async function send(text) {
    text = (text || "").trim();
    if (st.streaming || !st.ed) return;
    const sel = st.ed.selection();
    const mode = sel && sel.md.trim() ? "edit" : "write";
    const from = sel ? sel.from : st.ed.count(), to = sel ? sel.to : st.ed.count() - 1;
    if (!text && mode === "write") return PR.toast(PR.t("先說要寫什麼"));
    st.draft = "";
    const ta0 = $("#noteAi .nai-in");
    if (ta0) ta0.value = "";
    const ctrl = new AbortController();
    st.streaming = { ctrl };
    st.ed.preview(from, mode === "edit" ? to : from - 1, "", { streaming: true, label: mode === "edit" ? PR.t("AI 改的版本") : PR.t("AI 寫的一段"), stop: () => ctrl.abort() });
    paintAi();
    let out = "", label = "";
    try {
      const res = await fetch(url + "/ai", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode, note: st.ed.getValue(), selection: sel ? sel.md : "", ask: text, model: st.model, ...PR.web.body(st.models.find((m) => m.id === st.model)) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.model) label = ev.model;
          if (ev.status && PR.webStatusText(ev.status)) st.ed.updatePreview(clean(out), { streaming: true, label: PR.webStatusText(ev.status) + "…" });  // 上網查的時候說在查什麼
          if (ev.t) { out += ev.t; st.ed.updatePreview(clean(out)); }
          if (ev.error) throw new Error(ev.error);
        }
      }
      st.streaming = null;
      if (!clean(out).trim()) { st.ed.rejectPreview(); PR.toast(PR.t("AI 沒有回任何內容")); }
      else st.ed.updatePreview(clean(out), { streaming: false, label: (mode === "edit" ? PR.t("AI 改的版本") : PR.t("AI 寫的一段")) + (label ? " · " + label : "") });
    } catch (e) {
      st.streaming = null;
      st.ed.rejectPreview();
      if (e.name !== "AbortError") PR.toast(PR.t("没能回答：{msg}", { msg: PR.esc(e.message) }), null, 6000);
    }
    paintAi();
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#noteAi [data-nai]");
    if (!b) return;
    const a = b.dataset.nai, ta = $("#noteAi .nai-in");
    if (a === "open") return openAi();
    if (a === "send") return send(ta.value);
    if (a === "quick") return send(b.dataset.q);
    if (a === "stop") { if (st.streaming) st.streaming.ctrl.abort(); return; }
    if (a === "model") PR.menu(b, st.models.map((m) => ({ label: m.label, checked: m.id === st.model, disabled: m.ready === false, fn: () => { st.model = m.id; PR.ls.set("easyread-chat-model", m.id); paintAi(); } })));
  });
  document.addEventListener("keydown", (e) => {
    const ta = e.target.closest && e.target.closest("#noteAi .nai-in");
    if (ta && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); return; }
    if (ta && e.key === "Escape") { e.preventDefault(); if (!ta.value.trim()) { st.draft = ""; st.aiOpen = false; paintAi(); } else ta.blur(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); if (st.ed) queue({ body: st.ed.getValue() }); flushSoon.flush(); }  // ⌘S：本來就會自己存，按了就馬上存
  });
  document.addEventListener("input", (e) => { const ta = e.target.closest && e.target.closest("#noteAi .nai-in"); if (ta) { st.draft = ta.value; PR.autosize(ta); } });

  /* ---------- 開場 ---------- */
  /* 別的地方（閱讀頁的「加到筆記」，同一個外殼裡的另一格）請這份筆記在最後接一段：交給編輯器接，跟自己打的字走同一條存檔的路。
     還沒載好、已經刪掉的回 false（那邊改請伺服器接） */
  function append(md) {
    if (!st.ed || !st.note || dead) return false;
    st.ed.insert(String(md || ""));
    return true;
  }
  // 並排開著的閱讀頁把選的字拖過來：放在某一塊旁邊由編輯器接（blocks.js）；放在紙的空白處（編輯器以外）就接在最後
  const sheet = $("#noteMain"), EXCERPT = "application/x-foli-excerpt";
  const brings = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(EXCERPT);
  sheet.addEventListener("dragover", (e) => { if (brings(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  sheet.addEventListener("drop", (e) => { if (e.defaultPrevented || !brings(e)) return; const md = e.dataTransfer.getData(EXCERPT); if (md) { e.preventDefault(); append(md); } });
  PR.note = { id, st, url, patch, queue, flush: () => flushSoon.flush(), flushNow, append, ed: null, on: (ev, fn) => { (subs[ev] = subs[ev] || []).push(fn); }, ready: null };
  async function boot() {
    try { st.note = await PR.api(url); } catch (e) {
      $("#noteMain").innerHTML = '<p class="hint note-missing">' + PR.t("讀不到這份筆記：{msg}", { msg: PR.esc(e.message) }) + "</p>";
      document.body.classList.add("note-gone");
      dead = true;
      if (e.status === 404 && PR.docMissing) PR.docMissing();  // 已經刪掉的筆記（分頁是上次留下來的）：請外殼把這個分頁收掉
      return false;
    }
    PR.token = st.note.token;
    title.value = st.note.title || "";
    docTitle();
    PR.autosize(title);
    paintHead();
    st.ed = PR.blockEditor($("#noteEd"), { value: st.note.body || "", placeholder: PR.t("寫點什麼，或按「/」選區塊…"), onChange: (md) => { st.note.body = md; queue({ body: md }); }, upload, moveOut });
    PR.note.ed = PR.noteEd = st.ed;  // scripts/note_editor_check.cjs 也從 PR.noteEd 拿
    st.ed.on("ai", () => openAi());
    st.ed.on("edge", () => { title.focus(); title.setSelectionRange(title.value.length, title.value.length); });  // 正文最上面再往上：回到標題
    setState("saved");
    loadModels();
    if (!(st.note.title || "").trim() && !(st.note.body || "").trim()) title.focus();
    document.body.classList.add("note-ready");
    return true;
  }
  PR.note.ready = boot();
  Promise.resolve(PR.note.ready).finally(() => PR.painted && PR.painted());  // 外殼等這一格畫好才換上來
})(window.PR);
