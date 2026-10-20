/* 筆記 AI 照讀者的話改筆記（web/js/common/note-ai.js 的純函式）：拆開模型的回覆、套到一塊一塊的筆記上、找出真的變了的那一段。
   伺服器那邊的提示詞在 tests/test_note_modes.py；實際在筆記面板、獨立筆記上走一遍在 scripts/note_ai_check.cjs。
   node --test tests/test_note_ai.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ai = require("../easyread/web/js/common/note-ai.js");

function editor() {  // 區塊編輯器的純函式（拆塊、合回 Markdown）
  const PR = { t: (s) => s, esc: (s) => String(s) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/blocks.js"), "utf8"), { window: { PR }, document: undefined });
  return PR;
}

test("the reply says what it understood, then the edits", () => {
  const p = ai.parse("@@ do: 整理；轉成待辦\n@@ replace 2-3\n- [ ] 學習率要小\n- [ ] 太大會發散\n\n@@ insert after 4\n## 小結\n\n重點\n@@ delete 5\n@@ move 6 after 0\n");
  assert.equal(p.do, "整理；轉成待辦");
  assert.deepEqual(p.hunks, [
    { op: "replace", a: 2, b: 3, md: "- [ ] 學習率要小\n- [ ] 太大會發散" },
    { op: "insert", after: 4, md: "## 小結\n\n重點" },
    { op: "delete", a: 5, b: 5 },
    { op: "move", a: 6, b: 6, after: 0 },
  ]);
  assert.equal(p.loose, "");
});

test("brackets, en dashes, a fenced reply and a reply that ignored the format", () => {
  assert.deepEqual(ai.parse("@@ do: 粗體\n@@ replace [3]–[5]\n**x**").hunks, [{ op: "replace", a: 3, b: 5, md: "**x**" }]);
  assert.deepEqual(ai.parse("```markdown\n@@ do: 整理\n@@ replace 1\n# 標題\n```").hunks, [{ op: "replace", a: 1, b: 1, md: "# 標題" }]);
  const loose = ai.parse("以下是改好的版本：\n- 一\n- 二");
  assert.deepEqual(loose.hunks, []);
  assert.equal(loose.loose, "- 一\n- 二");
  assert.equal(ai.parse("@@ replace 2\n  - 縮排的清單\n").hunks[0].md, "  - 縮排的清單");  // 開頭的空白（清單縮排）留著
});

test("edits are applied by the original numbers; overlapping and out-of-range edits are ignored", () => {
  const b = ["# 筆記", "甲", "乙", "丙", "丁"];
  assert.deepEqual(ai.apply(b, [{ op: "replace", a: 2, b: 3, md: "甲乙" }, { op: "insert", after: 5, md: "戊" }]), ["# 筆記", "甲乙", "丙", "丁", "戊"]);
  assert.deepEqual(ai.apply(b, [{ op: "delete", a: 4, b: 5 }, { op: "insert", after: 0, md: "最前面" }]), ["最前面", "# 筆記", "甲", "乙"]);
  assert.deepEqual(ai.apply(b, [{ op: "move", a: 5, b: 5, after: 1 }]), ["# 筆記", "丁", "甲", "乙", "丙"]);
  assert.deepEqual(ai.apply(b, [{ op: "replace", a: 2, b: 3, md: "X" }, { op: "delete", a: 3, b: 4 }]), ["# 筆記", "X", "丙", "丁"]);  // 重疊：後面那段不理
  assert.deepEqual(ai.apply(b, [{ op: "replace", a: 9, b: 9, md: "X" }, { op: "move", a: 2, b: 3, after: 2 }]), b);  // 超出範圍、搬到自己裡面：不理
  assert.deepEqual(ai.apply(b, [{ op: "insert", after: 3, md: "插在乙後" }, { op: "delete", a: 3, b: 3 }]), ["# 筆記", "甲", "插在乙後", "丙", "丁"]);  // 刪掉那一塊後面插的還在
});

test("only the part that really changed becomes the suggestion", () => {
  assert.deepEqual(ai.span(["a", "b", "c", "d"], ["a", "B", "c", "d"]), { from: 1, to: 1, md: "B", removed: 1, added: 1 });
  assert.deepEqual(ai.span(["a", "b"], ["a", "b", "c"]), { from: 2, to: 1, md: "c", removed: 0, added: 1 });  // 接在最後
  assert.deepEqual(ai.span(["a", "b", "c"], ["a", "c"]), { from: 1, to: 1, md: "", removed: 1, added: 0 });  // 刪掉一塊
  assert.equal(ai.span(["a", "b"], ["a", "b"]), null);
  assert.deepEqual(ai.span([], ["x", "y"]), { from: 0, to: -1, md: "x\n\ny", removed: 0, added: 2 });  // 空的筆記
});

test("the edited note splits into blocks exactly like the editor, so unchanged blocks compare equal", () => {
  const PR = editor();
  const md = "# 標題\n\n一段\n第二行\n\n- 一\n- 二\n  - 縮排\n\n```python\nx = 1\n\ny = 2\n```\n\n> [!tip] 訣竅\n> 內容\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
  const blocks = PR.blocksParse(md).map((b) => PR.blocksSerialize([b]));
  assert.deepEqual(ai.splitBlocks(PR, blocks), blocks);  // 一塊一塊接起來再拆，一樣
  const p = ai.parse("@@ do: 轉成待辦\n@@ replace 3-4\n- [ ] 一\n- [ ] 二");
  const next = ai.splitBlocks(PR, ai.apply(blocks, p.hunks));
  const sp = ai.span(blocks, next);
  assert.deepEqual([sp.from, sp.to, sp.md], [2, 3, "- [ ] 一\n\n- [ ] 二"]);
  assert.equal(next.length, blocks.length);
});
