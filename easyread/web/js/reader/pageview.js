/* 右侧面板：原文页（随阅读位置翻页、框出当前段）。和笔记面板共用右侧，一次开一个。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;
  let pvPage = 1, pvBlock = null;
  const pages = () => (S.paper.meta || {}).pages || [];
  const boxesOf = (loc) => loc.boxes && loc.boxes.length ? loc.boxes : [loc.box];
  /* 原頁看得見：右側面板開著，或是 PDF 優先版面（pdfmode.js，PDF 一直在左邊） */
  const visible = () => PR.side === "pages" || !!(PR.pdfMain && PR.pdfMain());
  const articleOpen = () => !PR.articleOpen || PR.articleOpen();

  /* 右侧面板开关：pages | notes | null */
  /* 面板滑出的同时正文就让位：重排只要几十毫秒（fitWide 不再重量公式），不必等面板滑完再跳一下。 */
  PR.side = null;
  PR.openSide = function (name) {
    PR.side = name;
    body.classList.toggle("pv-open", name === "pages");
    body.classList.toggle("np-open", name === "notes");
    body.classList.toggle("ch-open", name === "chat");
    PR.$('[data-act="chat"]').classList.toggle("on", name === "chat");
    PR.$('[data-act="pages"]').classList.toggle("on", name === "pages");
    PR.$('[data-act="notes"]').classList.toggle("on", name === "notes");
    PR.syncFabs && PR.syncFabs();
    if (name) { const t = PR.$("#toast"); if (t) t.classList.remove("open"); }  // 提示条别挡住面板底部的输入框
    if (body.classList.contains("side-open") === !!name) return;  // 面板之间切换：正文宽度不变
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    body.classList.toggle("side-open", !!name);
    PR.fitMargin && PR.fitMargin();  // 文章優先：右邊那欄卡片還擺不擺得下，馬上定（不然面板滑出來的那一下卡片會先消失）
    if (PR.applyLayout) PR.applyLayout();  // PDF 優先：三欄擠不下時重新分配寬度
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);  // 重排后还停在刚才读的地方
    // 寬公式重量、邊注重排（開著譯文時要一兩百毫秒）等面板滑完再做，滑動的那 0.2 秒才不會掉幀
    PR.afterSlide(() => {
      const top = node ? node.getBoundingClientRect().top : 0;
      PR.fitWide(); PR.renderMargin();
      if (node) window.scrollBy(0, node.getBoundingClientRect().top - top);
    });
  };
  /* 面板滑進滑出要 .22 秒（CSS --dur）：重的工作排到那之後；連著叫幾次只做最後一次 */
  let slideT = null;
  PR.afterSlide = function (fn) { clearTimeout(slideT); slideT = setTimeout(fn, 240); };

  PR.togglePages = function (force) {
    if (PR.pdfMain && PR.pdfMain()) { PR.toggleArticle && PR.toggleArticle(force); return; }  // PDF 優先：這顆按鈕開關的是譯文
    const open = force != null ? force : PR.side !== "pages";
    PR.openSide(open ? "pages" : null);
    if (open) PR.syncPage(true); else pair(null);
  };
  PR.openPage = function (page, blockId, opts) {
    pvBlock = blockId || null;
    if (!visible()) PR.openSide("pages");
    showPage(page, blockId, opts);
  };
  /* 現在在哪一頁：除了存進閱讀進度（store，幾秒才寫一次），也立刻記在瀏覽器裡——關掉再開時以較新的那個為準，不會因為關得太快而丟 */
  const LAST = () => "easyread-last-page:" + PR.pid;
  const remember = (n) => { if (PR.pdfMain && PR.pdfMain() && PR.pid) PR.ls.set(LAST(), { page: n, at: Date.now() }); };
  PR.lastPage = function () {
    const local = PR.ls.get(LAST(), null) || {};
    const p = S.reader.progress || {};
    const serverAt = p.at ? Date.parse(p.at) || 0 : 0;
    if (local.page && (local.at || 0) > serverAt + 2000) return local.page;  // 本機較新（存進度要等幾秒；另一台改的進度帶時間戳）
    return p.page || local.page || 1;
  };

  /* 原图是 2.4 倍渲染（约 1500 像素宽、几百 KB），面板用不了那么大：要一张和面板一样宽的，服务端生成一次后缓存；
     PDF 優先放大看時要更大的，服務端從 PDF 重新渲染 */
  function srcOf(n) {
    const p = pages()[n - 1];
    if (!p) return "";
    const base = PR.imageUrl(p.img);
    if (PR.store.mode !== "server") return base;
    const entry = pageNodes[n - 1];
    const need = ((entry && entry.node.clientWidth) || PR.$(".pv-scroll").clientWidth || 480) * (devicePixelRatio || 1);
    const w = need <= 1000 ? 1000 : need <= 1600 ? 1600 : need <= 2400 ? 2400 : need <= 3200 ? 3200 : 4000;  // 1000 宽的服务端已提前生成好
    return base + "?w=" + w;
  }
  let pageNodes = [], pageSource = null;
  const scroller = PR.$(".pv-scroll");
  function loadPage(n) {
    const entry = pageNodes[n - 1];
    if (!entry) return;
    const src = srcOf(n);
    if (entry.img.getAttribute("src") === src) return;
    if (!entry.img.getAttribute("src")) {  // 換清晰度時舊圖留著，不要閃一下骨架
      entry.node.classList.add("loading");
      entry.img.onload = () => entry.node.classList.remove("loading");
    }
    entry.img.setAttribute("src", src);
  }
  PR.pageNodes = () => pageNodes;
  PR.pdfPage = () => pvPage;
  PR.pdfBlock = () => pvBlock;
  PR.reloadPages = () => loadNearby(pvPage);  // 面板寬度、縮放變了：按新寬度換圖，不動捲動位置
  function loadNearby(n) {
    for (let i = Math.max(1, n - 2); i <= Math.min(pages().length, n + 2); i++) loadPage(i);
  }
  function ensurePages() {
    if (pageSource === pages()) return;
    pageSource = pages();
    pageNodes = pageSource.map((p, i) => {
      const node = document.createElement("div"), img = document.createElement("img"), hl = document.createElement("div");
      node.className = "pv-page";
      node.dataset.n = String(i + 1);
      node.style.aspectRatio = (p.w || 612) + " / " + (p.h || 792);
      img.alt = "Page " + (i + 1); img.decoding = "async";
      hl.className = "pv-hl";
      node.replaceChildren(img, hl);
      node.addEventListener("click", (e) => pickPage(e, i + 1));
      node.addEventListener("mousemove", (e) => {
        const r = node.getBoundingClientRect();
        node.classList.toggle("pickable", articleOpen() && !!blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, i + 1));
      });
      return { node, img, hl };
    });
    scroller.replaceChildren(...pageNodes.map(p => p.node));
    PR.resetTextLayers && PR.resetTextLayers();
    PR.emit && PR.emit("pages-built", pageNodes);  // pdfmode / pdftext 在頁上加文字層、標記、筆記欄
  }
  PR.preloadPage = () => {}; // Images are loaded near the panel viewport.
  function updatePageLabel() {
    const label = PR.$(".pv-label");
    label.textContent = pvPage + " / " + pages().length;
    label.title = PR.t("第 {p} / {n} 页", { p: pvPage, n: pages().length });
    const pdf = PR.$('[data-pv="pdf"]'), url = PR.pdfUrl(pvPage);
    pdf.style.display = url ? "" : "none";
    if (url) pdf.href = url;
  }
  function pageTop(node) {
    return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }
  let panelInput = false, programmaticUntil = 0;
  ["wheel", "pointerdown", "touchstart", "keydown"].forEach(type => scroller.addEventListener(type, () => {
    panelInput = true;
    holdUntil = Date.now() + 2000;
  }, { passive: true }));
  scroller.addEventListener("scrollend", () => { programmaticUntil = 0; });
  // Switching back to the text must immediately return control to that pane.
  ["wheel", "pointerdown", "touchstart", "keydown"].forEach(type => document.addEventListener(type, (e) => {
    if (e.target.closest("#pageview")) return;
    panelInput = false;
    holdUntil = 0;
  }, { passive: true, capture: true }));
  function followPanel(entry, middle) {
    if (!PR.$(".pv-follow input").checked) return;
    const r = entry.node.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (middle - r.top) / r.height));
    let best = null, bestBox = null, distance = Infinity;
    for (const id in S.layout) {
      const loc = S.layout[id];
      if (loc.page !== pvPage || !PR.blockById[id]) continue;
      for (const box of boxesOf(loc)) {
        if (!box) continue;
        const d = Math.max(box[1] - y, y - box[3], 0);
        if (d < distance) { best = id; bestBox = box; distance = d; }
      }
    }
    // Older imports may have page numbers but no paragraph coordinates.
    if (!best) best = Object.keys(PR.blockById).find(id => PR.blockById[id].page === pvPage);
    const node = best && document.getElementById("b-" + best);
    if (!node) return;
    pvBlock = best;
    highlightBlock(pvPage, best);
    if (!articleOpen()) return;  // 譯文收著：只記住現在讀到哪段
    const rect = node.getBoundingClientRect();
    const fraction = bestBox ? Math.max(0, Math.min(1, (y - bestBox[1]) / Math.max(0.001, bestBox[3] - bestBox[1]))) : 0;
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top + fraction * rect.height - window.innerHeight * 0.3), behavior: "instant" });
  }
  scroller.addEventListener("scroll", () => {
    if (!pageNodes.length || !visible()) return;
    // Native scrollbar drags can emit scroll without a DOM pointerdown.
    if (Date.now() >= programmaticUntil) panelInput = true;
    if (panelInput) holdUntil = Date.now() + 2000;
    const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    const entry = pageNodes.find(p => p.node.getBoundingClientRect().bottom > middle) || pageNodes[pageNodes.length - 1];
    pvPage = Number(entry.node.dataset.n);
    remember(pvPage);
    updatePageLabel(); loadNearby(pvPage);
    if (panelInput) followPanel(entry, middle);
  }, { passive: true });

  function highlightBlock(page, blockId) {
    pageNodes.forEach(p => p.hl.classList.remove("on"));
    const hl = pageNodes[page - 1].hl;
    const loc = blockId && S.layout[blockId];
    pair(loc && loc.page === page ? blockId : null);
    if (loc && loc.page === page) {
      const boxes = boxesOf(loc);
      hl.replaceChildren(...boxes.map(([x0, y0, x1, y1]) => {
        const region = document.createElement("div");
        region.className = "pv-region";
        Object.assign(region.style, { left: (x0 * 100 - 0.4) + "%", top: (y0 * 100 - 0.3) + "%", width: ((x1 - x0) * 100 + 0.8) + "%", height: ((y1 - y0) * 100 + 0.6) + "%" });
        return region;
      }));
      hl.classList.add("on");
    }
  }

  function showPage(page, blockId, opts) {
    const list = pages();
    if (!list.length) return;
    pvPage = Math.min(list.length, Math.max(1, page));
    remember(pvPage);
    const behavior = opts && opts.instant ? "auto" : "smooth";
    ensurePages();
    panelInput = false;
    programmaticUntil = Date.now() + 1500;
    const { node } = pageNodes[pvPage - 1];
    loadNearby(pvPage); updatePageLabel();
    highlightBlock(pvPage, blockId);
    const loc = blockId && S.layout[blockId];
    if (loc && loc.page === pvPage) {
      const boxes = boxesOf(loc);
      const [, y0, , y1] = boxes[0];
      scroller.scrollTo({ top: Math.max(0, pageTop(node) + ((y0 + y1) / 2) * node.offsetHeight - scroller.clientHeight / 2), behavior });
    } else {
      scroller.scrollTo({ top: Math.max(0, pageTop(node) - 18), behavior });
    }
  }

  /* 译文里和原页框对应的那段也标出来（同一个颜色），一眼看出左右是哪两段 */
  let paired = null, holdUntil = 0;
  function pair(id) {
    if (paired === id) return;
    const old = paired && document.getElementById("b-" + paired);
    if (old) old.classList.remove("pv-pair");
    paired = id;
    const node = id && document.getElementById("b-" + id);
    if (node) node.classList.add("pv-pair");
  }
  PR.on("block-rendered", (id) => { if (id === paired) { paired = null; pair(id); } });  // 段落重画后补回标记
  PR.on("rendered", () => { const id = paired; paired = null; pair(id); });
  PR.on("remote", (changed) => { if (visible() && changed.includes("layout")) showPage(pvPage, pvBlock); });

  /* 点原页上的某一段 → 正文跳到那段译文（排版特殊、看不出语序时，从原文找回去） */
  function blockAt(x, y, page = pvPage) {
    let best = null, area = Infinity;
    for (const id in S.layout) {
      const l = S.layout[id];
      if (l.page !== page || !PR.blockById[id]) continue;
      for (const [x0, y0, x1, y1] of boxesOf(l)) {
        const a = (x1 - x0) * (y1 - y0);
        if (x >= x0 - 0.01 && x <= x1 + 0.01 && y >= y0 - 0.006 && y <= y1 + 0.006 && a < area) { best = id; area = a; }
      }
    }
    return best;
  }
  PR.blockAt = blockAt;
  function pickPage(e, page) {
    if (e.target && e.target.closest && e.target.closest(".pv-sticky, .pv-badge, a, button, textarea")) return;
    if (typeof getSelection === "function" && String(getSelection())) return;  // 正在選字
    const r = e.currentTarget.getBoundingClientRect();
    const id = blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, page);
    if (!id) return;
    pvPage = page;
    pvBlock = id;
    if (!articleOpen()) return;  // 譯文收著：點 PDF 不要彈出譯文（想看時自己按「譯文」），只記住讀到哪段
    holdUntil = Date.now() + 1500;  // 跳过去的滚动会触发“跟随阅读位置”，别让它把刚点的段换掉
    showPage(pvPage, id);
    PR.jumpTo("b-" + id);
  }

  PR.syncPage = function (force) {
    if (!visible()) return;
    if (!force && (!PR.$(".pv-follow input").checked || Date.now() < holdUntil)) return;
    const reading = PR.readingBlock();
    // Selection controls an explicit click; scrolling follows the viewport.
    const id = force ? (PR.currentBlock && PR.currentBlock()) || reading : reading;
    const b = PR.blockById[id];
    if (!b) {  // 还在标题区，不在任何一段上：给第 1 页，别让面板空着
      if (force || pvBlock) { pvBlock = null; showPage(1); }
      return;
    }
    if (!force && id === pvBlock) return;
    pvBlock = id;
    const loc = S.layout[id];
    showPage(loc ? loc.page : b.page, id);
  };

  document.addEventListener("click", (e) => {  // 工具列在 PDF 優先時搬到頂欄（pdfmode.js），所以掛在 document 上
    const b = e.target && e.target.closest && e.target.closest("[data-pv]");
    if (!b) return;
    const act = b.dataset.pv;
    if (act === "close") { PR.openSide(null); pair(null); }
    if (act === "prev") PR.pageStep(-1);
    if (act === "next") PR.pageStep(1);
  });
  PR.refreshPages = () => showPage(pvPage);  // 面板宽度变了，按新宽度换图
  PR.pageStep = (d) => {
    showPage(pvPage + d);
    const entry = pageNodes[pvPage - 1];
    if (!entry) return;
    holdUntil = Date.now() + 2000;
    followPanel(entry, entry.node.getBoundingClientRect().top);
  };
})(window.PR);
