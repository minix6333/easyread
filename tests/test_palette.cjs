// 快速開啟（palette.js）：打的字怎麼對上標題（純函式 PR.paletteRank）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const PR = { t: (s) => s };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/palette.js"), "utf8"), { window: { PR }, document: undefined });
  return PR.paletteRank;
}

test("每個詞都要對得上；標題開頭 > 某個詞的開頭 > 標題中間 > 其他欄位", () => {
  const rank = load();
  assert.equal(rank("", "anything"), 0);
  assert.equal(rank("zebra", "Attention Is All You Need", "Vaswani 2017"), -1);
  const head = rank("atten", "Attention Is All You Need"), word = rank("need", "Attention Is All You Need"), mid = rank("tent", "Attention Is All You Need"), extra = rank("vaswani", "Attention Is All You Need", "Vaswani 2017");
  assert.ok(head > word && word > mid && mid > extra && extra > 0, JSON.stringify({ head, word, mid, extra }));
  assert.ok(rank("attention vaswani", "Attention Is All You Need", "Vaswani 2017") > 0);  // 一個詞在標題、一個在作者
  assert.equal(rank("attention zebra", "Attention Is All You Need", "Vaswani 2017"), -1);
});

test("不分大小寫；中文照字面對；一樣對得上的，標題短的在前", () => {
  const rank = load();
  assert.ok(rank("GRADIENT", "Gradient Descent") > 0);
  assert.ok(rank("梯度", "梯度下降筆記") > rank("梯度", "關於梯度的一些想法"));
  assert.ok(rank("筆記", "課堂筆記") > rank("筆記", "機器學習課堂上隨手寫下來的一份很長很長的筆記"));
});
