/* 筆記 AI：筆記面板（本頁、總結）最下面那一欄。專門負責寫筆記、改筆記：
   - 選了幾塊（點把手、Shift 點選一段）再說要怎麼改 → 只改那幾塊；沒選就照要求寫一段新的接在最後（或正在編的那一塊後面）。
   - 結果先放在原來那幾塊下面當「AI 的建議」（區塊編輯器的 preview），一邊流出來一邊看；按「採用」才真的換上，「捨棄」就當沒事。
   - 快速按鈕：整理成條列、補充說明、改短、改成表格、翻成中文、查核。「/」選單裡的「AI 寫」也是到這裡。
   走 /api/p/<id>/notehelp 的 edit / write（notehelp.py），帶整份筆記、選的那幾塊、文件的全文筆記和相關頁。 */
(function (PR) {
  "use strict";
  const st = { key: null, ed: null, range: null, streaming: null, draft: "" };
  const QUICK = () => [[PR.t("整理成條列"), PR.t("把這段整理成條列，每點一句，保留所有重點。")], [PR.t("補充說明"), PR.t("照文件的內容把這段補充完整：定義、原因、例子，標出頁碼。")],
    [PR.t("改短"), PR.t("把這段改短一半，只留關鍵。")], [PR.t("改成表格"), PR.t("把這段的內容整理成一個 Markdown 表格。")], [PR.t("查核"), PR.t("對照文件檢查這段有沒有和原文不符的地方，直接改正，並在改動處用粗體標出。")]];
  const panel = () => PR.$("#notespanel");
  const on = () => !!(PR.noteHelpOn && PR.noteHelpOn());

  /* 面板最下面那一欄：輸入框、快速按鈕、模型 */
  PR.notesAi = {
    bar(key) {
      if (!on()) return "";
      const busy = !!st.streaming;
      return '<div class="nai" data-nai-key="' + key + '"><div class="nai-quick">' + QUICK().map(([l, q], i) => '<button data-nai="quick" data-q="' + PR.esc(q) + '"' + (busy ? " disabled" : "") + ">" + PR.esc(l) + "</button>").join("") + "</div>" +
        '<div class="nai-box"><textarea class="nai-in" rows="1" placeholder="' + PR.t("要 AI 怎麼改？選幾塊就改那幾塊，沒選就寫在最後…") + '"' + (busy ? " disabled" : "") + ">" + PR.esc(st.draft) + "</textarea>" +
        '<button class="nai-model" data-nai="model" title="' + PR.t("换模型") + '"><span>' + PR.esc((PR.chatModel && PR.chatModel.label()) || PR.t("模型")) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
        (busy ? '<button class="nai-send stop" data-nai="stop" title="' + PR.t("停止") + '">' + PR.icon("stop", "sm") + "</button>" : '<button class="nai-send" data-nai="send" title="' + PR.t("送出（Enter）") + '">' + PR.icon("sparkle", "sm") + "</button>") + "</div></div>";
    },
    /* 「/」選單的「AI 寫」、把手選單：鎖定這一段，把游標放到輸入框 */
    start(ed, range, key) {
      st.ed = ed; st.range = range || null; st.key = key || st.key;
      const ta = panel().querySelector(".nai-in");
      if (ta) { ta.focus(); ta.placeholder = range ? PR.t("要在這裡寫什麼？") : ta.placeholder; }
    },
    busy: () => !!st.streaming,
  };

  async function send(key, text) {
    text = (text || "").trim();
    if (st.streaming || !on()) return;
    const ed = PR.notesEditor && PR.notesEditor(key);
    if (!ed) return;
    const sel = ed.selection();  // 選了幾塊（或正在編的那一塊）
    const mode = sel && sel.md.trim() ? "edit" : "write";
    const from = sel ? sel.from : ed.count(), to = sel ? sel.to : ed.count() - 1;
    if (!text && mode === "write") return PR.toast(PR.t("先說要寫什麼"));
    const page = key === "page" && ed.root && ed.root.dataset.page ? +ed.root.dataset.page : (PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : 0);
    st.draft = "";
    const box = panel().querySelector(".nai-in");
    if (box) box.value = "";  // 送出了：輸入框清掉（paintBar 會把框裡的字當成草稿留著）
    const ctrl = new AbortController();
    st.streaming = { ctrl, key };
    let out = "";
    ed.preview(from, mode === "edit" ? to : from - 1, "", { streaming: true, label: mode === "edit" ? PR.t("AI 改的版本") : PR.t("AI 寫的一段"), stop: () => ctrl.abort() });
    paintBar(key);
    try {
      if (PR.chatModel) await PR.chatModel.load();
      const res = await fetch("/api/p/" + PR.pid + "/notehelp", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode, note: ed.getValue(), selection: sel ? sel.md : "", ask: text, page, model: PR.chatModel ? PR.chatModel.id() : "" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", label = "";
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
          if (ev.t) { out += ev.t; ed.updatePreview(clean(out)); }
          if (ev.error) throw new Error(ev.error);
        }
      }
      st.streaming = null;
      if (!clean(out).trim()) { ed.rejectPreview(); PR.toast(PR.t("AI 沒有回任何內容")); }
      else ed.updatePreview(clean(out), { streaming: false, label: (mode === "edit" ? PR.t("AI 改的版本") : PR.t("AI 寫的一段")) + (label ? " · " + label : "") });
    } catch (e) {
      st.streaming = null;
      ed.rejectPreview();
      if (e.name !== "AbortError") PR.toast(PR.t("没能回答：{msg}", { msg: PR.esc(e.message) }), null, 6000);
    }
    paintBar(key);
  }
  /* 模型偶爾會把整段包在 ``` 裡、或加一句「以下是改好的版本：」——拿掉 */
  function clean(md) {
    let s = md.replace(/^\s*(?:以下是|這是|改好的版本|修改後)[^\n]*[:：]\s*\n/, "");
    const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);
    if (m) s = m[1];
    return s;
  }
  function paintBar(key) {
    const bar = panel().querySelector(".nai");
    if (!bar) return;
    const ta = bar.querySelector(".nai-in");
    if (ta) st.draft = ta.value;
    bar.outerHTML = PR.notesAi.bar(key);
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#notespanel [data-nai]");
    if (!b) return;
    const bar = b.closest(".nai"), key = bar.dataset.naiKey, ta = bar.querySelector(".nai-in");
    const a = b.dataset.nai;
    if (a === "send") return send(key, ta.value);
    if (a === "quick") return send(key, b.dataset.q);
    if (a === "stop") { if (st.streaming) st.streaming.ctrl.abort(); return; }
    if (a === "model" && PR.chatModel) return PR.chatModel.menu(b);
  });
  document.addEventListener("keydown", (e) => {
    const ta = e.target.closest && e.target.closest("#notespanel .nai-in");
    if (!ta) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.closest(".nai").dataset.naiKey, ta.value); }
  });
  document.addEventListener("input", (e) => { const ta = e.target.closest && e.target.closest("#notespanel .nai-in"); if (ta) { st.draft = ta.value; PR.autosize && PR.autosize(ta); } });
  PR.on && PR.on("chat-model", () => { const m = panel().querySelector(".nai-model > span"); if (m && PR.chatModel) m.textContent = PR.chatModel.label() || PR.t("模型"); });
})(window.PR);
