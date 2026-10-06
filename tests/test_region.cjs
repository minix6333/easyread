// 跨頁框選：從 a 拖到 b 每一頁一塊（region.js 的純函式）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const PR = { t: (s) => s, $: () => ({ addEventListener() {} }), ls: { get: () => null }, toast() {} };
  const noop = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/region.js"), "utf8"),
    { window: { PR }, document: { body: { classList: { toggle() {}, contains: () => false } }, addEventListener: noop, createElement: () => ({ style: {}, remove() {} }) } });
  return PR;
}

test("同一頁：普通的框，座標取兩點的範圍", () => {
  const PR = load();
  assert.deepEqual(PR.regionSpans({ page: 3, x: 0.6, y: 0.7 }, { page: 3, x: 0.2, y: 0.3 }), [{ page: 3, rect: [0.2, 0.3, 0.6, 0.7] }]);
});

test("往下跨兩頁：第一頁到頁底、中間整頁、最後一頁從頁頂", () => {
  const PR = load();
  assert.deepEqual(PR.regionSpans({ page: 3, x: 0.1, y: 0.8 }, { page: 5, x: 0.9, y: 0.25 }), [
    { page: 3, rect: [0.1, 0.8, 0.9, 1] }, { page: 4, rect: [0.1, 0, 0.9, 1] }, { page: 5, rect: [0.1, 0, 0.9, 0.25] },
  ]);
});

test("往上拖也一樣，照頁碼排", () => {
  const PR = load();
  assert.deepEqual(PR.regionSpans({ page: 5, x: 0.9, y: 0.25 }, { page: 4, x: 0.1, y: 0.8 }), [
    { page: 4, rect: [0.1, 0.8, 0.9, 1] }, { page: 5, rect: [0.1, 0, 0.9, 0.25] },
  ]);
});
