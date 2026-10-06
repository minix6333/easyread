/* 就地問 AI：筆記卡片上的「讓 AI 回答／點評」和便利貼裡的提問，回答直接流進那張卡片，不用打開右邊的問 AI 面板。
   - 走的是同一個 /chat 接口：每一問是一個新對話（之後按「追問」會到問 AI 面板接著這個對話問），
     回答同時寫成這條筆記的回覆（discussion.json），所以收起、重開都還在。
   - 框選區域的問題：先請服務把那一塊從 PDF 渲染成圖，跟問題一起送給模型。
   - 用哪個模型：和問 AI 面板共用一個（PR.chatModel），卡片上可以直接換。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const ctrls = {};

  /* 流出來的字只改那一小塊，不重畫整張卡片（重畫會打斷正在選的字） */
  const paintLive = PR.throttle(() => {
    for (const nid of Object.keys(PR.liveAnswers)) {
      const l = PR.liveAnswers[nid];
      if (l.error) continue;
      PR.$$('.card[data-note="' + nid + '"] .reply.live').forEach((box) => {
        const body = box.querySelector(".body"), who = box.querySelector(".who");
        if (body && l.text) body.innerHTML = PR.mdBlocks(l.text);
        if (who && l.model) who.textContent = l.model;
      });
    }
    PR.layoutMargin && PR.layoutMargin();
  }, 80);

  function repaint() {
    PR.renderMargin();
    PR.renderPdfMarks && PR.renderPdfMarks();
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel();
    PR.renderSticky && PR.renderSticky();
  }

  PR.askInline = async function (nid) {
    const n = (S.reader.notes || {})[nid];
    if (!n || n.deleted || PR.asking.has(nid) || !(n.body || "").trim()) return;
    // 這句會以讀者的名義出現在對話記錄裡，所以跟著介面語言走
    const text = n.kind === "question" ? n.body : PR.t("这是我读这里时写的笔记，请点评：我理解得对不对、有没有漏掉或想错的地方、还可以往哪想。") + "\n\n" + PR.t("我的笔记：") + n.body;
    const live = (PR.liveAnswers[nid] = { text: "", model: (PR.chatModel && PR.chatModel.label()) || "", error: "" });
    PR.asking.add(nid);
    repaint();
    const ctrl = (ctrls[nid] = new AbortController());
    let thread = null, ok = false;
    try {
      if (PR.chatModel) await PR.chatModel.load();
      const images = [];
      if (n.region && n.page) {  // 框選的那一塊（跨頁的每一頁一張）
        for (const s of [{ page: n.page, rect: n.region }].concat(n.spans || []).slice(0, 6)) images.push((await PR.api("/api/p/" + PR.pid + "/clip", { method: "POST", body: { page: s.page, rect: s.rect } })).src);
      }
      const anchor = PR.blockById[n.anchor] ? n.anchor : "";
      const page = !anchor && n.side === "pdf" && n.page ? n.page : null;
      const refs = anchor || page ? [Object.assign({ anchor, quote: n.quote || "" }, page ? { page } : {})] : [];
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ thread: null, text, anchor: anchor || null, page, quote: n.quote || "", refs, note: nid, model: PR.chatModel ? PR.chatModel.id() : "", images, ...(n.mode && n.kind === "question" ? { mode: n.mode } : {}) }),
      });
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
          if (ev.thread) thread = ev.thread;
          if (ev.model) { live.model = ev.model; paintLive(); }
          if (ev.t) { live.text += ev.t; paintLive(); }
          if (ev.done) ok = true;
          if (ev.error) live.error = ev.error;
        }
      }
      if (!ok && !live.error) live.error = PR.t("回答沒有收完，請再試一次。");
    } catch (e) {
      live.error = e.name === "AbortError" ? PR.t("（已停止）") : PR.t("没能回答：{msg}", { msg: e.message });
    }
    PR.asking.delete(nid);
    delete ctrls[nid];
    if (!live.error) {
      // 回答已經寫進 discussion.json：直接取回來，別等輪詢（分頁在背景時輪詢是停的）
      try {
        const d = await PR.api("/api/p/" + PR.pid + "/part/discussion");
        S.discussion = d.data || { entries: [] };
        S.versions.discussion = d.version;
      } catch (e) { /* 下次輪詢會補上 */ }
      delete PR.liveAnswers[nid];
      const cur = (S.reader.notes || {})[nid];
      if (thread && cur && !cur.deleted && cur.thread !== thread) PR.saveNote(Object.assign({}, cur, { thread }));  // 「追問」時接著這個對話問
      PR.chatReload && PR.chatReload();
    }
    repaint();
  };
  PR.stopInline = (nid) => { if (ctrls[nid]) ctrls[nid].abort(); };

  /* 換了模型：卡片上的模型名字跟著換 */
  PR.on("chat-model", () => {
    const label = (PR.chatModel && PR.chatModel.label()) || PR.t("模型");
    PR.$$(".card .ask-model > span").forEach((el) => (el.textContent = label));
  });
})(window.PR);
