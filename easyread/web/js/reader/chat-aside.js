/* 聊天裡「這句是什麼意思？」：在回答裡選一段字，冒出一顆「問這句」；點了開一個小視窗另外問，原本的對話不動。
   - 小視窗可以拖（抓標題列）、可以拉大小（右下角）；大小記著。裡面可以繼續追問，回答一樣可以複製、加入筆記。
   - 它自己是一個對話：chat.json 裡標著接在哪段回答、哪一句（aside），提示詞會帶上那段回答；之後在對話清單裡看得到（↳ 開頭）。
   - 小視窗裡的回答再選字，可以再開一個（上一個收起）。 */
(function (PR) {
  "use strict";
  const SIZE = "easyread-aside-size";
  let a = null;        // 開著的小視窗 {thread, parent:{thread,msg}, quote, msgs, streaming, box, draft}
  let pending = null;  // 「問這句」那顆小按鈕對應的選取

  const pill = () => {
    let p = PR.$("#askline");
    if (!p) {
      p = PR.el("button", { id: "askline", class: "askline", title: PR.t("對這句另外問（原本的對話不動）") });
      p.innerHTML = PR.icon("help", "sm") + "<span>" + PR.t("問這句") + "</span>";
      document.body.append(p);
    }
    return p;
  };
  /* 選的字在哪段回答裡（主面板或小視窗；還在寫的那段沒有 id，不算） */
  function selectionInAnswer() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 600) return null;
    const range = sel.getRangeAt(0), node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const body = el && el.closest && el.closest(".cm.ai .body");
    const msg = body && body.closest(".cm.ai");
    if (!msg || !msg.dataset.id) return null;
    const host = msg.closest("#chatpanel, .ch-aside");
    const thread = host && host.id === "chatpanel" ? PR.chatCurrent && PR.chatCurrent() : a && a.thread;
    if (!thread || !(PR.canChat && PR.canChat())) return null;
    return { text, rect: range.getBoundingClientRect(), msg: msg.dataset.id, thread };
  }
  function showPill() {
    const s = selectionInAnswer(), p = pill();
    pending = s;
    if (!s) { p.classList.remove("open"); return; }
    p.classList.add("open");
    const w = p.offsetWidth, h = p.offsetHeight;
    p.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, s.rect.left + s.rect.width / 2 - w / 2))) + "px";
    p.style.top = Math.round(s.rect.top - h - 8 < 8 ? s.rect.bottom + 8 : s.rect.top - h - 8) + "px";
  }
  document.addEventListener("mouseup", (e) => { if (e.target.closest && e.target.closest("#askline")) return; setTimeout(showPill, 10); });
  document.addEventListener("selectionchange", PR.debounce(() => { const s = getSelection(); if (!s || s.isCollapsed) { pill().classList.remove("open"); pending = null; } }, 120));
  document.addEventListener("mousedown", (e) => {
    const p = e.target.closest && e.target.closest("#askline");
    if (!p || !pending) return;
    e.preventDefault();
    const s = pending;
    pending = null;
    p.classList.remove("open");
    open(s);
  });

  /* ---------- 小視窗 ---------- */
  function open(s) {
    close();
    a = { thread: null, parent: { thread: s.thread, msg: s.msg }, quote: s.text, msgs: [], streaming: null, draft: "" };
    const box = PR.el("div", { class: "ch-aside" });
    document.body.append(box);
    a.box = box;
    const size = PR.ls.get(SIZE, null) || {};
    const w = Math.min(innerWidth - 24, Math.max(300, size.w || 440)), h = Math.min(innerHeight - 24, Math.max(220, size.h || 440));
    box.style.width = w + "px"; box.style.height = h + "px";
    // 放在選的那句左邊（面板在右邊，左邊通常是正文）；左邊不夠就放在那句下面
    let left = s.rect.left - w - 16, top = s.rect.top - 24;
    if (left < 8) { left = Math.min(innerWidth - w - 8, Math.max(8, s.rect.left)); top = s.rect.bottom + 12; }
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(Math.max(8, Math.min(innerHeight - h - 8, top))) + "px";
    render();
    focusInput();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(PR.debounce(() => { if (a && a.box === box) PR.ls.set(SIZE, { w: box.offsetWidth, h: box.offsetHeight }); }, 300));
      ro.observe(box);
      a.ro = ro;
    }
  }
  function close() {
    if (!a) return;
    if (a.streaming) a.streaming.ctrl.abort();
    if (a.ro) a.ro.disconnect();
    a.box.remove();
    a = null;
  }
  PR.asideClose = close;
  const focusInput = () => setTimeout(() => { const t = a && a.box.querySelector("textarea"); if (t) t.focus(); }, 60);

  const CHIPS = () => [[PR.t("這是什麼意思？"), ""], [PR.t("舉個例子"), ""], [PR.t("推導"), "derive"], [PR.t("圖解"), "diagram"]];
  function msgHtml(m) {
    if (m.role === "user") return '<div class="cm user"><div class="bubble">' + PR.md(m.content, { cite: false, xref: false }) + "</div></div>";
    const live = a.streaming && a.streaming.msg === m;
    return '<div class="cm ai' + (m.error ? " err" : "") + '" data-id="' + PR.esc(m.id || "") + '"><div class="who"><span class="av">' + PR.icon("bot", "sm") + "</span>" + PR.esc(m.model || "AI") + (live ? ' <span class="spin"></span>' : "") + "</div>" +
      '<div class="body">' + (m.error ? PR.esc(m.error) : m.content ? PR.mdBlocks(m.content) : '<p class="thinking"><i></i><i></i><i></i></p>') + "</div>" +
      (!live && !m.error && m.id ? '<div class="acts"><button data-ca="copy">' + PR.icon("copy", "sm") + PR.t("复制") + '</button><button data-ca="tonote">' + PR.icon("notebook", "sm") + PR.t("加入筆記") + "</button></div>" : "") + "</div>";
  }
  function render() {
    if (!a) return;
    const ta = a.box.querySelector("textarea");
    if (ta) a.draft = ta.value;
    const q = a.quote.replace(/\s+/g, " ");
    a.box.innerHTML = '<div class="ca-head"><span class="ca-quote" title="' + PR.esc(a.quote) + '"><b>' + PR.t("問這句") + "</b>" + PR.esc(q.length > 60 ? q.slice(0, 60) + "…" : q) + "</span>" +
      '<button class="btn icon" data-ca="close" title="' + PR.t("关闭") + '">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="ca-body">' + (a.msgs.length ? a.msgs.map(msgHtml).join("")
        : '<p class="hint">' + PR.t("針對這句另外問，原本的對話不會動。") + '</p><div class="qchips">' + CHIPS().map(([l, m]) => '<button data-cq="' + PR.esc(l) + '"' + (m ? ' data-mode="' + m + '"' : "") + ">" + l + "</button>").join("") + "</div>") + "</div>" +
      '<div class="ca-compose"><textarea rows="1" placeholder="' + PR.t("想問什麼？") + '">' + PR.esc(a.draft) + "</textarea>" +
      (a.streaming ? '<button class="ch-send stop" data-ca="stop" title="' + PR.t("停止") + '">' + PR.icon("stop", "sm") + "</button>"
        : '<button class="ch-send" data-ca="send" title="' + PR.t("发送（Enter）；换行用 Shift+Enter") + '">' + PR.icon("arrowUp", "sm") + "</button>") + "</div>";
    const body = a.box.querySelector(".ca-body");
    body.scrollTop = body.scrollHeight;
    const input = a.box.querySelector("textarea");
    if (input) PR.autosize(input);
  }
  const paint = PR.throttle(() => {
    const node = a && a.streaming && a.box.querySelector(".ca-body .cm.ai:last-child .body");
    if (!node) return;
    const text = a.streaming.msg.content;
    node.innerHTML = text ? PR.mdBlocks(text) : '<p class="thinking"><i></i><i></i><i></i></p>';
    const body = a.box.querySelector(".ca-body");
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 120) body.scrollTop = body.scrollHeight;
  }, 80);

  async function send(text, mode) {
    text = (text || "").trim();
    if (!a || !text || a.streaming) return;
    const mine = a;
    if (PR.chatModel) await PR.chatModel.load();
    const user = { role: "user", content: text };
    const msg = { role: "assistant", content: "", model: (PR.chatModel && PR.chatModel.label()) || "AI" };
    a.msgs.push(user, msg);
    const ctrl = new AbortController();
    a.streaming = { ctrl, msg };
    a.draft = "";
    render();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify(Object.assign({ thread: a.thread, text, model: PR.chatModel ? PR.chatModel.id() : "" }, mode ? { mode } : {},
          a.thread ? {} : { aside: { thread: a.parent.thread, msg: a.parent.msg, quote: a.quote } })),
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
          if (ev.thread) mine.thread = ev.thread;
          if (ev.model) msg.model = ev.model;
          if (ev.t) { msg.content += ev.t; paint(); }
          if (ev.done) msg.id = ev.id;
          if (ev.error) msg.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") msg.content += "\n\n" + PR.t("（已停止）");
      else msg.error = PR.t("没能回答：{msg}", { msg: e.message });
    }
    if (a !== mine) return;  // 已經關掉或換了一個
    a.streaming = null;
    render();
    focusInput();
    PR.chatReload && PR.chatReload();  // 主面板的對話清單裡也看得到這個小對話
  }

  /* ---------- 事件 ---------- */
  document.addEventListener("click", (e) => {
    if (!a || !a.box.contains(e.target)) return;
    const chip = e.target.closest("[data-cq]");
    if (chip) return send(chip.dataset.cq, chip.dataset.mode);
    const b = e.target.closest("[data-ca]");
    if (!b) return;
    const c = b.dataset.ca;
    if (c === "close") return close();
    if (c === "send") return send(a.box.querySelector("textarea").value);
    if (c === "stop") return a.streaming && a.streaming.ctrl.abort();
    const card = b.closest(".cm.ai"), m = card && a.msgs.find((x) => x.id && x.id === card.dataset.id);
    if (!m) return;
    if (c === "copy") navigator.clipboard.writeText(m.content).then(() => PR.toast(PR.t("已复制")));
    if (c === "tonote") {
      const i = a.msgs.indexOf(m), q = i > 0 ? a.msgs[i - 1] : null;
      PR.noteAddMenu(b, { title: PR.t("「{q}」", { q: a.quote.replace(/\s+/g, " ").slice(0, 60) }) + (q ? " — " + q.content : ""), body: m.content, page: PR.pdfMain && PR.pdfMain() && PR.pdfPage ? PR.pdfPage() : 0 });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!a) return;
    const inBox = a.box.contains(e.target);
    if (e.key === "Escape" && (inBox || !e.target.matches("input, textarea"))) { e.preventDefault(); return close(); }
    if (inBox && e.target.matches("textarea") && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
  });
  document.addEventListener("input", (e) => { if (a && a.box.contains(e.target) && e.target.matches("textarea")) PR.autosize(e.target); });
  /* 抓標題列拖 */
  document.addEventListener("mousedown", (e) => {
    const hd = a && e.target.closest && e.target.closest(".ch-aside .ca-head");
    if (!hd || e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const box = a.box, x0 = e.clientX, y0 = e.clientY, l0 = box.offsetLeft, t0 = box.offsetTop;
    box.classList.add("dragging");
    const move = (ev) => {
      box.style.left = Math.round(Math.max(-box.offsetWidth + 80, Math.min(innerWidth - 80, l0 + ev.clientX - x0))) + "px";
      box.style.top = Math.round(Math.max(0, Math.min(innerHeight - 40, t0 + ev.clientY - y0))) + "px";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); box.classList.remove("dragging"); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
})(window.PR);
