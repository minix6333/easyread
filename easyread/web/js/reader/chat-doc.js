/* 問 AI 面板標題列的「AI 讀過的範圍」：這份文件 AI 讀過了沒、每一問帶多少內容，還有補充資料。
   - 預讀（preread.py）：匯入、翻譯、第一次提問時在背景讓 AI 把整份（含補充資料）讀一遍，寫成全文筆記；這裡看得到進度，可以叫它重讀或停下。
   - 整份不長（約 12 萬字以內）：每個對話都把整份文字帶上。更長：帶全文筆記、全文地圖和跟問題最相關的幾頁。
   - 補充資料：另外附的 PDF（supplementary、附錄檔、解答）——加了之後 AI 會和本文一起讀；可以打開、拿掉。
   PR.chatDoc.button() 給 chat.js 放進標題列；PR.chatDoc.summary(d) 是純函式（tests/test_chat_doc.cjs）。 */
(function (PR) {
  "use strict";
  const st = { d: null, open: false, timer: 0, busy: false };
  const panel = () => PR.$("#chatpanel");
  const wan = (n) => (n >= 10000 ? PR.t("{w} 萬字", { w: Math.round(n / 1000) / 10, k: Math.round(n / 1000) }) : n + PR.t(" 字"));  // 英文用 {k}（千字）

  /* 純函式：狀態 → 一句話（按鈕的提示、彈出框第一行） */
  function summary(d) {
    if (!d || !d.pages) return PR.t("這份文件還沒準備好");
    const sup = (d.supp || []).length;
    const what = PR.t("本文 {n} 頁", { n: d.pages }) + (sup ? PR.t("＋補充資料 {n} 份", { n: sup }) : "");
    if (d.state === "running") return PR.t("AI 正在讀整份（{what}）…", { what }) + (d.total > 1 ? " " + d.done + "/" + d.total : "");
    if (d.state === "done") return PR.t("AI 已讀過整份（{what}）", { what });
    if (d.state === "stale") return PR.t("內容變了，AI 的全文筆記是舊的（{what}）", { what });
    if (d.state === "error") return PR.t("AI 沒讀成整份（{what}）", { what });
    return PR.t("AI 還沒讀過整份（{what}）", { what });
  }
  const icon = (d) => (!d ? "book" : d.state === "done" ? "read" : "book");

  async function load() {
    if (!PR.canChat || !PR.canChat()) return;
    try { st.d = await PR.api("/api/p/" + PR.pid + "/brief"); } catch (e) { return; }
    paint();
    clearTimeout(st.timer);
    if (st.d.state === "running") st.timer = setTimeout(load, 2500);
  }
  function paint() {
    const b = PR.$("#chatpanel [data-c='doc']");
    if (b) { b.outerHTML = PR.chatDoc.button(); }
    const pop = PR.$("#chatDocPop");
    if (st.open) { if (pop) pop.outerHTML = popHtml(); else panel().insertAdjacentHTML("beforeend", popHtml()); } else if (pop) pop.remove();
  }
  function popHtml() {
    const d = st.d || {};
    const running = d.state === "running";
    const how = !d.chars ? "" : d.whole ? PR.t("每個對話都會把整份文字帶給 AI（{size}）。", { size: wan(d.chars) })
      : PR.t("這份很長（{size}），一次帶不完：每一問帶全文筆記、全文地圖，和跟問題最相關的幾頁。", { size: wan(d.chars) });
    const note = running ? PR.t("正在讀，讀完之後每一問都會帶著全文筆記。")
      : d.state === "done" ? PR.t("全文筆記：{model} 寫於 {when}", { model: PR.esc(d.model || "AI"), when: PR.esc(PR.shortTime(d.at)) })
      : d.state === "stale" ? PR.t("補充資料或內容變過，全文筆記要重讀才會包含新的部分。")
      : d.state === "error" ? PR.t("上次沒讀成：{msg}", { msg: PR.esc(d.error || "") })
      : d.too_long ? PR.t("這份太長，不會自動讀；要讀大約需要 {n} 次請求。", { n: d.calls })
      : !d.engine ? PR.t("還沒設定模型，沒辦法讀。") : d.auto ? PR.t("第一次提問時會在背景開始讀。") : PR.t("自動預讀關著（設定 → 模型）。");
    const act = !d.engine || !d.chars ? "" : running
      ? '<button class="btn sm" data-d="cancel">' + PR.t("停止") + "</button>"
      : '<button class="btn sm' + (d.state === "done" ? "" : " accent") + '" data-d="start">' + (d.state === "done" ? PR.t("重新讀一遍") : PR.t("現在讀")) + "</button>";
    const supp = (d.supp || []).map((s) => '<div class="cd-supp"><span class="k">' + PR.esc(s.key) + '</span><a href="/p/' + PR.pid + "/supp/" + encodeURIComponent(s.file) + '" target="_blank" rel="noopener" title="' + PR.t("打開這份 PDF") + '">' + PR.esc(s.name) + "</a>" +
      '<span class="m">' + (s.pages ? PR.t("{n} 頁", { n: s.pages }) : PR.t("抽不出文字")) + '</span><button data-d="unsupp" data-f="' + PR.esc(s.file) + '" title="' + PR.t("拿掉這份補充資料") + '">×</button></div>').join("");
    return '<div class="ch-docpop" id="chatDocPop"><div class="cd-h">' + PR.icon(icon(d), "sm") + "<b>" + PR.esc(summary(d)) + "</b>" + (running ? '<span class="spin"></span>' : "") + "</div>" +
      (how ? '<p class="cd-p">' + how + "</p>" : "") +
      '<div class="cd-row"><span class="cd-note">' + note + "</span>" + act + "</div>" +
      '<div class="cd-sec">' + PR.t("補充資料") + "</div>" + (supp || '<p class="cd-p dim">' + PR.t("另外的 supplementary、附錄檔、解答可以加進來，AI 會和本文一起讀。") + "</p>") +
      '<button class="btn sm cd-add" data-d="addsupp"' + (st.busy ? " disabled" : "") + ">" + PR.icon("plus", "sm") + (st.busy ? PR.t("正在加入…") : PR.t("加入補充資料（PDF）")) + "</button></div>";
  }
  async function post(body) {
    try { st.d = await PR.api("/api/p/" + PR.pid + "/brief", { method: "POST", body }); } catch (e) { PR.toast(PR.esc(e.message)); }
    paint();
    clearTimeout(st.timer);
    if (st.d && st.d.state === "running") st.timer = setTimeout(load, 2000);
  }
  async function addSupp(files) {
    const list = Array.from(files || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!list.length) return PR.toast(PR.t("補充資料只能是 PDF 檔"));
    st.busy = true; paint();
    for (const f of list) {
      try {
        const r = await fetch("/api/p/" + PR.pid + "/supp?name=" + encodeURIComponent(f.name), { method: "POST", headers: { "Content-Type": "application/pdf", "X-Token": PR.token || "" }, body: f });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        st.d = d;
      } catch (e) { PR.toast(PR.t("沒加成：{msg}", { msg: PR.esc(e.message) })); }
    }
    st.busy = false; paint();
    clearTimeout(st.timer);
    if (st.d && st.d.state === "running") st.timer = setTimeout(load, 2000);
  }

  PR.chatDoc = {
    summary,
    refresh: load,
    state: () => st.d,
    button() {
      const d = st.d, s = d ? d.state : "none";
      return '<button class="btn icon ch-doc s-' + s + (st.open ? " on" : "") + '" data-c="doc" title="' + PR.esc(summary(d)) + "\n" + PR.t("點開看 AI 讀了什麼、加入補充資料") + '">' + PR.icon(icon(d), "sm") + (s === "running" ? '<i class="dot run"></i>' : s === "done" ? "" : '<i class="dot"></i>') + "</button>";
    },
    toggle(force) { st.open = force != null ? force : !st.open; paint(); if (st.open) load(); },
    isOpen: () => st.open,
  };

  document.addEventListener("click", async (e) => {
    if (st.open && !e.target.closest("#chatDocPop, [data-c='doc']")) { st.open = false; paint(); }
    const b = e.target.closest && e.target.closest("#chatDocPop [data-d]");
    if (!b) return;
    const a = b.dataset.d;
    if (a === "start") return post({ action: "start", model: PR.chatModel ? PR.chatModel.id() : "" });
    if (a === "cancel") return post({ action: "cancel" });
    if (a === "addsupp") {
      const f = document.createElement("input");
      f.type = "file"; f.accept = "application/pdf,.pdf"; f.multiple = true;
      f.onchange = () => addSupp(f.files);
      return f.click();
    }
    if (a === "unsupp") {
      if (!(await PR.confirm({ title: PR.t("拿掉這份補充資料？"), body: PR.t("「{name}」會從這份文件裡刪掉，AI 之後不會再讀到它。", { name: b.dataset.f }), ok: PR.t("拿掉"), danger: true, at: b }))) return;
      try {
        const r = await fetch("/api/p/" + PR.pid + "/supp", { method: "POST", headers: { "Content-Type": "application/json", "X-Token": PR.token || "" }, body: JSON.stringify({ remove: b.dataset.f }) });
        st.d = await r.json();
      } catch (err) { PR.toast(PR.esc(err.message)); }
      paint();
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && st.open) { st.open = false; paint(); } });
})(window.PR);
