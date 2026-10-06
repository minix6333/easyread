// 聊天回答加進筆記：分類小節的插入、分類清單、片段格式（noteadd.js 的純函式）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const PR = { t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s), state: { reader: {} }, $: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/noteadd.js"), "utf8"), { window: { PR } });
  return PR;
}

test("插進已有的分類末尾，其他小節不動", () => {
  const PR = load();
  const body = "## 基礎觀念\n\n第一條\n\n## 疑問\n\n為什麼？\n";
  const out = PR.noteInsert(body, "基礎觀念", "**Q**\n\n答");
  assert.equal(out, "## 基礎觀念\n\n第一條\n\n**Q**\n\n答\n\n## 疑問\n\n為什麼？");
});

test("沒有那個分類就在最後新開一節；空筆記直接開", () => {
  const PR = load();
  assert.equal(PR.noteInsert("", "定義", "x"), "## 定義\n\nx\n");
  assert.equal(PR.noteInsert("前言\n", "定義", "x"), "前言\n\n## 定義\n\nx\n");
  assert.equal(PR.noteInsert("## 基礎觀念\n\na\n", "定義", "x"), "## 基礎觀念\n\na\n\n## 定義\n\nx\n");
});

test("### 不算分類；最後一節也能接", () => {
  const PR = load();
  const out = PR.noteInsert("## 方法\n\n### 細節\n\na", "方法", "b");
  assert.equal(out, "## 方法\n\n### 細節\n\na\n\nb\n");
});

test("分類清單：筆記裡的小節在前，再補預設的，不重複", () => {
  const PR = load();
  const cats = PR.noteCategories("## 我的分類\n\nx\n\n## 定義\n\ny\n\n### 不算\n");
  assert.deepEqual(cats.slice(0, 3), ["我的分類", "定義", "基礎觀念"]);
  assert.equal(cats.filter((c) => c === "定義").length, 1);
  assert.ok(!cats.includes("不算"));
});

test("片段：問題當粗體標題附頁碼，回答裡的 ## 降成 ###", () => {
  const PR = load();
  const s = PR.noteSnippet({ title: "這段  在講什麼", body: "## 結論\n\n是這樣。\n# 大標\n正文", page: 6 });
  assert.equal(s, "**這段 在講什麼**（第 6 页）\n\n### 結論\n\n是這樣。\n### 大標\n正文");
  assert.equal(PR.noteSnippet({ body: "只有回答" }), "只有回答");
});
