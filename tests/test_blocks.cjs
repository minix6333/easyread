/* 區塊編輯器的純函式（web/js/common/blocks.js）：Markdown 拆成區塊、區塊合回 Markdown，來回要一樣。  node --test tests/test_blocks.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const PR = { t: (s) => s, esc: (s) => String(s) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/blocks.js"), "utf8"), { window: { PR }, document: undefined });
  return PR;
}
const types = (bs) => bs.map((b) => b.type + (b.kind ? ":" + b.kind : "") + (b.level ? b.level : "")).join(" ");

test("every kind of block parses and serializes back to the same Markdown", () => {
  const PR = load();
  const md = ["# 標題", "內文第一行\n第二行", "## 副標", "- 一", "- 二\n  續行", "  - 縮排", "1. 甲", "1. 乙", "- [ ] 待辦", "- [x] 做完", "> 引用\n> 兩行",
    "> [!tip] 小技巧\n> 內容", "> [!ref n1a2 p4] 「原話」", "```python\nprint(1)\n```", "$$\nE = mc^2\n$$", "---", "![](clips/a.png)", "| a | b |\n| --- | --- |\n| 1 | 2 |", "最後一段"].join("\n\n");
  const bs = PR.blocksParse(md);
  assert.equal(types(bs), "heading1 p heading2 list:bullet list:bullet list:bullet list:number list:number list:todo list:todo quote callout:tip callout:ref code math divider image table p");
  assert.equal(bs[5].indent, 1);
  assert.equal(bs[4].text, "二\n續行");
  assert.equal(bs[9].checked, true);
  assert.equal(bs[11].kind, "tip"); assert.equal(bs[11].text, "小技巧\n內容");
  assert.equal(bs[12].kind, "ref"); assert.equal(bs[12].args, "n1a2 p4"); assert.equal(bs[12].text, "「原話」");
  assert.equal(bs[13].lang, "python"); assert.equal(bs[13].text, "print(1)");
  assert.equal(bs[14].text, "E = mc^2");
  // 合回去：連著的清單項之間不空行（別的 Markdown 工具才當成一份清單），其他段落空一行
  const back = PR.blocksSerialize(bs);
  assert.equal(back, ["# 標題", "內文第一行\n第二行", "## 副標", "- 一\n- 二\n  續行\n  - 縮排\n1. 甲\n1. 乙\n- [ ] 待辦\n- [x] 做完", "> 引用\n> 兩行",
    "> [!tip] 小技巧\n> 內容", "> [!ref n1a2 p4] 「原話」", "```python\nprint(1)\n```", "$$\nE = mc^2\n$$", "---", "![](clips/a.png)", "| a | b |\n| --- | --- |\n| 1 | 2 |", "最後一段"].join("\n\n"));
  assert.equal(PR.blocksSerialize(PR.blocksParse(back)), back);  // 第二次來回不再變
});

test("odd input: blank, fences without closing, headings deeper than three, CRLF", () => {
  const PR = load();
  assert.deepEqual(PR.blocksParse("").length, 0);
  assert.equal(types(PR.blocksParse("```\ncode\n")), "code");
  assert.equal(PR.blocksParse("#### 深").at(0).level, 3);
  assert.equal(PR.blocksParse("a\r\n\r\nb").length, 2);
  assert.equal(PR.blocksParse("> [!什麼] x").at(0).type, "quote");  // 不認得的說明框種類：當一般引用
  assert.equal(PR.blocksSerialize(PR.blocksParse("- a\n\n\n- b")), "- a\n- b");
});

test("a click on rendered text maps back to the right place in the Markdown source", () => {
  const PR = load();
  const at = PR.blocksSrcOffset, OBJ = "￼";
  const src = "這有**粗體**、公式 $\\nabla f$，還有[連結](https://e.com)在中間。";
  const show = (vis, next) => { const i = at(src, vis, next); return i == null ? null : src.slice(0, i) + "|" + src.slice(i); };
  // 記號在前面：游標落在看得到的那個字前面，不是記號前面
  assert.equal(show("這有", "粗"), "這有**|粗體**、公式 $\\nabla f$，還有[連結](https://e.com)在中間。");
  assert.equal(show("這有粗", "體"), "這有**粗|體**、公式 $\\nabla f$，還有[連結](https://e.com)在中間。");
  // 收尾的記號（**、連結的網址）要跨過去
  assert.equal(show("這有粗體", "、"), "這有**粗體**|、公式 $\\nabla f$，還有[連結](https://e.com)在中間。");
  assert.equal(show("這有粗體、公式 " + OBJ + "，還有連結", "在"), "這有**粗體**、公式 $\\nabla f$，還有[連結](https://e.com)|在中間。");
  // 公式是一個佔位字元：點在它前面、後面
  assert.equal(show("這有粗體、公式 ", OBJ), "這有**粗體**、公式 |$\\nabla f$，還有[連結](https://e.com)在中間。");
  assert.equal(show("這有粗體、公式 " + OBJ, "，"), "這有**粗體**、公式 $\\nabla f$|，還有[連結](https://e.com)在中間。");
  // 最後面
  assert.equal(at(src, "這有粗體、公式 " + OBJ + "，還有連結在中間。", ""), src.length);
  assert.equal(at("**全粗**", "全粗", ""), 6);
  assert.equal(at("", "", ""), 0);
  // 換行、多的空白不影響；對不上（畫面和原文不是同一段）回 null，由呼叫的人把游標放最後
  assert.equal(at("第一行\n第二行", "第一行 第", "二"), 5);
  assert.equal(at("abc", "abx", ""), null);
  assert.equal(at("a \\* b", "a * ", "b"), 5);
});
