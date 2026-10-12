// 外殼：分頁和分割格子的狀態操作（shell.js 的純函式 PR.shellModel）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const PR = { t: (s) => s };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/shell.js"), "utf8"), { window: { PR }, document: undefined });
  return PR.shellModel;
}
const shown = (st) => st.panes.map((p) => p.tab);

test("開第一份：加在文獻庫後面並顯示；同一篇再開就切過去，帶錨點時換成新的網址", () => {
  const M = load(), st = M.blank();
  const a = M.open(st, "/read/aaa?library=x", "A");
  assert.deepEqual(st.tabs.map((t) => t.id), ["lib", a.id]);
  assert.deepEqual(shown(st), [a.id]);
  const b = M.open(st, "/read/bbb", "B");
  assert.deepEqual(st.tabs.map((t) => t.id), ["lib", a.id, b.id]);  // 加在目前分頁後面
  assert.equal(M.open(st, "/read/aaa#b-5"), a);
  assert.equal(a.url, "/read/aaa#b-5");
  assert.deepEqual(shown(st), [a.id]);
});

test("分割：先把沒顯示的文件擺到新的一格（文獻庫最後才輪到）；都顯示著就把目前這份再開一份", () => {
  const M = load(), st = M.blank();
  const a = M.open(st, "/read/aaa"), b = M.open(st, "/read/bbb");
  const t = M.split(st);
  assert.equal(t.id, a.id);  // b 在顯示中，a 沒有 → 擺 a（文獻庫也沒顯示，但先找文件）
  assert.deepEqual(shown(st), [b.id, a.id]);
  assert.equal(st.focus, 1);
  assert.ok(Math.abs(st.panes[0].w - 0.5) < 1e-9);
  assert.equal(M.split(st).id, "lib");  // 只剩文獻庫沒顯示
  assert.equal(st.panes.length, 3);
  assert.equal(M.split(st), null);  // 最多三格
  M.closePane(st, 2); M.closePane(st, 1);
  assert.deepEqual(shown(st), [b.id]);
  M.close(st, a.id);
  M.split(st);  // 文獻庫到第二格（焦點也到那一格）
  st.focus = 0;  // 讀者回到 b 那一格再分割
  const dup = M.split(st);  // 全都顯示著：把目前這份（b）再開一份
  assert.equal(dup.url, "/read/bbb");
  assert.equal(st.tabs.filter((x) => x.url === "/read/bbb").length, 2);
  assert.equal(st.panes.length, 3);
});

test("在文獻庫那一格點論文、而且有別格：開到別格", () => {
  const M = load(), st = M.blank();
  const a = M.open(st, "/read/aaa");
  M.split(st);  // 文獻庫擺到右邊
  assert.deepEqual(shown(st), [a.id, "lib"]);
  st.focus = 1;  // 讀者在文獻庫那格點了另一篇
  const b = M.open(st, "/read/bbb");
  assert.deepEqual(shown(st), [b.id, "lib"]);
  assert.equal(st.focus, 0);
});

test("關分頁：那一格改顯示鄰近的分頁；兩格會變成同一個就收掉一格；文獻庫關不掉", () => {
  const M = load(), st = M.blank();
  const a = M.open(st, "/read/aaa"), b = M.open(st, "/read/bbb"), c = M.open(st, "/read/ccc");
  M.close(st, c.id);
  assert.deepEqual(shown(st), [b.id]);
  M.split(st);  // a 到第二格
  assert.deepEqual(shown(st), [b.id, a.id]);
  M.close(st, a.id);
  assert.deepEqual(shown(st), [b.id, "lib"]);  // 第二格改顯示文獻庫（b 已在第一格）
  M.close(st, b.id);
  assert.deepEqual(shown(st), ["lib"]);  // 兩格都只剩文獻庫 → 收成一格
  M.close(st, "lib");
  assert.ok(st.tabs.some((t) => t.id === "lib"));
});

test("拖排順序與上一個／下一個", () => {
  const M = load(), st = M.blank();
  const a = M.open(st, "/read/aaa"), b = M.open(st, "/read/bbb"), c = M.open(st, "/read/ccc");
  M.move(st, c.id, a.id);
  assert.deepEqual(st.tabs.map((t) => t.id), ["lib", c.id, a.id, b.id]);
  M.move(st, a.id, "lib");  // 不能排到文獻庫前面
  assert.equal(st.tabs[0].id, "lib");
  M.show(st, b.id);
  assert.equal(M.step(st, 1).id, "lib");
  assert.equal(M.step(st, -1).id, b.id);
});

test("文件不在了：指到它的分頁全部關掉（並排開了兩份也一樣），其他分頁和文獻庫不動", () => {
  const M = load(), st = M.blank();
  const a = M.open(st, "/read/aaa", "A"), n = M.open(st, "/note/nnn", "N"), b = M.open(st, "/read/bbb", "B");
  M.show(st, n.id);
  M.split(st);  // 另一格擺別的文件
  st.focus = 0;
  assert.deepEqual(M.closeDocs(st, ["zzz"]), []);  // 沒開著的：什麼都不動
  assert.equal(st.tabs.length, 4);
  assert.deepEqual(M.closeDocs(st, ["nnn"]), [n.id]);
  assert.deepEqual(st.tabs.map((t) => t.id), ["lib", a.id, b.id]);
  assert.ok(!shown(st).includes(n.id));
  assert.ok(shown(st).every((id) => st.tabs.some((t) => t.id === id)));  // 每一格顯示的都是還在的分頁
  // 同一份並排開兩個：兩個都關
  const st2 = M.blank();
  const x = M.open(st2, "/read/xxx");
  M.split(st2);  // 文獻庫先擺到第二格
  st2.focus = 0;
  const dup = M.split(st2);  // 都顯示著：這一份再開一個
  assert.equal(dup.url, "/read/xxx");
  assert.deepEqual(M.closeDocs(st2, ["xxx"]).sort(), [x.id, dup.id].sort());
  assert.deepEqual(st2.tabs.map((t) => t.id), ["lib"]);
  assert.deepEqual(shown(st2), ["lib"]);
  assert.deepEqual(M.closeDocs(st2, ["lib"]), []);  // 文獻庫關不掉
});
