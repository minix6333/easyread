const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 問 AI 的範圍（chat-scope.js）：寫到一半就把〔D3 p.5〕畫成連結；標籤和按鈕
function load() {
  const PR = { t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s), esc: (s) => String(s), icon: (n) => "<i " + n + ">", state: { item: { tags: ["Paper"] } }, pid: "me", api: () => Promise.resolve({ items: [] }), $: () => null, $$: () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/chat-scope.js"), "utf8"), { window: { PR }, document: { addEventListener() {} } });
  return PR;
}

test("citations turn into links the same way the server stores them", () => {
  const PR = load();
  const docs = { D1: { id: "aaaa1111", who: "Karan 2026" }, D2: { id: "bbbb2222", who: "Wei 2025" } };
  assert.equal(PR.chatScope.cite("見〔D1 p.2〕和〔D2 第 5–6 頁〕。", docs), "見[Karan 2026 · p.2](/read/aaaa1111#page=2)和[Wei 2025 · p.5–6](/read/bbbb2222#page=5)。");
  assert.equal(PR.chatScope.cite("[D1 p.3, p.9]", docs), "[Karan 2026 · p.3](/read/aaaa1111#page=3) [Karan 2026 · p.9](/read/aaaa1111#page=9)");
  assert.equal(PR.chatScope.cite("〔D2〕〔D7 p.1〕〔D1 p.", docs), "[Wei 2025](/read/bbbb2222)〔D7 p.1〕〔D1 p.");  // 還沒寫完的、不在範圍裡的照原樣
  assert.equal(PR.chatScope.cite("沒有出處", null), "沒有出處");
});

test("the scope chip and button reflect the chosen scope", () => {
  const PR = load();
  const st = { scope: null, scopeOpen: false };
  assert.equal(PR.chatScope.chip(st), "");
  assert.match(PR.chatScope.button(st), /class="ch-scope"/);
  st.scope = { kind: "docs", ids: ["x1", "x2"] };
  assert.match(PR.chatScope.chip(st), /3 份文件<\/span>/);
  assert.match(PR.chatScope.button(st), /ch-scope on/);
  assert.equal(PR.chatScope.label({ kind: "tag", tag: "Paper" }), "分類「Paper」");
  st.scopeOpen = true;
  const menu = PR.chatScope.menu(st);
  assert.match(menu, /data-k="tag" data-tag="Paper"/);
  assert.match(menu, /data-k="all"/);
  assert.ok(PR.chatScope.act("scope-set", { dataset: { k: "all" } }, st));
  assert.deepEqual(JSON.parse(JSON.stringify(st.scope)), { kind: "all" });
  assert.ok(PR.chatScope.act("unscope", {}, st));
  assert.equal(st.scope, null);
});
