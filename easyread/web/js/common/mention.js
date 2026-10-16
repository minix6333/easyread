/* 「@」提到：筆記裡打 @（或 ＠）連到文獻庫的一篇文件、另一份筆記；在閱讀頁打 @12 是「這一篇的第 12 頁」。
   區塊編輯器（blocks.js）打 @ 時來這裡找：PR.mentions.find(找的字) → [{ icon, label, sub, text, url }]
   連結的字：文件用「第一作者 年」（像 Karan 2026；沒有作者就用原文標題）、這一篇的某一頁用「p.12」、筆記用它的標題。
   清單一分鐘內重複用（打字一個字一個字找，不用每次都問伺服器）。 */
(function (PR) {
  "use strict";
  let data = null, at = 0, loading = null;
  function load() {
    if (data && Date.now() - at < 60000) return Promise.resolve(data);
    if (!loading) {
      loading = Promise.all([PR.api("/api/library").catch(() => ({ items: [] })), PR.api("/api/notes").catch(() => ({ items: [] }))]).then(([lib, notes]) => {
        data = { papers: (lib.items || []).filter((x) => x && x.id), notes: (notes.items || []).filter((x) => x && x.id) };
        at = Date.now(); loading = null;
        return data;
      });
    }
    return loading;
  }
  const norm = (s) => String(s || "").toLowerCase();
  const clean = (s) => String(s || "").replace(/^\s*Microsoft (?:PowerPoint|Word)\s*-\s*/i, "").replace(/\s*-\s*(?:Copy|複製|副本)\s*$/i, "").replace(/\.(pdf|pptx?|docx?)$/i, "").trim();
  const title = (p) => clean(p.title_en || p.title_zh || p.short_zh) || p.id;  // 原文的標題（和文獻庫的卡片一樣）
  function surname(authors) {
    const first = String(authors || "").split(/[,;，、]|\band\b/)[0].trim();
    const w = first.split(/\s+/);
    return /^[A-Za-z]/.test(first) && w.length > 1 ? w[w.length - 1] : first;
  }
  const cite = (p) => { const a = surname(p.authors), y = String(p.year || "").match(/\d{4}/); return a && y ? a + " " + y[0] : a || title(p); };
  PR.mentions = {
    async find(q) {
      const d = await load();
      q = String(q || "").trim();
      const words = norm(q).split(/\s+/).filter(Boolean), hit = (s) => words.every((w) => s.includes(w));
      const here = PR.pid && PR.state && PR.state.paper ? PR.pid : "";
      const self = PR.note && PR.note.id;
      const out = [];
      const pm = /^(?:p\.?|第)?\s*(\d{1,4})\s*頁?$/i.exec(q);
      if (here && pm) {
        const n = +pm[1], max = ((PR.state.paper.meta || {}).pages || []).length || 9999;
        if (n >= 1 && n <= max) out.push({ icon: "page", label: PR.t("這一篇的第 {n} 頁", { n }), sub: "p." + n, text: "p." + n, url: "/read/" + here + "#page=" + n });
      }
      const linked = new Set((PR.note && PR.note.st && PR.note.st.note && PR.note.st.note.papers) || []);  // 筆記頁：這份筆記連著的那幾篇排前面
      const papers = d.papers.filter((p) => !words.length || hit(norm([p.title_en, p.title_zh, p.short_zh, p.authors, p.year].join(" "))));
      const rank = (p) => (p.id === here ? 2 : linked.has(p.id) ? 1 : 0);
      papers.sort((a, b) => rank(b) - rank(a));
      for (const p of papers.slice(0, 6)) { const t = title(p), c = cite(p); out.push({ icon: "doc", label: t, sub: c !== t ? c : "", text: c, url: "/read/" + p.id }); }
      const notes = d.notes.filter((n) => n.id !== self && (!words.length || hit(norm((n.title || "") + " " + (n.folder || "")))));
      for (const n of notes.slice(0, words.length ? 5 : 3)) {
        const name = (n.title || "").trim() || PR.t("未命名筆記");
        out.push({ icon: "notes", label: name, sub: n.folder || "", text: name, url: "/note/" + n.id });
      }
      return out;
    },
  };
})(window.PR);
