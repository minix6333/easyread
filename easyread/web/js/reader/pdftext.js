/* PDF 文字層：用抽取的字元座標（extract/page-NNN.chars.json）在原頁圖上鋪一層透明文字，
   所以可以直接在 PDF 上選字、畫線、寫筆記、問 AI，不依賴譯文。做法學 pdf.js：一行一個 span，
   字級跟著頁高，用 scaleX 把每一行拉到和字元框一樣寬；選取時再從 span 算回字元編號。
   一條 PDF 筆記存：page、range [起, 訖)、quote、rects [[x0,y0,x1,y1]…]（按頁寬高歸一化）、anchor（落在哪一段，可能沒有）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const cache = {};   // 頁碼 → Promise<chars>
  const built = {};   // 頁碼 → { chars, segs }（已鋪好文字層的頁）
  const pad = (n) => String(n).padStart(3, "0");

  PR.charsFor = function (n) {
    if (cache[n]) return cache[n];
    let p;
    if (PR.store.mode === "server") p = fetch("/p/" + PR.pid + "/extract/page-" + pad(n) + ".chars.json").then((r) => (r.ok ? r.json() : []));
    else {
      const c = (S.chars || {})[n];
      p = typeof c === "string" ? fetch(c).then((r) => (r.ok ? r.json() : [])) : Promise.resolve(Array.isArray(c) ? c : []);
    }
    cache[n] = p.catch(() => []);
    return cache[n];
  };

  /* 把字元串成行：垂直範圍和這一行有相當重疊（上下標也算同一行）、x 接著前一個字就是同一行；
     往回跳（新的一行）或跳太遠（表格的另一欄）就另起一段。
     很多 PDF 抽出來的字元裡沒有空格（字和字之間只是留了距離）：字距明顯比字寬大就補一個空格（items 裡記 -1） */
  function segment(chars) {
    const segs = [];
    let cur = null, last = null;
    chars.forEach((c, i) => {
      const [ch, x0, y0, x1, y1] = c;
      if (!(y1 > y0) || !(x1 >= x0) || (x1 === x0 && !/\s/.test(ch))) return;
      const h = y1 - y0, mid = (y0 + y1) / 2, w = Math.max(x1 - x0, 0.004);
      const overlap = cur ? Math.min(y1, cur.y1) - Math.max(y0, cur.y0) : 0;
      if (cur && overlap >= 0.4 * Math.min(h, cur.h) && x0 >= cur.x1 - w * 1.5 && x0 <= cur.x1 + w * 3) {
        const gap = x0 - last[3], lw = Math.max(last[3] - last[1], w);
        if (gap > lw * 0.28 && !/\s/.test(ch) && !/\s/.test(last[0]) && !/[㐀-鿿]/.test(ch + last[0])) cur.items.push(-1);
        cur.items.push(i);
        cur.x1 = Math.max(cur.x1, x1); cur.y0 = Math.min(cur.y0, y0); cur.y1 = Math.max(cur.y1, y1);
        cur.h = cur.y1 - cur.y0; cur.mid = (cur.y0 + cur.y1) / 2;
      } else {
        // 直排的字（arXiv 側邊那條轉了 90 度的浮水印）：字框一個疊一個、上下緊貼。記下來，等下整串拿掉
        const stacked = !!last && Math.min(x1, last[3]) - Math.max(x0, last[1]) >= 0.6 * Math.min(x1 - x0, last[3] - last[1]) &&
          Math.max(y0 - last[4], last[2] - y1) < 0.15 * Math.max(h, last[4] - last[2]);
        cur = { items: [i], x0, y0, x1, y1, h, mid, stacked };
        segs.push(cur);
      }
      last = c;
    });
    // 連續 4 個以上「只有一個字、又疊在前一個字上」的段：是直排文字，不放進文字層（不然橫向選字時會夾到它們）
    const out = [];
    for (let k = 0; k < segs.length;) {
      let j = k + 1;
      while (j < segs.length && segs[j].stacked && segs[j].items.length === 1 && segs[j - 1].items.length === 1) j++;
      if (j - k >= 4) { k = j; continue; }
      out.push(segs[k]);
      k++;
    }
    return out;
  }
  const textOf = (seg, chars) => seg.items.map((i) => (i < 0 ? " " : chars[i][0])).join("");

  /* 排成閱讀順序：雙欄頁先左欄再右欄，橫跨兩欄的行（標題、題注）把上下分成兩「帶」；單欄頁直接由上而下 */
  function order(segs) {
    const narrow = (s) => s.x1 - s.x0 < 0.5;
    const twoCol = segs.filter((s) => narrow(s) && s.x1 <= 0.52).length >= 8 && segs.filter((s) => narrow(s) && s.x0 >= 0.48).length >= 8;
    const col = (s) => (!twoCol ? 0 : s.x0 < 0.45 && s.x1 > 0.55 ? -1 : (s.x0 + s.x1) / 2 < 0.5 ? 0 : 1);
    const byY = segs.slice().sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
    let band = 0, seenCol = false;
    for (const s of byY) {
      const c = col(s);
      if (c === -1) { if (seenCol) { band++; seenCol = false; } s.key = [band, -1, s.y0, s.x0]; }
      else { seenCol = true; s.key = [band, c, s.y0, s.x0]; }
    }
    return byY.sort((p, q) => p.key[0] - q.key[0] || p.key[1] - q.key[1] || p.key[2] - q.key[2] || p.key[3] - q.key[3]);
  }

  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  let ctx = null;
  function measure(text, px) {
    if (!ctx) ctx = document.createElement("canvas").getContext("2d");
    ctx.font = px + "px " + FONT;
    return ctx.measureText(text).width;
  }

  PR.hasTextLayer = (n) => !!built[n];
  /* 這一頁的字元和排好順序的行（搜尋用；不一定鋪過文字層） */
  const segCache = {};
  PR.pageSegs = async function (n) {
    if (built[n]) return built[n];
    if (!segCache[n]) { const chars = await PR.charsFor(n); segCache[n] = { chars, segs: order(segment(chars)) }; }
    return segCache[n];
  };
  PR.buildTextLayer = async function (entry, n) {
    if (built[n] || entry.textPending) return;
    entry.textPending = true;
    const chars = await PR.charsFor(n);
    entry.textPending = false;
    if (!entry.node.isConnected || built[n]) return;  // 面板重建過了
    const layer = document.createElement("div");
    layer.className = "pv-text";
    const segs = order(segment(chars));
    built[n] = { chars, segs };
    const W = entry.node.clientWidth || 600;
    const pageH = entry.node.clientHeight || W * ((entry.node.style.aspectRatio || "612 / 792").split("/").map(Number).reduce((a, b) => b / a));
    const frag = document.createDocumentFragment();
    segs.forEach((s, k) => {
      const text = textOf(s, chars);
      const span = document.createElement("span");
      span.textContent = text;
      span.dataset.s = k;
      const fs = s.h * 0.86;  // 字級：字元框高度的比例（乘上頁高 --ph，縮放時跟著變）
      const want = (s.x1 - s.x0) * W, got = measure(text, fs * pageH) || 1;
      span.style.cssText = "left:" + (s.x0 * 100).toFixed(3) + "%;top:" + (s.y0 * 100).toFixed(3) + "%;height:" + (s.h * 100).toFixed(3) +
        "%;font-size:calc(var(--ph, " + pageH + "px) * " + fs.toFixed(5) + ");transform:scaleX(" + (want / got).toFixed(4) + ")";
      frag.append(span);
    });
    layer.replaceChildren(frag);
    entry.text = layer;
    entry.node.append(layer);
    if (entry.marks) entry.node.append(entry.marks);  // 標記層要在文字層上面
    PR.emit("text-layer", n);
  };
  PR.resetTextLayers = function () { for (const k in built) delete built[k]; };

  /* ---------- 選取 → 字元範圍、原話、框 ---------- */
  const layerOf = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return el && el.closest(".pv-text"); };
  const cps = (span, off) => Array.from(span.textContent.slice(0, off)).length;  // UTF-16 位移 → 第幾個字元

  PR.pdfSelection = function () {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const la = layerOf(range.startContainer), lb = layerOf(range.endContainer);
    const layer = la || lb;
    if (!layer || (la && lb && la !== lb)) return null;  // 一次只能選一頁
    const page = Number(layer.closest(".pv-page").dataset.n);
    const L = built[page];
    if (!L) return null;
    // 選區碰到的每個 span 都算（從頁面空白處開始拖、拖出文字層的情形也算得到），不只看頭尾兩個容器
    const spans = Array.from(layer.children);
    const hit = spans.map((s, k) => k).filter((k) => range.intersectsNode(spans[k]));
    if (!hit.length) return null;
    const i0 = hit[0], i1 = hit[hit.length - 1];
    const a = spans[i0], b = spans[i1];
    const start = a.contains(range.startContainer) && range.startContainer.nodeType === 3 ? cps(a, range.startOffset) : 0;
    const end = b.contains(range.endContainer) && range.endContainer.nodeType === 3 ? cps(b, range.endOffset) : L.segs[i1].items.length;
    const parts = [], rects = [], picked = [];
    for (let k = i0; k <= i1; k++) {
      const seg = L.segs[k];
      const items = seg.items.slice(k === i0 ? start : 0, k === i1 ? end : seg.items.length);
      const idx = items.filter((i) => i >= 0);
      if (!idx.length) continue;
      const boxes = idx.map((i) => L.chars[i]);
      rects.push([Math.min(...boxes.map((c) => c[1])), Math.min(...boxes.map((c) => c[2])), Math.max(...boxes.map((c) => c[3])), Math.max(...boxes.map((c) => c[4]))].map((v) => +v.toFixed(4)));
      parts.push(items.map((i) => (i < 0 ? " " : L.chars[i][0])).join(""));
      picked.push(...idx);
    }
    if (!picked.length) return null;
    const quote = joinLines(parts);
    if (!quote) return null;
    const first = rects[0];
    const anchor = PR.blockAt ? PR.blockAt((first[0] + first[2]) / 2, (first[1] + first[3]) / 2, page) : null;
    return { side: "pdf", page, range: [picked[0], picked[picked.length - 1] + 1], quote, rects, anchor: anchor || null, rect: range.getBoundingClientRect() };
  };
  /* 行尾連字號的字接回去（fine-\ntuning → fine-tuning；分不出是真連字號還是斷字，一律留著連字號），其餘行之間補空格；中文之間不補 */
  function joinLines(parts) {
    let out = "";
    parts.forEach((p, i) => {
      p = p.replace(/\s+$/, "");
      if (!i) { out = p; return; }
      const q = p.replace(/^\s+/, "");
      if (/[\u0002\u00ad]$/.test(out)) out = out.slice(0, -1) + q;  // PDF 自己標的行尾斷字（posttrain␂ing）：直接接回去
      else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(q)) out += q;
      else out += (/[㐀-鿿]$/.test(out) || /^[㐀-鿿]/.test(q) ? "" : " ") + q;
    });
    return out.replace(/[\u0000-\u0008\u000b-\u001f\u00ad]/g, "").replace(/\s+/g, " ").trim();
  }
  PR.pdfQuoteOf = (n) => (built[n] ? joinLines(built[n].segs.map((s) => textOf(s, built[n].chars))) : "");
  /* 複製 PDF 上選的字（⌘C）：給的是理順過的文字（斷行接回去、補空格），不是一行一段的原樣 */
  document.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
    const r = sel.getRangeAt(0);
    if (!layerOf(r.startContainer) && !layerOf(r.endContainer)) return;
    const s = PR.pdfSelection();
    if (!s) return;
    e.clipboardData.setData("text/plain", s.quote);
    e.preventDefault();
  });
  /* 給測試用：分行、排序、合併行 */
  PR.pdfLines = (chars) => order(segment(chars)).map((s) => ({ text: textOf(s, chars), x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 }));
  PR.pdfJoinLines = joinLines;

  /* ---------- 畫線、筆記、提問在 PDF 上的標記 ----------
     畫線／筆記：螢光筆底色或底線。提問：只有一道細點線，不蓋底色（之後還能在同一段上畫螢光筆）。
     框選的區域（region）：一圈細框。筆記和提問在標記末端有一顆小圓點，點它打開便利貼（sticky.js）。
     標記不吃滑鼠事件（畫過的地方才能再選字、再畫），點擊用座標判斷。 */
  const pct = (v) => (v * 100).toFixed(3) + "%";
  function markHtml(x, openId) {
    const id = PR.esc(x.id), isQ = x.kind === "question", on = x.id === openId ? " active" : "";
    let h = "", bx, by;
    if (Array.isArray(x.region)) {
      const [x0, y0, x1, y1] = x.region;
      h = '<div class="pv-area' + (isQ ? " q" : "") + on + '" data-note="' + id + '" style="left:' + pct(x0) + ";top:" + pct(y0) + ";width:" + pct(x1 - x0) + ";height:" + pct(y1 - y0) + '"></div>';
      bx = x1; by = y0;
    } else {
      const cls = (isQ ? " q" : " c-" + (x.color || "yellow") + (x.style === "underline" ? " s-ul" : "")) + on;
      h = x.rects.map(([x0, y0, x1, y1]) => '<div class="pv-mark' + cls + '" data-note="' + id + '" style="left:' + pct(x0) + ";top:" + pct(y0) + ";width:" + pct(x1 - x0) + ";height:" + pct(y1 - y0) + '"></div>').join("");
      const last = x.rects[x.rects.length - 1] || [0, 0, 0, 0];
      bx = last[2]; by = last[1];
    }
    if ((x.kind !== "highlight" || x.region) && !x.temp) {
      const state = isQ ? (PR.asking && PR.asking.has(x.id) ? " busy" : PR.repliesTo && PR.repliesTo(x.id).length ? " done" : "") : "";
      h += '<button class="pv-badge' + (isQ ? " q" : " c-" + (x.color || "yellow")) + state + on + '" data-note="' + id + '" style="left:' + pct(bx) + ";top:" + pct(by) + '" title="' + PR.esc((x.body || "").slice(0, 90)) + '">' + (isQ ? "?" : "") + "</button>";
    }
    return h;
  }
  PR.renderPdfMarks = function (only) {
    const nodes = PR.pageNodes ? PR.pageNodes() : [];
    const notes = PR.myNotes().filter((x) => x.side === "pdf" && (Array.isArray(x.rects) || Array.isArray(x.region)));
    const draft = PR.stickyDraft && PR.stickyDraft();
    if (draft && !notes.some((x) => x.id === draft.id)) notes.push(draft);  // 正在寫的草稿、正在翻譯的那一段
    const openId = PR.stickyNote && PR.stickyNote();
    nodes.forEach((entry, i) => {
      const n = i + 1;
      if (only && only !== n) return;
      if (!entry.marks) { entry.marks = document.createElement("div"); entry.marks.className = "pv-marks"; entry.node.append(entry.marks); }
      entry.marks.innerHTML = notes.filter((x) => x.page === n).map((x) => markHtml(x, openId)).join("");
    });
  };

  /* 點在哪條標記上：框最小的那條（疊在一起時點得到上面短的）。框選區域不算，它只認小圓點 */
  function noteAt(page, x, y) {
    let best = null, area = Infinity;
    for (const n of PR.myNotes()) {
      if (n.side !== "pdf" || n.page !== page || !Array.isArray(n.rects)) continue;
      for (const [x0, y0, x1, y1] of n.rects) {
        const a = (x1 - x0) * (y1 - y0);
        if (x >= x0 && x <= x1 && y >= y0 - 0.002 && y <= y1 + 0.002 && a < area) { best = { note: n, rect: [x0, y0, x1, y1] }; area = a; }
      }
    }
    return best;
  }
  const pointIn = (page, e) => { const r = page.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, r]; };
  /* 點標記：畫線彈改色選單，筆記和提問打開便利貼 */
  document.addEventListener("click", (e) => {
    const page = e.target.closest && e.target.closest("#pageview .pv-page");
    if (!page || e.target.closest(".pv-sticky, .pv-badge, a, button, textarea, input") || document.body.classList.contains("region-mode")) return;
    if (String(getSelection())) return;  // 正在選字
    const [x, y, r] = pointIn(page, e);
    const hit = noteAt(+page.dataset.n, x, y);
    if (!hit) return;
    e.stopPropagation();
    const [x0, y0, x1, y1] = hit.rect;
    const box = { left: r.left + x0 * r.width, top: r.top + y0 * r.height, width: (x1 - x0) * r.width, height: (y1 - y0) * r.height };
    box.right = box.left + box.width; box.bottom = box.top + box.height;
    PR.noteMarkClick({ getBoundingClientRect: () => box }, hit.note);
  }, true);
  /* 滑到標記上：游標換成手指，看得出可以點 */
  document.addEventListener("mousemove", PR.throttle(() => {
    const e = lastMove, page = e && e.target.closest && e.target.closest("#pageview .pv-page");
    PR.$$(".pv-page.on-mark").forEach((p) => p !== page && p.classList.remove("on-mark"));
    if (!page || e.buttons) return;
    const [x, y] = pointIn(page, e);
    page.classList.toggle("on-mark", !!noteAt(+page.dataset.n, x, y));
  }, 60));
  let lastMove = null;
  document.addEventListener("mousemove", (e) => { lastMove = e; }, true);
})(window.PR);
