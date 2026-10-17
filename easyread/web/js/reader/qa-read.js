/* 打開閱讀：一則提問排成一篇短文，放在畫面中間的一張紙上看——問題是標題，原文是引言，AI 的回答是正文，
   之後在問 AI 面板裡接著問的（追問）一段一段接在後面。卡片很窄、長的回答收著，回頭要再看一次時用這個。
   卡片上的「打開閱讀」「繼續閱讀」、卡片的選單都開這裡；Esc、點紙外面、× 關掉。
   點了才開，只有一下淡入（不縮放、不滑動）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let box = null, back = null, seq = 0;
  const noteOf = (id) => { const n = (S.reader.notes || {})[id]; return n && !n.deleted ? n : null; };
  const pageOf = (n) => (n.side === "pdf" && n.page) || (PR.blockById[n.anchor] || {}).page || 0;
  const by = (who, at) => '<div class="qar-by">' + PR.esc(who || "AI") + (at ? '<span class="qar-at">' + PR.esc(PR.shortTime(at)) + "</span>" : "") + "</div>";

  function close() {
    if (!box) return;
    box.remove();
    box = null;
    seq++;
    window.removeEventListener("keydown", onKey, true);
    if (back && back.isConnected) back.focus({ preventScroll: true });
    back = null;
  }
  /* 開著的時候按鍵只給這張紙：Esc 關掉；其餘的不讓底下的閱讀頁收到（方向鍵不翻 PDF、Q 不開提問），
     但不擋預設的動作（方向鍵、空白鍵捲這篇，⌘C 複製選的字） */
  function onKey(e) {
    if (!box) return;
    e.stopPropagation();
    if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); close(); }
  }

  /* 整篇的 Markdown（複製用）：標題、引言、回答，追問接在後面 */
  function markdown(n, replies, more) {
    const out = ["# " + (n.body || "").trim().replace(/\n+/g, " ")];
    if (n.quote) out.push(n.quote.trim().split("\n").map((l) => "> " + l).join("\n"));
    for (const r of replies) out.push((r.body || "").trim());
    for (const [q, a] of more) out.push("## " + (q.content || "").trim().replace(/\n+/g, " "), (a.content || "").trim());
    return out.filter(Boolean).join("\n\n") + "\n";
  }

  PR.canReadQa = (id) => { const n = noteOf(id); return !!(n && n.kind === "question" && PR.repliesTo(id).length); };
  PR.openQa = function (id, from) {
    const n = noteOf(id);
    if (!n) return;
    const replies = PR.repliesTo(id);
    if (!replies.length) return;
    close();
    back = from || document.activeElement;
    const mine = ++seq;
    const page = pageOf(n);
    let more = [];
    const kicker = [page ? PR.t("第 {p} 頁", { p: page }) : "", PR.shortTime(n.created || n.updated)].filter(Boolean).join(" · ");  // 問的時候（之後改過位置、接上對話也會更新 updated）
    const ctx = (n.region ? PR.clipHtml(n, 300) : "") +
      (n.quote ? '<blockquote class="qar-q"' + (n.side === "en" || n.side === "pdf" ? ' lang="en"' : "") + ">" + PR.md(n.quote, { cite: false, xref: false }) + "</blockquote>" : "");
    const btn = (a, icon, title) => '<button class="btn icon" data-qa="' + a + '" title="' + PR.esc(title) + '" aria-label="' + PR.esc(title) + '">' + PR.icon(icon, "sm") + "</button>";
    box = document.createElement("div");
    box.id = "qar";
    box.innerHTML = '<div class="qar" role="dialog" aria-modal="true" tabindex="-1" aria-label="' + PR.esc(PR.plain ? PR.plain(n.body || "") : n.body || "") + '">' +
      '<div class="qar-hd"><span class="qar-kick">' + PR.esc(kicker) + '</span><span class="grow"></span>' +
      btn("go", "page", PR.t("跳到原文的位置")) +
      (PR.canChat && PR.canChat() && PR.feature("chat") ? btn("follow", "message", PR.t("追问 AI")) : "") +
      btn("copy", "copy", PR.t("複製全文（Markdown）")) + btn("close", "x", PR.t("关闭")) + "</div>" +
      '<div class="qar-body" tabindex="-1"><article class="qar-doc"><h1>' + PR.md(n.body || "", { xref: false }) + "</h1>" + ctx +
      replies.map((r) => '<div class="qar-ans">' + PR.mdBlocks(r.body || "") + "</div>" + by(r.by, r.updated || r.at)).join("") +
      '<div class="qar-more"></div></article></div></div>';
    document.body.append(box);
    window.addEventListener("keydown", onKey, true);
    box.querySelector(".qar-body").focus({ preventScroll: true });  // 方向鍵、空白鍵直接捲這篇
    box.addEventListener("mousedown", (e) => { if (e.target === box) close(); });
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-qa]");
      if (b) {
        const a = b.dataset.qa;
        if (a === "close") close();
        else if (a === "go") { close(); PR.goToNote && PR.goToNote(id); }
        else if (a === "follow") { close(); PR.followUp && PR.followUp(id); }
        else if (a === "copy") navigator.clipboard.writeText(markdown(n, replies, more)).then(() => PR.toast(PR.t("已复制"), null, 1200));
        return;
      }
      // 回答裡的連結：跳到文章、PDF 裡的位置之前先收起來（不然跳過去了也被這張紙蓋著）；外部網址照常開
      const link = e.target.closest("a");
      if (link && (link.matches("a.cite, a.xref") || !/^https?:/i.test(link.getAttribute("href") || ""))) close();
    });
    // 之後在問 AI 面板裡接著問的：從對話記錄拿（第一問就是這張卡片上的，跳過）
    if (!n.thread || !(PR.store && PR.store.mode === "server")) return;
    PR.api("/api/p/" + PR.pid + "/chat").then((d) => {
      if (mine !== seq || !box) return;
      const t = (d.threads || []).find((x) => x.id === n.thread);
      const msgs = (t && t.messages) || [];
      for (let i = 2; i + 1 < msgs.length; i += 2) if (msgs[i].role === "user" && msgs[i + 1].role === "assistant" && (msgs[i + 1].content || "").trim()) more.push([msgs[i], msgs[i + 1]]);
      box.querySelector(".qar-more").innerHTML = more.map(([q, a]) => '<section class="qar-sec"><h2>' + PR.md(q.content || "", { xref: false }) + "</h2>" +
        '<div class="qar-ans">' + PR.mdBlocks(a.content || "") + "</div>" + by(a.model, a.at) + "</section>").join("");
    }).catch(() => { /* 讀不到對話記錄：只看第一問 */ });
  };
  PR.closeQa = close;
})(window.PR);
