/* 問 AI 這一輪加的幾個純函式：示意圖的小方塊（viz.js）、卡片的邊（cardsize.js）、文章優先擠著排的欄寬（margin.js 的 marginFit）、
   選取 → 引用（chat-link.js）、AI 讀過的範圍那一句話（chat-doc.js）。  node --test tests/test_ai_panel.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const src = (rel) => fs.readFileSync(path.join(__dirname, "../easyread/web/js", rel), "utf8");
const doc = () => ({ addEventListener() {}, documentElement: { classList: { add() {} } }, body: { classList: { add() {}, remove() {}, contains: () => false } } });
const base = (extra) => Object.assign({ state: { reader: { notes: {} }, discussion: { entries: [] } }, t: (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m)),
  esc: (s) => String(s), icon: () => "", $: () => null, $$: () => [], debounce: (fn) => fn, on: () => {}, emit: () => {}, blockById: {}, prefs: {} }, extra || {});

test("viz cells: a map string becomes a grid; unknown characters count as lit, short rows are padded", () => {
  const PR = base();
  vm.runInNewContext(src("common/viz.js"), { window: { PR } });
  const g = PR.vizCells("10010010/01001001");
  assert.equal(g.cols, 8);
  assert.equal(g.cells.length, 16);
  assert.equal(g.cells.slice(0, 4).join(), "c1,c0,c0,c1");
  assert.equal(PR.vizCells("12/3x.").cells.join(), "c1,c2,sp,c3,cx,sp");  // 第一排比較短：補空格
  assert.equal(PR.vizCells("").cols, 0);
  assert.equal(PR.vizCells("1".repeat(40)).cols, 24);  // 一排最多 24 格
  assert.ok(PR.vizCells(("1".repeat(24) + "/").repeat(60)).cells.length <= 600);
});

test("viz without a DOM parser (tests, exports) falls back to showing the source escaped, never raw HTML", () => {
  const PR = base();
  vm.runInNewContext(src("common/viz.js"), { window: { PR } });
  const html = PR.vizHtml('<div class="viz"><script>alert(1)</script></div>');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("card edges: left edge, bottom edge and the bottom-left corner are grabbable along their whole length", () => {
  const PR = base();
  vm.runInNewContext(src("reader/cardsize.js"), { window: { PR }, document: doc(), requestAnimationFrame: () => 0, performance: { now: () => 0 } });
  const r = { left: 100, right: 400, top: 50, bottom: 650 };
  assert.equal(PR.cardEdge(r, 103, 300), "w");     // 左緣中段（不必回到卡片最上面）
  assert.equal(PR.cardEdge(r, 103, 60), "w");
  assert.equal(PR.cardEdge(r, 250, 646), "s");     // 下緣
  assert.equal(PR.cardEdge(r, 104, 646), "ws");    // 角落
  assert.equal(PR.cardEdge(r, 112, 648), "ws");    // 角落放寬一點
  assert.equal(PR.cardEdge(r, 250, 300), "");      // 中間不是邊
  assert.equal(PR.cardEdge(r, 395, 300), "");      // 右緣不拉（卡片右邊貼齊欄位）
  assert.equal(PR.cardEdge(r, 50, 300), "");       // 卡片外面
});

test("article margin fits beside the text when there is room, and gives up when there is not", () => {
  const PR = base({ store: { mode: "server" }, canChat: () => true, feature: () => true });
  vm.runInNewContext(src("reader/margin.js"), { window: { PR, matchMedia: () => ({ matches: false }) }, document: doc(), innerWidth: 1100 });
  assert.equal(PR.marginFit(700, 260, 735), null);                 // 正文＋一欄卡片擺不下：收成段尾的小數字
  const narrow = PR.marginFit(800, 0, 735);                         // 開著問 AI、13 吋螢幕剩下的寬度
  assert.ok(narrow && narrow.margin >= 210 && narrow.stage <= 800 - 24);
  assert.ok(narrow.stage - narrow.gutter - narrow.gap - narrow.margin >= 460);  // 正文至少 460
  const wide = PR.marginFit(1100, 260, 735);
  assert.equal([wide.margin, wide.stage].join(), [260, 28 + 735 + 30 + 260].join());  // 夠寬：正文照設定的版心，不會被撐更寬
  assert.equal(PR.marginFit(1100, 900, 735).margin, 420);          // 自己把欄拉得很寬：最多 420，正文跟著讓窄
});

test("a selection becomes a chat reference only when it has text and a place", () => {
  const PR = base({ pid: "" });
  vm.runInNewContext(src("reader/chat-link.js"), { window: { PR, addEventListener() {} }, document: doc(), location: { search: "" } });
  assert.equal(PR.chatOnly, false);
  assert.equal(PR.chatLinkNormalize(null), null);
  assert.equal(PR.chatLinkNormalize({ anchor: "p1-1", quote: " a " }), null);          // 太短
  assert.equal(PR.chatLinkNormalize({ quote: "no place at all" }), null);              // 不知道在哪
  const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));  // 物件是另一個 vm 環境做的，直接 deepEqual 會嫌原型不同
  same(PR.chatLinkNormalize({ anchor: "p1-1", quote: "  the  loss\nfunction " }), { anchor: "p1-1", quote: "the loss function" });
  same(PR.chatLinkNormalize({ anchor: "", page: 3, quote: "x".repeat(1500) }), { anchor: "", quote: "x".repeat(1000), page: 3 });
});

test("the chat-only window is recognised from the address", () => {
  const PR = base({ pid: "" });
  vm.runInNewContext(src("reader/chat-link.js"), { window: { PR, addEventListener() {} }, document: doc(), location: { search: "?chat=1" } });
  assert.equal(PR.chatOnly, true);
});

test("document status reads as one sentence for every pre-read state", () => {
  const PR = base();
  vm.runInNewContext(src("reader/chat-doc.js"), { window: { PR }, document: doc(), setTimeout, clearTimeout });
  const d = { pages: 19, supp: [{}], state: "done" };
  assert.equal(PR.chatDoc.summary(d), "AI 已讀過整份（本文 19 頁＋補充資料 1 份）");
  assert.equal(PR.chatDoc.summary({ pages: 19, supp: [], state: "none" }), "AI 還沒讀過整份（本文 19 頁）");
  assert.ok(PR.chatDoc.summary({ pages: 80, supp: [], state: "running", done: 1, total: 3 }).endsWith("1/3"));
  assert.ok(PR.chatDoc.summary({ pages: 19, supp: [], state: "stale" }).includes("舊的"));
  assert.equal(PR.chatDoc.summary(null), "這份文件還沒準備好");
});
