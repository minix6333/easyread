/* 筆記 AI：筆記面板（本頁、總結）最下面那一欄。照讀者的話寫筆記、改筆記（核心在 common/note-ai.js，伺服器是 notehelp.py 的 auto）：
   - 要改哪裡：選了幾塊（點把手、⇧ 點、拖過幾塊）或在某一塊裡反白了幾個字，再按這一欄——按下去那一刻就記下來，
     輸入框上面的小標籤說「第 2–3 塊」「選的字：…」，× 拿掉就是整份筆記。沒選也行：「把整份排好」「第二個標題下面改成表格」AI 自己找。
   - AI 先用筆記裡的操作名稱說它理解成什麼（「AI 的建議：整理、轉成待辦」），結果放在原來那幾塊上面當建議，換掉的那幾塊先淡掉；
     按「採用」才真的換上，「捨棄」就當沒事（採用後 ⌘Z 可以復原）。
   - 快速按鈕：整理、補充說明、改短、改成表格、查核。區塊選單的「問 AI 改這裡」、格式工具列的 AI、「/」選單的「AI 寫」也是到這裡。 */
(function (PR) {
  "use strict";
  const st = { key: null, scope: null, streaming: null, draft: "" };
  /* 「整理」：只動排版、不動字句——寫得很亂的筆記排成小標題、條列、表格。沒選幾塊就整份 */
  const TIDY = () => PR.t("把這段筆記重新排版成好讀的結構：該分段的分段，需要的話加簡短的小標題（用筆記裡原本的用字）；並列的重點改成條列，有先後的步驟改成編號清單，要做的事改成待辦清單，適合對照的內容排成表格，公式寫成 $…$ 或 $$…$$。原本的字句、數字、公式、引用、連結和頁碼一個都不能改、不能刪；除了小標題，不要加任何新的內容或說明。只動排版。");
  const QUICK = () => [[PR.t("整理"), TIDY(), "tidy"], [PR.t("補充說明"), PR.t("照文件的內容把這段補充完整：定義、原因、例子，標出頁碼。")],
    [PR.t("改短"), PR.t("把這段改短一半，只留關鍵。")], [PR.t("改成表格"), PR.t("把這段的內容整理成一個 Markdown 表格。")], [PR.t("查核"), PR.t("對照文件檢查這段有沒有和原文不符的地方，直接改正，並在改動處用粗體標出。")]];
  const QICON = [PR.hasIcon && PR.hasIcon("wand") ? "wand" : "sparkle", "plus", "type", PR.hasIcon && PR.hasIcon("table") ? "table" : "grid", "check"];  // 快速改寫的小圖示：整理、補充、改短、表格、查核
  const panel = () => PR.$("#notespanel");
  const on = () => !!(PR.noteHelpOn && PR.noteHelpOn());
  const scopeOf = (key) => (st.scope && st.scope.key === key ? st.scope : null);
  const chip = (key) => {  // 這次要改的範圍
    const sc = scopeOf(key);
    return '<div class="nai-scope' + (sc && sc.from != null ? " on" : "") + '"><span>' + PR.icon(sc && sc.from != null ? "scope" : "notebook", "sm") + PR.esc(PR.noteAi.scopeLabel(sc)) + "</span>" +
      (sc && sc.from != null ? '<button data-nai="unscope" title="' + PR.t("不限這幾塊：交給 AI 看整份筆記") + '">' + PR.icon("x", "sm") + "</button>" : "") + "</div>";
  };

  /* 面板最下面那一欄：快速按鈕、範圍、輸入框、模型 */
  PR.notesAi = {
    bar(key) {
      if (!on()) return "";
      const busy = !!st.streaming;
      return '<div class="nai" data-nai-key="' + key + '"><div class="nai-quick">' + QUICK().map(([l, q, k], i) => '<button data-nai="' + (k || "quick") + '" data-q="' + PR.esc(q) + '"' + (busy ? " disabled" : "") + ">" + PR.icon(QICON[i] || "sparkle", "sm") + "<span>" + PR.esc(l) + "</span></button>").join("") + "</div>" +
        chip(key) +
        '<div class="nai-box"><textarea class="nai-in" rows="1" placeholder="' + PR.t("想怎麼改？例如：把這段排版排好、改成待辦、整份加上小標題") + '"' + (busy ? " disabled" : "") + ">" + PR.esc(st.draft) + "</textarea>" +
        '<button class="nai-model" data-nai="model" title="' + PR.t("换模型") + '"><span>' + PR.esc((PR.chatModel && PR.chatModel.label()) || PR.t("模型")) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
        (busy ? '<button class="nai-send stop" data-nai="stop" title="' + PR.t("停止") + '">' + PR.icon("stop", "sm") + "</button>" : '<button class="nai-send" data-nai="send" title="' + PR.t("送出（Enter）") + '">' + PR.icon("sparkle", "sm") + "</button>") + "</div></div>";
    },
    /* 區塊選單的「問 AI 改這裡」、格式工具列的 AI、「/」選單的「AI 寫」：記下範圍，把游標放到輸入框 */
    start(ed, range, key) {
      grab(key || st.key, ed, range);
      const ta = panel().querySelector('.nai[data-nai-key="' + (key || st.key) + '"] .nai-in') || panel().querySelector(".nai-in");
      if (ta) ta.focus();
    },
    busy: () => !!st.streaming,
  };
  /* 按下這一欄的那一刻（編輯器還沒失焦）：記下選了哪裡 */
  function grab(key, ed, range) {
    ed = ed || (PR.notesEditor && PR.notesEditor(key));
    if (!ed || st.streaming) return;
    // 編輯器自己交過來的範圍（區塊選單、格式工具列、⌘↩、「/」的 AI 寫）：那時候已經失焦了，用它給的
    const sc = range && range.from != null ? { from: range.from, to: range.to, picked: range.picked || "", cursor: range.from, n: ed.count() } : PR.noteAi.capture(ed);
    if (range && range.from != null && ed.count()) ed.selectSpan(range.from, range.to);
    st.key = key;
    st.scope = sc ? Object.assign({ key }, sc) : null;
    const el = panel().querySelector('.nai[data-nai-key="' + key + '"] .nai-scope');
    if (el) el.outerHTML = chip(key);
  }

  async function send(key, text, o) {
    o = o || {};
    text = (text || "").trim();
    if (st.streaming || !on()) return;
    const ed = PR.notesEditor && PR.notesEditor(key);
    if (!ed) return;
    if (!text) return PR.toast(PR.t("先說要怎麼改，或要寫什麼"));
    if (o.tidy && !ed.getValue().trim()) return PR.toast(PR.t("還沒有筆記可以整理"));
    const sc = scopeOf(key) || Object.assign({ key }, PR.noteAi.capture(ed) || {});
    const page = key === "page" && ed.root && ed.root.dataset.page ? +ed.root.dataset.page : (PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : 0);
    st.draft = "";
    const box = panel().querySelector(".nai-in");
    if (box) box.value = "";  // 送出了：輸入框清掉（paintBar 會把框裡的字當成草稿留著）
    st.streaming = { key, ctrl: null };
    paintBar(key);
    if (PR.chatModel) await PR.chatModel.load();
    const job = PR.noteAi.run({ ed, url: "/api/p/" + PR.pid + "/notehelp", scope: sc, ask: text, title: o.tidy ? PR.t("AI 整理的版本") : "",
      body: { page, model: PR.chatModel ? PR.chatModel.id() : "", ...(PR.chatModel && PR.chatModel.web ? PR.chatModel.web() : PR.web.body()), ...(o.tidy ? { web: false } : {}) } });  // 整理只動排版：不用上網
    st.streaming.ctrl = job.ctrl;
    await job.done;
    st.streaming = null;
    st.scope = null;
    paintBar(key);
  }
  function paintBar(key) {
    const bar = panel().querySelector(".nai");
    if (!bar) return;
    const ta = bar.querySelector(".nai-in");
    if (ta) st.draft = ta.value;
    bar.outerHTML = PR.notesAi.bar(key || bar.dataset.naiKey);
  }

  // 按下去（還沒失焦）就記範圍；× 那顆、停止不算
  document.addEventListener("pointerdown", (e) => {
    const bar = e.target.closest && e.target.closest("#notespanel .nai");
    if (!bar || e.target.closest('[data-nai="unscope"], [data-nai="stop"], [data-nai="model"]')) return;
    const ta = e.target.closest(".nai-in");
    if (ta && document.activeElement === ta) return;  // 已經在輸入框裡打字：只是移游標
    grab(bar.dataset.naiKey);
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#notespanel [data-nai]");
    if (!b) return;
    const bar = b.closest(".nai"), key = bar.dataset.naiKey, ta = bar.querySelector(".nai-in");
    const a = b.dataset.nai;
    if (a === "send") return send(key, ta.value);
    if (a === "quick") return send(key, b.dataset.q);
    if (a === "tidy") return send(key, b.dataset.q, { tidy: true });
    if (a === "stop") { if (st.streaming && st.streaming.ctrl) st.streaming.ctrl.abort(); return; }
    if (a === "unscope") { st.scope = Object.assign({ key }, { from: null, to: null, picked: "", cursor: null }); const sc = bar.querySelector(".nai-scope"); if (sc) sc.outerHTML = chip(key); if (ta) ta.focus(); return; }
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
