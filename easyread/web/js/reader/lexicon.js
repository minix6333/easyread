/* 術語與符號（閱讀頁）：AI 整理的這份文件的術語表（lexicon.json，伺服器 lexicon.py）。
   - 左邊欄的「術語」分頁：搜尋；術語／符號兩格（翻譯過的文件還有「譯名」——原本改譯法的那張表）；
     每一條：術語（符號用公式畫）、在這份文件裡的意思、原文的定義句、第幾頁（點了翻過去）；做成複習卡、問 AI。
     還沒整理過：一顆「請 AI 整理」（花一次額度，大約半分鐘到一分鐘）。
   - 選到術語表裡有的詞：選字工具列多一顆「術語」，點了在選的字旁邊出現它的解釋。
   問 AI 的提示詞裡也帶著這張表（chat.py），回答會照這份文件的記號和說法講。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let lex = null, loading = null, building = null, seg = PR.ls.get("easyread-lex-seg", "term"), query = "";
  const load = () => loading || (loading = PR.api("/api/p/" + PR.pid + "/lexicon").then((d) => (lex = d || { items: [] }), () => (lex = { items: [] })));
  const items = () => ((lex && lex.items) || []);
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s­]+/g, " ").replace(/^[\s\x22“'‘(（[]+|[\s\x22”'’)）\].,;:，。；：]+$/g, "").trim();  // i18n-ok（引號寫成 \x22，免得 i18n 檢查以為字串沒關）
  const sym = (x) => (PR.tex ? PR.tex(x.t, false) : PR.esc(x.t));
  const nameHtml = (x) => (x.k === "symbol" ? '<span class="lx-sym">' + sym(x) + "</span>" : PR.esc(x.t));
  const repaint = () => { if (PR.navTab && PR.navTab() === "terms" && PR.renderNav) PR.renderNav(); };

  /* 選到的字是不是表裡的某一條：整個詞對得上（大小寫不管），「全稱 (縮寫)」的全稱或縮寫都算 */
  PR.lexMatch = function (text) {
    const q = norm(text);
    if (!q || q.length > 80) return null;
    for (const x of items()) {
      if (x.k === "symbol") continue;
      const full = norm(x.t), m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(x.t);
      if (q === full || (m && (q === norm(m[1]) || q === norm(m[2])))) return x;
    }
    return null;
  };

  /* ---------- 左邊欄的「術語」分頁 ---------- */
  PR.lexiconHtml = function (glossaryHtml) {
    if (!lex) { load().then(repaint); return '<p class="hint">' + PR.t("加载中…") + "</p>"; }
    const terms = items().filter((x) => x.k !== "symbol"), syms = items().filter((x) => x.k === "symbol");
    const hasGloss = ((S.paper && S.paper.glossary) || []).length > 0;
    if (seg === "gloss" && !hasGloss) seg = "term";
    const can = PR.canChat && PR.canChat();
    const tabs = '<div class="seg lx-seg">' + [["term", PR.t("術語"), terms.length], ["symbol", PR.t("符號"), syms.length]].concat(hasGloss ? [["gloss", PR.t("譯名"), S.paper.glossary.length]] : [])
      .map(([k, l, n]) => '<button data-lxseg="' + k + '" class="' + (seg === k ? "on" : "") + '">' + PR.esc(l) + (n ? '<i class="n">' + n + "</i>" : "") + "</button>").join("") + "</div>";
    const head = '<div class="lx-head">' + (seg === "gloss" ? "" : '<label class="lx-find">' + PR.icon("search", "sm") + '<input data-lxq placeholder="' + PR.t("找術語") + '" value="' + PR.esc(query) + '" autocomplete="off"></label>') +
      (can && items().length ? '<button class="btn icon sm" data-lx="build" title="' + PR.t("請 AI 重新整理一次") + '"' + (building ? " disabled" : "") + ">" + PR.icon("sparkle", "sm") + "</button>" : "") + "</div>";
    if (seg === "gloss") return '<div class="lx">' + tabs + glossaryHtml() + "</div>";
    if (building) return '<div class="lx">' + tabs + '<div class="lx-busy"><span class="spin"></span>' + PR.esc(PR.t("AI 正在讀整份、整理術語和符號…")) + '<button class="btn sm line" data-lx="stop">' + PR.t("停止") + "</button></div></div>";
    if (!items().length) {
      return '<div class="lx">' + (hasGloss ? tabs : "") + '<div class="lx-empty">' + PR.icon("type", "sm") + "<p>" + PR.esc(PR.t("整理一份這份文件的術語和符號：每一個在這裡是什麼意思、在第幾頁定義的。")) + "</p>" +
        (can ? '<button class="btn sm accent" data-lx="build">' + PR.icon("sparkle", "sm") + PR.t("請 AI 整理") + "</button><small>" + PR.esc(PR.t("讀一次整份，大約半分鐘到一分鐘")) + "</small>" : "") + "</div></div>";
    }
    const q = norm(query), list = (seg === "symbol" ? syms : terms).filter((x) => !q || norm(x.t + " " + x.def).includes(q));
    return '<div class="lx">' + tabs + head + '<div class="lx-list">' + (list.map((x) => '<div class="lx-it" data-lxt="' + PR.esc(x.t) + '"><div class="lx-t">' + nameHtml(x) +
      (x.page ? '<button class="lx-pg" data-lx="go" title="' + PR.esc(PR.t("翻到第 {page} 頁", { page: x.page })) + '">p.' + x.page + "</button>" : "") + "</div>" +
      '<div class="lx-d">' + PR.esc(x.def) + "</div>" + (x.quote ? '<div class="lx-q">' + PR.esc(x.quote) + "</div>" : "") +
      '<div class="lx-acts">' + (PR.cardsPanel ? '<button data-lx="card" title="' + PR.t("做成複習卡") + '">' + PR.icon("l-brain", "sm") + "</button>" : "") +
      (can ? '<button data-lx="ask" title="' + PR.t("問 AI") + '">' + PR.icon("sparkle", "sm") + "</button>" : "") +
      '<button data-lx="del" title="' + PR.t("拿掉這一條") + '">' + PR.icon("trash", "sm") + "</button></div></div>").join("") || '<p class="hint">' + PR.t("沒有對得上的") + "</p>") + "</div></div>";
  };

  async function build() {
    if (building) return;
    const ctrl = new AbortController();
    building = ctrl;
    repaint();
    try {
      const r = await fetch("/api/p/" + PR.pid + "/lexicon", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" }, body: JSON.stringify({ action: "build" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      lex = d;
      PR.toast(PR.t("整理好了：{n} 條", { n: items().length }), null, 1800);
    } catch (e) { if (e.name !== "AbortError") PR.toast(PR.t("沒整理成：{msg}", { msg: PR.esc(e.message) })); }
    if (building === ctrl) building = null;
    repaint();
  }
  const byT = (t) => items().find((x) => x.t === t);
  async function toCard(x) {
    try {
      await PR.api("/api/p/" + PR.pid + "/cards", { method: "POST", body: { op: "add", cards: [{ q: PR.t("「{t}」在這份文件裡是什麼意思？", { t: x.k === "symbol" ? "$" + x.t + "$" : x.t }), a: x.def, page: x.page, quote: x.quote }] } });
      if (PR.cardsPanel && PR.cardsPanel.reload) PR.cardsPanel.reload();
      PR.toast(PR.t("已做成複習卡"), null, 1500);
    } catch (e) { PR.toast(PR.t("沒做成：{msg}", { msg: PR.esc(e.message) })); }
  }
  function ask(x) {
    PR.chatAsk({ anchor: "", page: x.page || (PR.pdfPage ? PR.pdfPage() : 1), quote: x.quote || "", draft: PR.t("「{t}」在這裡是什麼意思？和一般的用法有什麼不同？", { t: x.k === "symbol" ? "$" + x.t + "$" : x.t }) });
  }
  function act(k, x, at) {
    if (k === "go" && x.page) { PR.toggleDrawer && PR.toggleDrawer(false); return PR.openPage(x.page); }
    if (k === "card") return toCard(x);
    if (k === "ask") { PR.toggleDrawer && PR.toggleDrawer(false); PR.hidePopover && PR.hidePopover(); return ask(x); }
    if (k === "del") {
      return PR.api("/api/p/" + PR.pid + "/lexicon", { method: "POST", body: { action: "delete", t: x.t } }).then((d) => { lex = d; repaint(); }, (e) => PR.toast(PR.esc(e.message)));
    }
  }
  document.addEventListener("click", (e) => {
    const s = e.target.closest && e.target.closest("[data-lxseg]");
    if (s) { seg = s.dataset.lxseg; PR.ls.set("easyread-lex-seg", seg); return repaint(); }
    const b = e.target.closest && e.target.closest("[data-lx]");
    if (!b) return;
    const k = b.dataset.lx;
    if (k === "build") return build();
    if (k === "stop" && building) return building.abort();
    const it = b.closest("[data-lxt]"), x = it ? byT(it.dataset.lxt) : b.closest("#popover") ? cur : null;
    if (x) act(k, x, b);
  });
  document.addEventListener("input", (e) => {
    if (!(e.target.dataset && "lxq" in e.target.dataset)) return;
    query = e.target.value;
    const q = norm(query);
    PR.$$(".lx-list .lx-it").forEach((r) => { r.hidden = !!q && !norm(r.textContent).includes(q); });
  });

  /* ---------- 選字工具列上的「術語」：解釋卡 ---------- */
  let cur = null;
  PR.showLexCard = function (x, rect) {
    cur = x;
    const at = { getBoundingClientRect: () => rect || { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3, width: 0, height: 0 } };
    const can = PR.canChat && PR.canChat();
    PR.popover(at, '<div class="lx-pop"><div class="lx-t">' + PR.icon("type", "sm") + "<b>" + nameHtml(x) + "</b>" +
      (x.page ? '<button class="lx-pg" data-lx="go" title="' + PR.esc(PR.t("翻到第 {page} 頁", { page: x.page })) + '">p.' + x.page + "</button>" : "") + "</div>" +
      '<div class="lx-d">' + PR.esc(x.def) + "</div>" + (x.quote ? '<div class="lx-q">' + PR.esc(x.quote) + "</div>" : "") +
      '<div class="lx-acts">' + (PR.cardsPanel ? '<button data-lx="card" title="' + PR.t("做成複習卡") + '">' + PR.icon("l-brain", "sm") + "</button>" : "") +
      (can ? '<button data-lx="ask" title="' + PR.t("問 AI") + '">' + PR.icon("sparkle", "sm") + "</button>" : "") + "</div></div>", { sticky: true, wide: true, cls: "lexpop" });
  };
  PR.on("rendered", () => { if (!loading && PR.store && PR.store.mode === "server") load(); });
})(window.PR);
