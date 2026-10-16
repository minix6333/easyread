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
  /* 面板滑出的同时正文就让位：重排只要几十毫秒（fitWide 不再重量公式），不必等面板滑完再跳一下。
     面板開／關（不是面板之間切換）時，整個畫面用 View Transitions 換過去（PR.morph）：畫布、PDF 頁、頂欄右邊的鈕、頁碼膠囊
     從舊位置、舊大小滑到新的，面板從右邊滑進來——以前是 PDF 頁一下子變窄、重新解碼時整頁白一下，左邊的目錄還閃出來一塊。 */
  PR.side = null;
  PR.openSide = function (name) {
    const layout = body.classList.contains("side-open") !== !!name;
    PR.side = name;  // 馬上就是新的（後面接著叫的程式要看）；畫面上的 class 在 apply 裡換
    if (layout && PR.morph && PR.sideMotion !== false) PR.morph(() => applySide(name), { type: "side", names: PR.readerNames });
    else applySide(name);
  };
  /* 跟著滑的東西（PR.morph 的 names）：畫布、頂欄兩邊那幾顆、頁碼膠囊、「問 AI」、看得到的 PDF 頁（上下各多一頁）、
     開著的右側面板和它上面的分頁列（*.panel，從右邊滑進來）、釘著的導覽欄（*.panel-l，從左邊）。
     開關導覽欄（panels.js）、譯文（pdfmode.js）也用這一份。 */
  PR.readerNames = function () {
    // 畫布只在 PDF 優先時跟著滑：有名字的元素畫在其他東西（root）上面，文章優先時文章在 root 裡，畫布一滑就把整篇文章蓋住了
    const pdf = !!(PR.pdfMain && PR.pdfMain());
    const out = pdf ? [[PR.$("#canvas"), "rd-canvas", "fill"], [PR.$("#progress"), "rd-progress", "fill"]] : [];
    const bar = PR.$("#bar");
    [["#backBtn", "rd-back"], ['[data-act="drawer"]', "rd-nav"], ["#jobState", "rd-job"], [".view-seg", "rd-seg"], [".bar-group", "rd-group"], ['[data-act="insp"]', "rd-insp"]].forEach(([q, n]) => {
      const el = bar && PR.$(q, bar);
      if (el && el.offsetWidth) out.push([el, n]);
    });
    const head = PR.$(".pv-head"), ai = PR.$(".pv-ai"), back = PR.$(".jump-back");
    if (head && head.offsetWidth && pdf) out.push([head, "rd-pvhead"]);
    if (ai && ai.offsetWidth) out.push([ai, "rd-ai"]);
    if (back && back.offsetWidth) out.push([back, "rd-jump"]);
    if (pdf) {
      const vh = innerHeight;
      pageNodes.forEach((e, i) => {
        const r = e.node.getBoundingClientRect();
        if (r.height && r.bottom > -vh * 0.5 && r.top < vh * 1.5) out.push([e.node, "rd-p" + (i + 1), "page"]);
      });
    }
    const open = PR.$(body.classList.contains("np-open") ? "#notespanel" : body.classList.contains("ch-open") ? "#chatpanel" : body.classList.contains("in-open") ? "#infopanel" : body.classList.contains("pv-open") && !(PR.pdfMain && PR.pdfMain()) ? "#pageview" : null);
    if (open) out.push([open, "rd-panel", "panel"]);
    const tabs = PR.$("#inspTabs");
    if (tabs && tabs.offsetWidth) out.push([tabs, "rd-tabs", "panel"]);
    const nav = PR.$("#drawer");
    if (nav && body.classList.contains("nav-open")) out.push([nav, "rd-drawer", "panel-l"]);
    return out;
  };
  function applySide(name) {
    if (PR.side !== name) return;  // 這中間又換了（View Transitions 晚一格才跑）：以最後那次為準
    body.classList.toggle("pv-open", name === "pages");
    body.classList.toggle("np-open", name === "notes");
    body.classList.toggle("ch-open", name === "chat");
    body.classList.toggle("in-open", name === "info");  // 資訊（info.js）
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
  }
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
    return base + "?w=" + w + "&v=2";  // v：舊版伺服器有機會把寫到一半的圖交出來，瀏覽器會把那張壞圖記一天；換個網址，記著的壞圖就用不到了
  }
  let pageNodes = [], pageSource = null;
  const scroller = PR.$(".pv-scroll");
  /* 換清晰度（面板開合、縮放讓頁面變寬變窄）：先在畫面外載好、解碼好，再把整個 <img> 換上去——換的那一幀就畫得出來。
     以前直接改 src：新的那張要重新解碼，中間整頁白掉十分之一秒。第一次載入還是直接放（那時候本來就是一張空白的紙）。 */
  function loadPage(n) {
    const entry = pageNodes[n - 1];
    if (!entry) return;
    const img = entry.img, src = srcOf(n), cur = img.getAttribute("src");
    if (cur === src || entry.want === src) return;
    if (cur && entry.ok === cur) { swapPage(entry, n, src); return; }
    if (!cur) entry.node.classList.add("loading");  // 只是記著「這一頁的圖在路上」；畫面上就是一張空白的紙（不閃骨架、不淡入，見 reader-panels.css）
    img.onload = () => { entry.node.classList.remove("loading"); entry.ok = img.getAttribute("src"); entry.fails = 0; if (PR.painted) PR.painted(); };
    // 載不到（伺服器正忙、那張圖還在做）：換清晰度沒成功就先用回原來那張。還在附近的話等一下再試
    img.onerror = () => {
      entry.node.classList.remove("loading");
      entry.fails = (entry.fails || 0) + 1;
      if (entry.ok && entry.ok !== img.getAttribute("src")) img.setAttribute("src", entry.ok); else img.removeAttribute("src");
      if (entry.fails <= 3) setTimeout(() => { if (pageNodes[n - 1] === entry && Math.abs(pvPage - n) <= 2) loadPage(n); }, 700 * entry.fails);
    };
    img.setAttribute("src", src);
  }
  function swapPage(entry, n, src) {
    entry.want = src;
    const next = document.createElement("img");
    next.alt = entry.img.alt;
    next.decoding = "async";
    next.src = src;
    next.decode().then(() => {
      if (pageNodes[n - 1] !== entry || entry.want !== src) return;  // 這中間又換了一次（或整份重建了）
      entry.want = null;
      entry.img.replaceWith(next);
      entry.img = next;
      entry.ok = src;
      entry.fails = 0;
    }, () => {
      if (entry.want !== src) return;
      entry.want = null;
      entry.fails = (entry.fails || 0) + 1;  // 換不成就留著原來那張；還在附近的話等一下再試
      if (entry.fails <= 3) setTimeout(() => { if (pageNodes[n - 1] === entry && Math.abs(pvPage - n) <= 2) loadPage(n); }, 700 * entry.fails);
    });
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
    if (PR.painted) setTimeout(PR.painted, 500);  // 外殼等這一格畫好才換上來：第一張圖載得慢的話，頁框排好半秒後也算
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
  /* 某一頁上、畫面的 middle 那個高度最靠近哪一段：[段落 id, 那一段的框, 在頁上的幾分之幾] */
  function blockNear(entry, middle, page) {
    const r = entry.node.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (middle - r.top) / (r.height || 1)));
    let best = null, bestBox = null, distance = Infinity;
    for (const id in S.layout) {
      const loc = S.layout[id];
      if (loc.page !== page || !PR.blockById[id]) continue;
      for (const box of boxesOf(loc)) {
        if (!box) continue;
        const d = Math.max(box[1] - y, y - box[3], 0);
        if (d < distance) { best = id; bestBox = box; distance = d; }
      }
    }
    // Older imports may have page numbers but no paragraph coordinates.
    if (!best) best = Object.keys(PR.blockById).find(id => PR.blockById[id].page === page);
    return [best, bestBox, y];
  }
  /* PDF 現在看到哪一段（畫面中間那一段）。換版面、打開譯文時用：不管「跟隨」開沒開，都要對到眼前這一段 */
  PR.pdfBlockNow = function () {
    const entry = pageNodes[pvPage - 1];
    if (!entry || !scroller.clientHeight) return pvBlock;
    const hit = blockNear(entry, scroller.getBoundingClientRect().top + scroller.clientHeight / 2, pvPage)[0];
    if (hit) return hit;
    // 這一頁沒有任何一段（整頁是圖、還沒譯到）：往後找最近的一段，再沒有就用最後一段
    const pageOf = (b) => (S.layout[b.id] || b).page || 0;
    const all = (S.paper.blocks || []).filter((b) => PR.blockById[b.id]);
    const next = all.find((b) => pageOf(b) >= pvPage) || all[all.length - 1];
    return next ? next.id : pvBlock;
  };
  function followPanel(entry, middle) {
    if (!PR.$(".pv-follow input").checked) return;
    const [best, bestBox, y] = blockNear(entry, middle, pvPage);
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
    updatePageLabel(); loadWhenSlow();
    if (panelInput) followPanel(entry, middle);
  }, { passive: true });
  /* 捲到哪、圖載到哪——但飛快經過的頁不載（拉捲軸、跳到很遠的頁時一秒掠過幾十頁：每頁都去要圖，伺服器排一長串、畫面一路閃骨架）。
     慢慢讀的時候照舊馬上載（前後各兩頁，捲過去時圖已經在了）；快的時候等停下來那一刻再載 */
  let lastTop = 0, lastAt = 0, loadT = 0;
  function loadWhenSlow() {
    const now = Date.now(), top = scroller.scrollTop;
    const speed = Math.abs(top - lastTop) / Math.max(1, now - lastAt);  // 每毫秒幾像素
    lastTop = top; lastAt = now;
    clearTimeout(loadT);
    if (speed * 1000 < scroller.clientHeight * 4) loadNearby(pvPage);
    else loadT = setTimeout(() => loadNearby(pvPage), 90);
  }

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
    let top;
    if (loc && loc.page === pvPage) {
      const boxes = boxesOf(loc);
      const [, y0, , y1] = boxes[0];
      top = Math.max(0, pageTop(node) + ((y0 + y1) / 2) * node.offsetHeight - scroller.clientHeight / 2);
    } else {
      top = Math.max(0, pageTop(node) - 18);
    }
    // 很遠（超過兩個畫面）：先直接到目的地前後半個畫面的地方，只滑最後那一小段。整段用滑的會在不到一秒裡掠過幾十頁——
    // 每一頁都來不及畫（一塊一塊黑的）、圖也一路跟著要，看起來就是畫面在閃
    const from = scroller.scrollTop, room = scroller.clientHeight;
    if (behavior === "smooth" && Math.abs(top - from) > room * 2) scroller.scrollTop = top + (top > from ? -1 : 1) * room * 0.5;
    scroller.scrollTo({ top, behavior });
    PR.pdfSpotAt && PR.pdfSpotAt(top, behavior === "smooth");  // 「讀到哪裡」馬上換成這裡（pdfmode.js）：跳頁的同時版面變了，才不會被捲回原處
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

  /* 原頁跟上譯文讀到的地方。force：不管「跟隨」開沒開、讀到的段落變了沒有都對一次（點了某一段、剛打開原頁面板）。
     PDF 優先而且譯文收著的時候不做事：那時候 PDF 就是讀者自己在翻的那一邊，沒有「譯文讀到哪」可以跟。
     （2.1.0-tw.7 以前沒擋：在 Aa 裡換主題、字體、夜間頁面…都會叫到這裡，沒有譯文的文件找不到段落，就把 PDF 一路滑回第 1 頁） */
  PR.syncPage = function (force) {
    if (!visible()) return;
    if (PR.pdfMain && PR.pdfMain() && !articleOpen()) return;
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
