/* 問 AI 跟著你選的字走，還有把問 AI 拉成獨立視窗。
   - 選字：問 AI 開著（側邊或獨立視窗）時，在文件上選了字，輸入框上面就出現「選取：…」的標籤，這一問就是在問這一句
     （不用再按「引用」）。選的那段在文件上留一層淡底色，點到輸入框也不會消失；在文件上點一下（取消選取）、問完、按 × 就清掉。
   - 獨立視窗：面板標題列的按鈕把問 AI 開成另一個視窗（同一頁加上 ?chat=1，只畫面板）。主視窗繼續讀，
     讀到哪一頁、選了哪一句，透過 BroadcastChannel 告訴那個視窗；那邊點引用的出處，主視窗跳過去。
     關掉那個視窗（或按「收回」）問 AI 就回到側邊。主視窗關了，獨立視窗跟著關。
   訊息（頻道 easyread-chat-<文件 id>）：
     主視窗 → 獨立視窗：context {auto}、selection {sel}、ask {opts}、reload、reader-closed、ping
     獨立視窗 → 主視窗：hello、bye {dock}、go {anchor, page}、clear-sel、changed、pong
   獨立視窗有沒有還在：window.open 拿到的視窗看 closed；另外每 2 秒 ping 一次，6 秒沒回 pong 就當它關了（問 AI 回到側邊）。
   PR.chatLinkNormalize 是純函式（tests/test_chat_link.cjs）。 */
(function (PR) {
  "use strict";
  const only = /[?&]chat=1(&|$)/.test(location.search);
  PR.chatOnly = only;
  if (only) document.documentElement.classList.add("chat-only");
  const chan = typeof BroadcastChannel !== "undefined" && PR.pid ? new BroadcastChannel("easyread-chat-" + PR.pid) : null;
  const post = (msg) => { if (chan) chan.postMessage(msg); };
  const HL = "ai-sel";
  let popped = false, pop = null, watch = 0, lastPong = 0;

  /* 純函式：選取 → 送給問 AI 的引用（太短的不算；原話最多 1000 字） */
  PR.chatLinkNormalize = function (s) {
    if (!s) return null;
    const quote = String(s.quote || "").replace(/\s+/g, " ").trim();
    if (quote.length < 2 || !(s.anchor || s.page)) return null;
    return { anchor: s.anchor || "", quote: quote.slice(0, 1000), ...(s.page ? { page: s.page } : {}) };
  };

  /* ---------- 選字 ---------- */
  const listening = () => !only && PR.canChat && PR.canChat() && (popped || (PR.chatOpen && PR.chatOpen()));
  function paintHighlight(range) {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    if (range) CSS.highlights.set(HL, new Highlight(range)); else CSS.highlights.delete(HL);
  }
  function setSel(sel, range) {
    paintHighlight(sel ? range : null);
    if (popped) post({ type: "selection", sel });
    else if (PR.chatSel) PR.chatSel.set(sel);
  }
  function capture() {
    if (!listening() || document.body.classList.contains("region-mode")) return;
    const s = window.getSelection();
    const node = s && s.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest || !el.closest("#paper, #pageview .pv-text")) return;  // 焦點到了別處（輸入框、面板）：上次選的留著
    if (s.isCollapsed) return setSel(null);  // 在文件上點了一下：取消
    const sel = PR.chatLinkNormalize(PR.readSelection && PR.readSelection());
    if (sel) setSel(sel, s.getRangeAt(0).cloneRange());
  }
  if (!only) {
    document.addEventListener("mouseup", (e) => { if (!(e.target.closest && e.target.closest("#chatpanel, #selbar, #blockbar, .ch-aside"))) setTimeout(capture, 20); });
    document.addEventListener("keyup", (e) => { if (e.shiftKey && e.key.startsWith("Arrow")) capture(); });
  }
  PR.chatLink = {
    capture,
    /* 問完、按了 ×：文件上那層底色也收掉 */
    cleared() { if (only) post({ type: "clear-sel" }); else paintHighlight(null); },
    popped: () => popped,
    /* chat.js 的入口先問這裡：問 AI 在獨立視窗時，把事情轉過去（回 true 表示已處理） */
    forward(kind, opts) {
      if (only || !popped) return false;
      if (pop && pop.closed) { undock(false); return false; }
      if (kind === "ask") post({ type: "ask", opts });
      try { pop && pop.focus(); } catch (e) { /* 視窗焦點要不到就算了 */ }
      return true;
    },
    go(anchor, page) { post({ type: "go", anchor: anchor || "", page: page || 0 }); },
    changed() { if (only) post({ type: "changed" }); },
    reload() { if (popped) post({ type: "reload" }); },
  };

  /* ---------- 主視窗這一邊 ---------- */
  function sendContext() {
    if (!popped) return;
    post({ type: "context", auto: PR.chatAutoContext ? PR.chatAutoContext() : null });
  }
  function docked() {  // 獨立視窗開著（剛開、或它回了話）
    lastPong = Date.now();
    if (popped) return;
    popped = true;
    document.body.classList.add("chat-popped");
    if (PR.chatOpen && PR.chatOpen()) PR.openSide(null);
    clearInterval(watch);
    watch = setInterval(() => {
      if (!popped) return;
      if ((pop && pop.closed) || Date.now() - lastPong > 6000) return undock(false);
      post({ type: "ping" });
    }, 2000);
  }
  function undock(open, thread) {
    popped = false; pop = null;
    clearInterval(watch);
    document.body.classList.remove("chat-popped");
    paintHighlight(null);
    if (thread && PR.chatUse) PR.chatUse(thread);  // 接著獨立視窗裡正在看的那個對話
    PR.chatReload && PR.chatReload();
    if (open && PR.toggleChat) PR.toggleChat(true);
  }
  PR.chatPopout = function () {
    if (only || !chan) return;
    if (popped && pop && !pop.closed) { try { pop.focus(); } catch (e) { /* 同上 */ } return; }
    const w = 480, h = Math.min(820, Math.max(520, (window.screen && screen.availHeight) || 800) - 80);
    const left = Math.max(0, ((window.screen && screen.availWidth) || 1440) - w - 24);
    const cur = PR.chatCurrent && PR.chatCurrent();  // 接著側邊正在看的那個對話
    pop = window.open("/read/" + encodeURIComponent(PR.pid) + "?chat=1" + (cur && !/^local-/.test(cur) ? "&thread=" + encodeURIComponent(cur) : ""), "easyread-chat-" + PR.pid, "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=60");
    if (!pop) return PR.toast(PR.t("視窗沒開成（被瀏覽器擋下來了）"));
    docked();
  };
  if (!only && chan) {
    chan.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "hello") {  // 獨立視窗開好了（或重新整理了）
        docked();
        sendContext();
        capture();
      } else if (m.type === "pong") docked();
      else if (m.type === "bye") undock(!!m.dock, m.thread);
      else if (m.type === "go") { if (m.anchor && PR.blockById[m.anchor]) PR.jumpTo("b-" + m.anchor); else if (m.page && PR.openPage) PR.openPage(+m.page); window.focus(); }
      else if (m.type === "clear-sel") paintHighlight(null);
      else if (m.type === "changed") PR.poll && PR.poll();
    };
    const follow = PR.debounce(sendContext, 400);
    window.addEventListener("scroll", follow, { passive: true });
    const pv = PR.$(".pv-scroll");
    if (pv) pv.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("pagehide", () => { if (popped) post({ type: "reader-closed" }); });
  }

  /* ---------- 獨立視窗這一邊 ---------- */
  if (only && chan) {
    let docking = false;
    chan.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "context") PR.chatSetAuto && PR.chatSetAuto(m.auto || null);
      else if (m.type === "selection") PR.chatSel && PR.chatSel.set(m.sel || null);
      else if (m.type === "ask") { PR.chatAsk && PR.chatAsk(m.opts || {}); window.focus(); }
      else if (m.type === "reload") PR.chatReload && PR.chatReload();
      else if (m.type === "reader-closed") window.close();
      else if (m.type === "ping") post({ type: "pong" });
    };
    const bye = () => post({ type: "bye", dock: true, thread: (PR.chatCurrent && PR.chatCurrent()) || "" });
    PR.chatDock = function () { docking = true; bye(); window.close(); };
    window.addEventListener("pagehide", () => { if (!docking) bye(); });
    PR.chatHello = () => post({ type: "hello" });
  }
})(window.PR);
