/* PDF 上的預覽：指到引用編號、圖號、公式號（PDF 自己帶的連結，伺服器 peek.py 讀出來），就地看那一筆參考文獻、那一張圖，
   不用翻過去再翻回來。譯文那一邊本來就有同樣的懸浮卡（actions.js 的 a.cite / a.xref），這裡是 PDF 這一邊。
   - 滑鼠指著停一下就出現，移開就收；點一下釘住（移開不收），Esc、點別處、捲 PDF 時收掉。觸控只有點的。
   - 參考文獻：那一筆的全文。文獻庫裡已經有這篇 → 在旁邊開；沒有 → 搜尋、匯入（放進同一個分類，不翻譯）。
     問 AI：把引用它的那一句帶進問 AI，問題先放進輸入框，自己按送出。
   - 圖、表、演算法、公式、章節：目標頁上的那一塊（一張可以上下捲的小頁面）。可以釘在旁邊對照著讀（pins.js）、
     把那一塊附給問 AI、跳過去（左下角跳得回來，jumpback.js）。
   - 外部網址：指著看得到網址，點了用瀏覽器開。
   沒有內部連結的 PDF（投影片、講義）：伺服器從文字裡找「Figure 3」，連到題注那一行（peek.py）。 */
(function (PR) {
  "use strict";
  const S = PR.state, body = document.body;
  let data = null, loading = null, lib = null;
  const load = () => loading || (loading = PR.api("/api/p/" + PR.pid + "/links").then((d) => (data = d || { pages: {} }), () => (data = { pages: {} })));
  PR.pdfLinks = () => load();
  PR.on("text-layer", () => { if (!loading && PR.store.mode === "server") load(); });  // 第一頁的文字層鋪好時順便取（一份很小的 JSON），第一次指到就有
  const libItems = () => lib || (lib = PR.api("/api/library").then((d) => d.items || [], () => []));

  /* ---------- 指到哪個連結 ---------- */
  function linkAt(n, x, y) {
    const arr = data && data.pages && data.pages[n];
    if (!arr) return null;
    let best = null, area = Infinity;
    for (const l of arr) {
      const [x0, y0, x1, y1] = l.r;
      if (x < x0 - 0.002 || x > x1 + 0.002 || y < y0 - 0.003 || y > y1 + 0.003) continue;
      const a = (x1 - x0) * (y1 - y0);
      if (a < area) { best = l; area = a; }
    }
    return best;
  }
  const pointIn = (page, e) => { const r = page.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const rectOf = (page, r) => ({
    getBoundingClientRect() {
      const b = page.getBoundingClientRect(), left = b.left + r[0] * b.width, top = b.top + r[1] * b.height;
      const width = (r[2] - r[0]) * b.width, height = (r[3] - r[1]) * b.height;
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
    },
  });
  const skip = (e) => !e.target.closest || e.target.closest(".pv-sticky, .pv-badge, .pv-pin, .pin, button, a, textarea, input, .pv-margin") || body.classList.contains("region-mode");

  let hover = null, hoverPage = null, showT = 0, raf = 0, last = null, cur = null, pinned = false;
  document.addEventListener("mousemove", (e) => {
    last = e;
    if (!raf) raf = requestAnimationFrame(onMove);
  }, { passive: true });
  function onMove() {
    raf = 0;
    const e = last, page = e && e.target.closest && e.target.closest("#pageview .pv-page");
    if (page && !data) { load(); return; }
    let l = null;
    if (page && !e.buttons && !skip(e)) { const [x, y] = pointIn(page, e); l = linkAt(+page.dataset.n, x, y); }
    if (l === hover) return;
    if (hoverPage) hoverPage.classList.remove("pv-onlink");
    hover = l; hoverPage = l ? page : null;
    if (l) page.classList.add("pv-onlink");
    clearTimeout(showT);
    if (l && !(pinned && cur && cur.l === l)) { const n = +page.dataset.n; showT = setTimeout(() => show(l, n, page, false), l.u ? 450 : 200); }
    else if (!l && cur && !pinned) PR.hidePopoverSoon();
  }
  /* 點：釘住預覽（外部網址就用瀏覽器開）。點在自己的標記上、正在選字、框選模式時不管 */
  document.addEventListener("click", (e) => {
    const page = e.target.closest && e.target.closest("#pageview .pv-page");
    if (!page || !data || skip(e) || e.button !== 0) return;
    if (String(getSelection())) return;
    const [x, y] = pointIn(page, e), n = +page.dataset.n, l = linkAt(n, x, y);
    if (!l || (PR.pdfNoteAt && PR.pdfNoteAt(e))) return;
    e.stopPropagation();
    e.preventDefault();
    clearTimeout(showT);
    if (l.u) { window.open(l.u, "_blank", "noopener"); PR.hidePopover(); return; }
    show(l, n, page, true);
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cur && isOpen()) { PR.hidePopover(); cur = null; } });
  const isOpen = () => { const p = PR.$("#popover"); return p && p.classList.contains("open") && p.classList.contains("peek"); };
  const sc = PR.$(".pv-scroll");
  if (sc) sc.addEventListener("scroll", () => { if (cur && isOpen()) { PR.hidePopover(); cur = null; } }, { passive: true });

  /* ---------- 這個連結是什麼 ---------- */
  const WORD = /(fig(?:ure)?s?\.?|tab(?:le)?s?\.?|alg(?:orithm)?s?\.?|sec(?:tion)?s?\.?|§|app(?:endix|endices)?\.?|eqs?\.?|equations?|thm\.?|theorems?|lemmas?|def(?:inition)?s?\.?|prop(?:osition)?s?\.?|cor(?:ollary)?\.?|remarks?|examples?|圖|表|式|節|章)\s*\(?\s*$/i;  // i18n-ok
  async function context(l, n) {  // 連結本身的字、它前面的字（看是 Figure 3 還是 [12]）、引用它的那幾行
    const { chars, lines } = await PR.pageLines(n);
    const [x0, y0, x1, y1] = l.r;
    let inside = "", before = "", line = null;
    for (const ln of lines) {
      const mid = (ln.y0 + ln.y1) / 2;
      if (mid < y0 - 0.002 || mid > y1 + 0.002) continue;  // 只看中線落在連結框裡的那一行（上下兩行貼得很近）
      let hit = false, pre = "", was = false;
      for (const i of ln.items) {
        const c = i < 0 ? null : chars[i];
        if (!c) { if (was) inside += " "; else pre += " "; continue; }
        was = c[1] >= x0 - 0.003 && c[3] <= x1 + 0.003;
        if (was) { inside += c[0]; hit = true; } else if (c[3] <= x0 + 0.003) pre += c[0];
      }
      if (hit) { before = pre.slice(-24); line = line || ln; inside += " "; }
    }
    inside = inside.replace(/\s+/g, " ");
    const k = line ? lines.indexOf(line) : -1;
    const near = k < 0 ? "" : lines.slice(Math.max(0, k - 1), k + 2).map((x) => x.t).join(" ");
    return { inside: inside.trim(), before, near: PR.peekJoin(near) };
  }
  const after = (p, y, at) => !!at && (p > at.page || (p === at.page && (y == null ? 1 : y) >= at.y - 0.01));
  PR.peekKind = function (l, src, d) {
    if (l.u) return "url";
    if (l.m) return l.m.split(" ")[0];
    const w = ((src.before || "").match(WORD) || [])[1] || "";
    if (/^(fig|圖)/i.test(w)) return "figure";  // i18n-ok
    if (/^(tab|表)/i.test(w)) return "table";  // i18n-ok
    if (/^alg/i.test(w)) return "algorithm";
    if (/^(sec|§|app|節|章)/i.test(w)) return "section";  // i18n-ok
    if (/^(eq|式)/i.test(w)) return "equation";  // i18n-ok
    if (/^(thm|theorem|lemma|def|prop|cor|remark|example)/i.test(w)) return "theorem";
    if (/^\(?\s*\d+(\.\d+)?[a-z]?\s*\)?$/.test(src.inside || "") && /\(\s*$/.test(src.before || "")) return "equation";
    d = d || data || {};
    if (after(l.to, l.y, d.refs) && !after(l.to, l.y, d.appx)) return "ref";
    return "spot";
  };

  /* ---------- 參考文獻那一筆 ---------- */
  /* 從跳過去那一點往下收：第一行之後是縮排的（掛排），回到第一行的位置就是下一筆；空一段、遇到 [n] 開頭也是 */
  const HEAD = /^\s*(?:[0-9]+\.?\s*)?(references?|bibliography|literature cited|參考文獻|参考文献)\s*$/i;  // i18n-ok
  PR.peekRefEntry = function (lines, l) {
    const y = l.y == null ? 0 : l.y;
    const inCol = (ln) => l.x == null || (ln.x0 >= l.x - 0.03 && ln.x0 <= l.x + 0.09);
    let cand = lines.filter((ln) => ln.y1 > y - 0.008 && inCol(ln) && ln.t.trim().length > 1 && !HEAD.test(ln.t)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    if (!cand.length) return null;
    // 第一行：離跳過去那一點最近、而且是一筆的開頭（[n] 開頭，或沒有縮排）的那一行。錨點有的在那一行上面一點、有的在基線，
    // 只看「第一個在下面的」會拿到上一筆的最後一行
    const near = cand.filter((ln) => ln.y0 < y + 0.03), minX = Math.min(...near.map((ln) => ln.x0));
    const start = (ln) => /^\s*\[\d+\]/.test(ln.t) || ln.x0 <= minX + 0.004;
    const first = (near.length ? near : cand).slice().sort((a, b) => (Math.abs(a.y0 - y) + (start(a) ? 0 : 0.01)) - (Math.abs(b.y0 - y) + (start(b) ? 0 : 0.01)))[0];
    cand = cand.filter((ln) => ln.y0 >= first.y0 - 0.001);
    const out = [first], lh = Math.max(first.y1 - first.y0, 0.006);
    const rest = cand.filter((ln) => ln !== first);
    const hanging = rest[0] && rest[0].x0 > first.x0 + 0.006;
    for (let i = 0; i < rest.length && out.length < 9; i++) {
      const ln = rest[i], prev = out[out.length - 1];
      if (ln.y0 - prev.y1 > lh * 0.85 || ln.y0 < prev.y0) break;
      if (hanging && Math.abs(ln.x0 - first.x0) < 0.005) break;
      if (/^\s*\[\d+\]/.test(ln.t)) break;
      out.push(ln);
    }
    return PR.peekJoin(out.map((x) => x.t).join("\n"));
  };
  /* 一行一行接起來：行尾斷字的連字號拿掉，其餘換行換成空格 */
  PR.peekJoin = (s) => String(s || "").replace(/(\w)[-­]\n(?=[a-z])/g, "$1").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  /* 這一筆的標題、arXiv 編號、DOI（搜尋、匯入、對文獻庫用） */
  PR.peekRefInfo = function (text) {
    const t = String(text || "").replace(/^\s*\[\d+\]\s*/, "");
    const ax = /(?:arxiv[:\s]*|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})/i.exec(t);
    const doi = /\b(10\.\d{4,9}\/[^\s,;]+[^\s,;.)])/.exec(t);
    // 「作者. 標題. 出處, 年.」：作者那一段逗號多；標題是後面第一段夠長、不像出處的
    const parts = t.split(/\.\s+(?=[A-Za-z0-9“"‘(])/);
    let title = "";
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].replace(/^\(?\d{4}[a-z]?\)?\.?\s*/, "").trim(), words = p.split(/\s+/).length;
      if (words < 3 || (p.match(/,/g) || []).length >= words / 3) continue;
      if (/^(in|proceedings|arxiv|journal|advances|url|doi|available|accessed|retrieved|vol|pp)\b/i.test(p)) continue;
      title = p.replace(/[.,]\s*$/, "");
      break;
    }
    return { title, arxiv: ax ? ax[1] : "", doi: doi ? doi[1] : "" };
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  PR.peekLibMatch = function (items, text, info) {
    const t = norm(text), want = info || PR.peekRefInfo(text);
    return items.find((i) => {
      if (i.id === PR.pid) return false;
      const ax = String(i.arxiv || "").replace(/^arxiv:/i, "").replace(/v\d+$/, "");
      if (want.arxiv && ax && ax === want.arxiv) return true;
      if (want.doi && i.doi && String(i.doi).toLowerCase() === want.doi.toLowerCase()) return true;
      const title = norm(i.title_en || "");
      return title.length >= 18 && t.includes(title);
    }) || null;
  };

  /* ---------- 圖、表、公式那一塊 ---------- */
  const CAP = { figure: /^\s*(fig(?:ure)?\.?|圖)\s*(\d+)/i, table: /^\s*(tab(?:le)?\.?|表)\s*(\d+)/i, algorithm: /^\s*(alg(?:orithm)?\.?)\s*(\d+)/i };  // i18n-ok
  PR.peekRegion = function (lines, l, kind, label) {
    const body = lines.filter((ln) => ln.t.length >= 25);
    let ax0 = Math.min(...body.map((x) => x.x0)), ax1 = Math.max(...body.map((x) => x.x1));
    if (!isFinite(ax0) || ax1 - ax0 < 0.3) { ax0 = 0.08; ax1 = 0.92; }
    const x0 = Math.max(0, ax0 - 0.025), x1 = Math.min(1, ax1 + 0.025);
    if (l.y == null) return [0, 0, 1, 1];  // 只說跳到哪一頁：整頁縮圖
    const y = l.y;
    const clamp = (a, b) => [x0, Math.max(0, Math.min(a, 0.97)), x1, Math.min(1, Math.max(b, a + 0.05))];
    const num = (String(label || "").match(/\d+/) || [])[0];
    const re = CAP[kind];
    // 同一條基線上的幾段（粗體的小標和後面接的句子、表格的幾格）併成一行：夠長、大多是字母、幾乎橫跨整欄的才算「內文」
    // （圖裡的刻度、圖例不會這樣），用來找圖從哪裡開始
    const rows = [];
    for (const ln of lines.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      const r = rows.find((q) => Math.abs((q.y0 + q.y1) / 2 - (ln.y0 + ln.y1) / 2) < 0.004);
      if (r) { r.t += " " + ln.t; r.x0 = Math.min(r.x0, ln.x0); r.x1 = Math.max(r.x1, ln.x1); r.y0 = Math.min(r.y0, ln.y0); r.y1 = Math.max(r.y1, ln.y1); }
      else rows.push({ t: ln.t, x0: ln.x0, x1: ln.x1, y0: ln.y0, y1: ln.y1 });
    }
    const prose = (r) => r.t.length >= 45 && (r.t.match(/[A-Za-z㐀-鿿]/g) || []).length >= r.t.length * 0.6 && r.x1 - r.x0 > (ax1 - ax0) * 0.6;
    const proseAbove = (yy) => rows.filter((r) => r.y1 < yy && prose(r)).sort((a, b) => b.y1 - a.y1)[0];
    if (re) {
      // 題注：「Figure 3:」「Figure 3.」優先（內文裡「Figure 3 plots …」開頭的一行不算），挑離跳過去那一點最近的
      const caps = lines.filter((ln) => { const m = re.exec(ln.t); return m && (!num || m[2] === num); });
      const real = caps.filter((ln) => new RegExp(re.source + "\\s*[:：.|]", "i").test(ln.t));  // i18n-ok
      const cap = (real.length ? real : caps).sort((a, b) => Math.abs(a.y0 - y) - Math.abs(b.y0 - y))[0];
      if (cap) {
        // 題注那一段：接著的幾行，行距和題注裡的一樣；空得比較開（換段）、字級不一樣就是題注結束、內文開始
        const i = lines.indexOf(cap), lh = Math.max(cap.y1 - cap.y0, 0.008);
        let end = cap.y1, gap0 = null;
        for (let k = i + 1; k < lines.length && k < i + 8; k++) {
          const ln = lines[k], h = ln.y1 - ln.y0, gap = ln.y0 - end;
          if (ln.y0 < end - 0.002 || gap > lh * 0.9 || Math.abs(ln.x0 - cap.x0) > 0.3 || Math.abs(h - lh) > lh * 0.18) break;
          if (gap0 != null && gap > Math.max(lh * 0.3, gap0 * 1.8 + 0.002)) break;
          if (gap0 == null) gap0 = Math.max(gap, 0);
          end = ln.y1;
        }
        if (kind === "figure") {
          if (cap.y0 > y + 0.03) {  // 跳到圖的頂端（hypcap）：從那裡到題注結束；上面那一行內文不要切到一半
            const pa = proseAbove(y + 0.004);
            return clamp(Math.max(y - 0.012, pa ? pa.y1 + 0.004 : 0), end + 0.006);
          }
          // 跳到題注：圖在題注上面，從上面最近一行內文的下面開始
          const above = proseAbove(cap.y0 - 0.004);
          const top = above ? Math.max(above.y1 + 0.005, cap.y0 - 0.6) : Math.max(0.04, cap.y0 - 0.45);
          return clamp(top, end + 0.006);
        }
        const top = Math.min(cap.y0, y) - 0.012;  // 表、演算法：題注通常在上面，往下看一段
        return clamp(top, top + 0.36);
      }
    }
    if (kind === "equation") {
      // 式子那幾行：從跳過去那一點往下，遇到一般的內文（長、從左邊界開始的一行字）就停；左右只框式子本身（編號另外寫在卡片標題），字才夠大
      const prose = (ln) => ln.t.length >= 45 && /^[A-Za-z(“"]/.test(ln.t) && (ln.t.match(/[A-Za-z]{3,}/g) || []).length >= 6;
      const eq = [];
      for (const ln of lines.filter((x) => x.y1 > y - 0.008 && x.y0 < y + 0.12).sort((a, b) => a.y0 - b.y0)) {
        if (eq.length && prose(ln)) break;
        if (!/^\s*\(\s*[\w.]+\s*\)\s*$/.test(ln.t)) eq.push(ln);
      }
      if (eq.length) {
        const ex0 = Math.min(...eq.map((x) => x.x0)), ex1 = Math.max(...eq.map((x) => x.x1)), ey1 = Math.max(...eq.map((x) => x.y1));
        const pad = 0.03, w = Math.max(ex1 - ex0 + 2 * pad, 0.3), cx = (ex0 + ex1) / 2;
        return [Math.max(0, cx - w / 2), Math.max(0, y - 0.014), Math.min(1, cx + w / 2), Math.min(1, Math.max(ey1 + 0.012, y + 0.035))];
      }
      return clamp(y - 0.014, y + 0.07);
    }
    if (kind === "section" || kind === "theorem") return clamp(y - 0.012, y + 0.17);
    if (kind === "figure" || kind === "table" || kind === "algorithm") return clamp(y - 0.02, y + 0.38);
    return clamp(y - 0.02, y + 0.16);
  };

  /* ---------- 卡片 ---------- */
  const KIND = () => ({
    ref: ["book", PR.t("參考文獻")], figure: ["image", PR.t("圖")], table: ["table", PR.t("表")], algorithm: ["list", PR.t("演算法")],
    equation: ["sigma", PR.t("公式")], section: ["page", PR.t("章節")], theorem: ["quote", PR.t("定理")], spot: ["page", PR.t("跳到")], url: ["globe", PR.t("網址")],
  });
  const btn = (k, icon, title, extra) => '<button data-pk="' + k + '" title="' + PR.esc(title) + '" aria-label="' + PR.esc(title) + '">' + PR.icon(icon, "sm") + (extra || "") + "</button>";
  const VIEW_W = 448;

  async function show(l, n, page, pin) {
    const src = l.u ? { inside: "", before: "", near: "" } : await context(l, n);
    const kind = PR.peekKind(l, src);
    const c = { l, n, page, kind, src };
    const html = await cardHtml(c);
    if (!html || (!pin && hover !== l)) return;  // 這中間滑鼠已經移開
    cur = c; pinned = pin;
    PR.popover(rectOf(page, l.r), html, { sticky: pin, wide: true, cls: "peek" });
    const pop = PR.$("#popover");
    pop.onclick = (e) => act(e, c);
    const view = pop.querySelector(".pk-view");
    if (view && c.view) { view.scrollTop = c.view.top; view.scrollLeft = c.view.left; }
  }

  async function cardHtml(c) {
    const { l, kind, src } = c;
    const K = KIND(), [icon, word] = K[kind] || K.spot;
    const label = src.inside && src.inside.length <= 40 ? src.inside.replace(/[\s,;:.\[(]+$|^[\s,;:\[(]+/g, "") : "";
    if (kind === "url") {
      let host = l.u;
      try { host = new URL(l.u).hostname.replace(/^www\./, ""); } catch (e) { /* mailto: 之類 */ }  // i18n-ok
      return '<div class="pk"><div class="pk-hd">' + PR.icon("globe", "sm") + "<b>" + PR.esc(host) + '</b><span class="grow"></span>' + btn("url", "linkout", PR.t("用瀏覽器開")) + '</div><div class="pk-url">' + PR.esc(l.u) + "</div></div>";
    }
    const head = (name) => '<div class="pk-hd">' + PR.icon(icon, "sm") + "<b>" + PR.esc(name) + '</b><span class="grow"></span>' +
      '<button class="pk-pg" data-pk="go" title="' + PR.esc(PR.t("跳過去（第 {page} 頁）", { page: l.to })) + '">' + PR.icon("page", "sm") + "<span>" + l.to + "</span></button></div>";
    const { lines } = await PR.pageLines(l.to);
    if (kind === "ref") {
      const text = PR.peekRefEntry(lines, l);
      if (!text) return "";
      const info = PR.peekRefInfo(text), match = PR.peekLibMatch(await libItems(), text, info);
      c.ref = { text, info, match };
      const t = PR.esc(text), hl = info.title ? t.replace(PR.esc(info.title), "<b>" + PR.esc(info.title) + "</b>") : t;
      const libRow = match
        ? '<button class="pk-lib" data-pk="open" title="' + PR.esc(PR.t("在旁邊打開")) + '">' + PR.icon("book", "sm") + "<span>" + PR.esc(match.short_zh || match.title_en || match.title_zh || "") + "</span>" + PR.icon("linkout", "sm") + "</button>"
        : "";
      return '<div class="pk pk-ref">' + head(label || word) + '<div class="pk-text">' + hl + "</div>" + libRow +
        '<div class="pk-acts">' + btn("ask", "sparkle", PR.t("問 AI：這裡為什麼引用它")) + btn("copy", "copy", PR.t("複製這一筆")) + btn("note", "notebook", PR.t("加到筆記")) +
        btn("scholar", "websearch", PR.t("用 Google Scholar 找這篇")) + (match ? "" : btn("import", "download", PR.t("匯入文獻庫（不翻譯）"))) + "</div></div>";
    }
    const box = PR.peekRegion(lines, l, kind, label);
    c.box = box;
    const meta = ((S.paper.meta || {}).pages || [])[l.to - 1] || {};
    const aspect = meta.w && meta.h ? meta.h / meta.w : 1.294;
    const pageW = Math.min(1500, VIEW_W / Math.max(0.2, box[2] - box[0]));
    const want = (box[3] - box[1]) * pageW * aspect;
    const h = Math.round(Math.max(70, Math.min(want, 360)));
    c.view = { top: Math.round(box[1] * pageW * aspect), left: Math.round(box[0] * pageW) };
    const img = PR.pageImg(l.to, pageW * (devicePixelRatio || 1) > 1700 ? 2400 : 1600);
    const name = label ? (/^\d/.test(label) ? word + " " + label : label) : word;
    return '<div class="pk pk-fig">' + head(name) +
      '<div class="pk-view" style="height:' + h + 'px"><img src="' + PR.esc(img) + '" alt="" decoding="async" draggable="false" style="width:' + Math.round(pageW) + "px;aspect-ratio:1/" + aspect.toFixed(4) + '"></div>' +
      '<div class="pk-acts">' + btn("pin", "pin", PR.t("釘在旁邊：往下讀的時候它一直在")) + btn("askfig", "sparkle", PR.t("把這一塊附給問 AI")) + "</div></div>";
  }

  const QUESTION = () => ({ figure: PR.t("這張圖在說什麼？"), table: PR.t("這張表的重點是什麼？"), algorithm: PR.t("這個演算法每一步在做什麼？"), equation: PR.t("這個式子每一項是什麼意思？"), section: PR.t("這一節在講什麼？"), theorem: PR.t("這個定理在說什麼？為什麼成立？") });
  async function act(e, c) {
    const b = e.target.closest("[data-pk]");
    if (!b) return;
    const k = b.dataset.pk, l = c.l;
    if (k === "url") { window.open(l.u, "_blank", "noopener"); return PR.hidePopover(); }
    if (k === "go") {
      PR.hidePopover(); cur = null;
      if (PR.rememberPdfSpot) PR.rememberPdfSpot();
      return PR.pdfGoto(l.to, c.box ? c.box[1] + 0.012 : l.y);
    }
    if (k === "pin" && c.box) { PR.hidePopover(); cur = null; return PR.pinRegion(l.to, c.box.slice()); }
    if (k === "askfig" && c.box) {
      PR.hidePopover(); cur = null;
      return PR.chatAsk({ anchor: "", page: l.to, region: c.box.slice(), draft: QUESTION()[c.kind] || PR.t("這一段在說什麼？") });
    }
    const ref = c.ref;
    if (!ref) return;
    if (k === "copy") {
      try { await navigator.clipboard.writeText(ref.text); PR.toast(PR.t("已複製"), null, 1200); } catch (err) { PR.toast(PR.t("沒複製成")); }
      return;
    }
    if (k === "scholar") return window.open("https://scholar.google.com/scholar?q=" + encodeURIComponent(ref.info.title || ref.text.slice(0, 220)), "_blank", "noopener");
    if (k === "open" && ref.match) {
      PR.hidePopover(); cur = null;
      const url = "/read/" + ref.match.id, sh = PR.framed && window.parent.easyreadShell;
      return sh ? sh.open(url, ref.match.short_zh || ref.match.title_en || "", true) : PR.navigate(url);
    }
    if (k === "ask") {
      PR.hidePopover(); cur = null;
      const who = (c.src.inside || "").replace(/[\s,;:.\[(]+$|^[\s,;:\[(]+/g, "") || ref.info.title || PR.t("這篇");
      return PR.chatAsk({ anchor: "", page: c.n, quote: c.src.near, draft: PR.t("這裡引用「{who}」（{title}）是為了說明什麼？", { who, title: ref.info.title || ref.text.slice(0, 80) }) });
    }
    if (k === "note" && PR.excerptMenu) return PR.excerptMenu({ quote: ref.text, page: l.to, side: "pdf" }, b);
    if (k === "import") {
      const want = ref.info.arxiv || ref.info.doi || ref.info.title;
      if (!want) return PR.toast(PR.t("這一筆看不出標題，用 Google Scholar 找找看"));
      b.disabled = true;
      try {
        const tags = ((S.item || {}).tags || []).slice(0, 4);
        const r = await PR.api("/api/import-url", { method: "POST", body: { ref: want, translate: false, tags } });
        lib = null;
        PR.hidePopover(); cur = null;
        PR.toast(r.new ? PR.t("已加進文獻庫，正在準備頁面") : PR.t("這篇已經在文獻庫裡"), { label: PR.t("打開"), fn: () => { const sh = PR.framed && window.parent.easyreadShell; if (sh) sh.open("/read/" + r.id, "", true); else PR.navigate("/read/" + r.id); } }, 5200);
        if (PR.notesChanged) PR.notesChanged();
      } catch (err) { b.disabled = false; PR.toast(PR.t("沒匯入成：{msg}", { msg: PR.esc(err.message) })); }
    }
  }
})(window.PR);
