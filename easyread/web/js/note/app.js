/* 獨立筆記的頁面（/note/<id>，資料在文獻庫的 _notes/<id>，見 notes.py）：
   一個大標題、一個區塊編輯器（js/common/blocks.js）、最下面一欄筆記 AI（和閱讀頁的一樣：選幾塊叫它改、沒選就寫在最後，先預覽再採用）。
   打字就存（去抖 0.4 秒）；標題也是。右上角「…」可以刪掉這份筆記。 */
(function (PR) {
  "use strict";
  const id = decodeURIComponent((location.pathname.match(/\/note\/([^/?#]+)/) || [])[1] || "");
  PR.imageUrl = (src) => "/n/" + encodeURIComponent(id) + "/" + src;  // markup.js 畫 ![](clips/…) 時用
  const st = { note: null, ed: null, models: [], model: "", streaming: null, draft: "" };
  const $ = PR.$;
  const QUICK = () => [[PR.t("整理成條列"), PR.t("把這段整理成條列，每點一句，保留所有重點。")], [PR.t("補充說明"), PR.t("把這段補充完整：定義、原因、例子。")],
    [PR.t("改短"), PR.t("把這段改短一半，只留關鍵。")], [PR.t("改成表格"), PR.t("把這段的內容整理成一個 Markdown 表格。")], [PR.t("潤飾"), PR.t("把這段的語句理順，意思不變。")]];

  $("#backBtn").innerHTML = PR.icon("back");
  $("#noteMore").innerHTML = PR.icon("more", "sm");

  function setState(s, msg) {
    const el = $("#noteState");
    el.dataset.s = s;
    el.title = s === "error" ? PR.t("沒存進去：{msg}", { msg: msg || "" }) : s === "saving" ? PR.t("儲存中…") : PR.t("已儲存");
  }
  const save = PR.debounce(async (patch) => {
    setState("saving");
    try {
      const n = await PR.api("/api/notes/" + encodeURIComponent(id), { method: "POST", body: patch });
      st.note = Object.assign(st.note, n);
      setState("saved");
    } catch (e) { setState("error", e.message); }
  }, 400);
  let pending = {};
  function queue(patch) { Object.assign(pending, patch); const p = pending; save(p); pending = Object.assign({}, p); }
  window.addEventListener("pagehide", () => { if (save.flush) save.flush(); });

  async function upload(file) {
    const r = await fetch("/api/notes/" + encodeURIComponent(id) + "/clip", { method: "POST", headers: { "Content-Type": file.type || "image/png", "X-Token": PR.token || "" }, body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d.src;
  }

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

  /* ---------- 筆記 AI ---------- */
  function paintAi() {
    const busy = !!st.streaming;
    const ta = $("#noteAi .nai-in");
    if (ta) st.draft = ta.value;
    $("#noteAi").innerHTML = '<div class="nai"><div class="nai-quick">' + QUICK().map(([l, q]) => '<button data-nai="quick" data-q="' + PR.esc(q) + '"' + (busy ? " disabled" : "") + ">" + PR.esc(l) + "</button>").join("") + "</div>" +
      '<div class="nai-box"><textarea class="nai-in" rows="1" placeholder="' + PR.t("想怎麼改？") + '"' + (busy ? " disabled" : "") + ">" + PR.esc(st.draft) + "</textarea>" +
      '<button class="nai-model" data-nai="model" title="' + PR.t("换模型") + '"><span>' + PR.esc(modelLabel()) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      (busy ? '<button class="nai-send stop" data-nai="stop" title="' + PR.t("停止") + '">' + PR.icon("stop", "sm") + "</button>" : '<button class="nai-send" data-nai="send" title="' + PR.t("送出（Enter）") + '">' + PR.icon("sparkle", "sm") + "</button>") + "</div></div>";
  }
  function clean(md) {
    let s = md.replace(/^\s*(?:以下是|這是|改好的版本|修改後)[^\n]*[:：]\s*\n/, "");
    const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);
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
    const ctrl = new AbortController();
    st.streaming = { ctrl };
    st.ed.preview(from, mode === "edit" ? to : from - 1, "", { streaming: true, label: mode === "edit" ? PR.t("AI 改的版本") : PR.t("AI 寫的一段"), stop: () => ctrl.abort() });
    paintAi();
    let out = "", label = "";
    try {
      const res = await fetch("/api/notes/" + encodeURIComponent(id) + "/ai", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode, note: st.ed.getValue(), selection: sel ? sel.md : "", ask: text, model: st.model }) });
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
    if (a === "send") return send(ta.value);
    if (a === "quick") return send(b.dataset.q);
    if (a === "stop") { if (st.streaming) st.streaming.ctrl.abort(); return; }
    if (a === "model") PR.menu(b, st.models.map((m) => ({ label: m.label + (m.id === st.model ? "　✓" : ""), disabled: m.ready === false, fn: () => { st.model = m.id; PR.ls.set("easyread-chat-model", m.id); paintAi(); } })));
  });
  document.addEventListener("keydown", (e) => {
    const ta = e.target.closest && e.target.closest("#noteAi .nai-in");
    if (ta && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
  });
  document.addEventListener("input", (e) => { const ta = e.target.closest && e.target.closest("#noteAi .nai-in"); if (ta) { st.draft = ta.value; PR.autosize(ta); } });

  /* ---------- 標題、更多 ---------- */
  const title = $("#noteTitle");
  title.addEventListener("input", () => { PR.autosize(title); queue({ title: title.value.trim() }); document.title = (title.value.trim() || PR.t("未命名筆記")) + " · FOLI"; });
  title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); st.ed && st.ed.focus("start"); } });
  $("#noteMore").addEventListener("click", (e) => {
    PR.menu(e.currentTarget, [
      { label: PR.t("複製成 Markdown"), icon: "copy", fn: () => navigator.clipboard.writeText("# " + (st.note.title || "") + "\n\n" + st.ed.getValue()).then(() => PR.toast(PR.t("已复制"), null, 1200)) },
      "-",
      { label: PR.t("刪除這份筆記…"), icon: "trash", fn: async () => {
        if (!(await PR.confirm({ title: PR.t("刪除這份筆記？"), body: PR.t("「{t}」會整份刪掉，沒有回收站。", { t: st.note.title || PR.t("未命名筆記") }), ok: PR.t("删除"), danger: true, at: e.currentTarget }))) return;
        await PR.api("/api/notes/" + encodeURIComponent(id) + "/delete", { method: "POST", body: {} });
        if (PR.navigate) PR.navigate("/library"); else location.href = "/library";
      } },
    ]);
  });

  /* ---------- 開場 ---------- */
  async function boot() {
    try { st.note = await PR.api("/api/notes/" + encodeURIComponent(id)); } catch (e) {
      $("#noteMain").innerHTML = '<p class="hint" style="padding:40px 0">' + PR.t("讀不到這份筆記：{msg}", { msg: PR.esc(e.message) }) + "</p>";
      return;
    }
    PR.token = st.note.token;
    document.title = (st.note.title || PR.t("未命名筆記")) + " · FOLI";
    title.value = st.note.title || "";
    PR.autosize(title);
    st.ed = PR.blockEditor($("#noteEd"), { value: st.note.body || "", placeholder: PR.t("寫點什麼，或按「/」選區塊…"), onChange: (md) => queue({ body: md }), upload });
    st.ed.on("ai", () => { const ta = $("#noteAi .nai-in"); if (ta) ta.focus(); });
    setState("saved");
    loadModels();
    if (!(st.note.title || "").trim() && !(st.note.body || "").trim()) title.focus();
  }
  boot();
})(window.PR);
