/* 複習一輪（閱讀頁的「卡片」、文獻庫側欄的「複習」都用這個）：一次一張，先看問題、想一想，空白鍵翻出答案，
   再按 1 再一次、2 困難、3 良好、4 簡單（按鈕上寫著多久之後再看到，srs.js 算的）。按了就存（POST /api/p/<pid>/cards，op: review）。
   「再一次」的卡排到這一輪的最後面再看一次。答案底下是依據：第幾頁、原話，點了打開那一頁。
   用鍵盤的動作、一天要按很多次：卡片換下一張沒有動畫，只有翻出答案那一下淡入。 */
(function (PR) {
  "use strict";
  let box = null, st = null;
  const loaded = {};
  const need = (src, css) => loaded[src] || (loaded[src] = new Promise((ok) => {
    const el = css ? Object.assign(document.createElement("link"), { rel: "stylesheet", href: src }) : Object.assign(document.createElement("script"), { src });
    el.onload = ok; el.onerror = ok;
    document.head.append(el);
  }));
  /* 文獻庫那一頁平常沒有載 Markdown 和公式的程式：第一次複習時才載 */
  const ready = () => (PR.md ? Promise.resolve() : Promise.all([need("/web/vendor/katex/katex.min.css", true), need("/web/vendor/katex/katex.min.js").then(() => need("/web/js/common/markup.js"))]));
  const md = (s) => (PR.md ? PR.md(s || "", { cite: false, xref: false }) : PR.esc(s || ""));
  const GRADES = () => [[1, PR.t("再一次")], [2, PR.t("困難")], [3, PR.t("良好")], [4, PR.t("簡單")]];

  /* cards：[{id, pid, q, a, page, quote, doc, srs}]；opts.title：這一輪叫什麼；opts.onDone(done)：關掉時（改過的卡） */
  PR.review = {
    async open(cards, opts) {
      opts = opts || {};
      const queue = (cards || []).filter((c) => c && c.id && c.pid);
      if (!queue.length) return PR.toast(PR.t("現在沒有要複習的卡"));
      await ready();
      st = { queue, total: queue.length, done: 0, flip: false, opts, changed: {}, again: 0 };
      if (!box) {
        box = PR.el("div", { class: "rv-wrap", role: "dialog", "aria-modal": "true" });
        document.body.append(box);
        box.addEventListener("click", onClick);
      }
      document.addEventListener("keydown", onKey, true);
      box.classList.add("open");
      render();
    },
    close,
    isOpen: () => !!(box && box.classList.contains("open")),
  };
  function close() {
    if (!box || !st) return;
    box.classList.remove("open");
    document.removeEventListener("keydown", onKey, true);
    const s = st;
    st = null;
    if (s.opts.onDone) s.opts.onDone(Object.values(s.changed));
  }

  function render() {
    const c = st.queue[0];
    if (!c) {  // 這一輪做完了
      box.innerHTML = '<div class="rv-card rv-end"><div class="rv-ic">' + PR.icon("check", "sm") + "</div><b>" + PR.esc(PR.t("這一輪複習完了")) + "</b>" +
        "<p>" + PR.esc(PR.t("{n} 張，下次到期的時候再看。", { n: st.total })) + '</p><button class="btn accent" data-rv="close">' + PR.t("完成") + "</button></div>";
      box.querySelector("[data-rv=close]").focus();
      return;
    }
    const now = Date.now(), pv = PR.srs.preview(c.srs, now);
    const src = c.page || c.quote ? '<button class="rv-src" data-rv="src" title="' + PR.esc(PR.t("打開原文那一頁")) + '">' + PR.icon("page", "sm") +
      "<span>" + (c.page ? "p." + c.page : "") + (c.quote ? (c.page ? " · " : "") + PR.t("「{q}」", { q: PR.esc(String(c.quote).slice(0, 140)) + (c.quote.length > 140 ? "…" : "") }) : "") + "</span></button>" : "";
    box.innerHTML = '<div class="rv-card">' +
      '<div class="rv-head"><span class="rv-n">' + PR.esc(PR.t("{i}／{n}", { i: st.done + 1, n: st.total + st.again })) + '</span><span class="rv-doc">' + PR.esc(c.doc || st.opts.title || "") + '</span><span class="grow"></span>' +
      '<button class="rv-x" data-rv="close" title="' + PR.t("關閉（Esc）") + '">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="rv-body"><div class="rv-q">' + md(c.q) + "</div>" +
      (st.flip ? '<div class="rv-a">' + md(c.a) + src + "</div>" : "") + "</div>" +
      '<div class="rv-foot">' + (st.flip
        ? GRADES().map(([g, name], i) => '<button class="rv-g g' + g + '" data-rv="grade" data-g="' + g + '"><b>' + PR.esc(name) + "</b><small>" + PR.esc(pv[i]) + '</small><kbd>' + g + "</kbd></button>").join("")
        : '<button class="btn accent rv-show" data-rv="show">' + PR.t("看答案") + '<kbd>' + PR.t("空白鍵") + "</kbd></button>") + "</div></div>";
    const f = box.querySelector(st.flip ? "[data-g='3']" : "[data-rv=show]");
    if (f) f.focus({ preventScroll: true });
  }

  async function grade(g) {
    const c = st.queue.shift();
    if (!c) return;
    const srs = PR.srs.next(c.srs, g);
    c.srs = srs;
    st.changed[c.pid + ":" + c.id] = c;
    if (g === 1) { st.queue.push(c); st.again++; } else st.done++;
    st.flip = false;
    render();
    try { await PR.api("/api/p/" + c.pid + "/cards", { method: "POST", body: { op: "review", id: c.id, srs } }); }
    catch (e) { PR.toast(PR.t("這次複習沒存成：{msg}", { msg: PR.esc(e.message) })); }
  }
  function openSource(c) {
    if (PR.pid === c.pid && PR.openPage && c.page) { close(); return PR.openPage(c.page); }  // 就是開著的這份：翻過去
    const url = "/read/" + c.pid + (c.page ? "#page=" + c.page : "");
    if (PR.navigate) PR.navigate(url); else location.href = url;
  }
  function onClick(e) {
    if (e.target === box) return close();
    const b = e.target.closest("[data-rv]");
    if (!b || !st) return;
    const k = b.dataset.rv;
    if (k === "close") return close();
    if (k === "show") { st.flip = true; return render(); }
    if (k === "grade") return grade(+b.dataset.g);
    if (k === "src") return openSource(st.queue[0]);
  }
  function onKey(e) {
    if (!st || !box.classList.contains("open")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return close(); }
    if (!st.queue.length) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); close(); } return; }
    if ((e.key === " " || e.key === "Enter") && !st.flip) { e.preventDefault(); e.stopPropagation(); st.flip = true; return render(); }
    if (st.flip && /^[1-4]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); return grade(+e.key); }
  }
})(window.PR);
