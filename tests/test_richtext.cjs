const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 所見即所得的一段字（common/richtext.js）的純函式：Markdown ⇄ 一段段 的來回、貼上的整理
function load() {
  const PR = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/richtext.js"), "utf8"), { window: { PR } });
  return PR.rich;
}
const R = load();
const round = (md) => R.emit(R.runsOfTree(R.parse(md)));

test("formatted text survives the round trip unchanged", () => {
  for (const md of [
    "純文字，沒有記號",
    "**粗體**、*斜體*、++底線++、~~刪除線~~、==螢光==、\x60code\x60",
    "公式 $p(x)=\\frac{1}{Z}$ 在中間",
    "[連結](https://example.com) 和 [文件](/read/abc123#page=3)",
    "第一行\n第二行",
    "***又粗又斜***",
    "**粗體裡有 ==螢光==**",
    "圖 ![](clips/a1.png) 在這裡",
  ]) assert.equal(round(md), md, md);
});

test("literal markers are escaped so they stay literal", () => {
  const runs = [{ t: "a*b*c 5$ and 10$ ~~not~~ [x](y)", m: [] }];
  const md = R.emit(runs);
  assert.equal(md, "a\\*b\\*c 5\\$ and 10\\$ \\~~not\\~~ [x\\](y)");
  assert.deepEqual(JSON.parse(JSON.stringify(R.runsOfTree(R.parse(md)))), [{ t: "a*b*c 5$ and 10$ ~~not~~ [x](y)", m: [], link: null }]);
  // 行首的 # - > 1. 也跳脫（不然重新讀的時候變成標題、清單、引用）
  assert.equal(R.emit([{ t: "# 不是標題", m: [] }]), "\\# 不是標題");
  assert.equal(R.emit([{ t: "- 不是清單", m: [] }, { br: 1 }, { t: "1. 也不是", m: [] }]), "\\- 不是清單\n\\1. 也不是");
});

test("overlapping marks open and close in a stable order", () => {
  const md = R.emit([{ t: "粗", m: ["b"] }, { t: "粗斜", m: ["b", "i"] }, { t: "斜", m: ["i"] }]);
  assert.equal(md, "**粗*粗斜***\x2a斜*".replace("\x2a", "*"));
  assert.equal(R.emit([{ t: "x", m: ["code", "b"] }]), "**\x60x\x60**");  // 程式碼在最裡面，裡面的字不跳脫
  assert.equal(R.emit([{ t: "a*b", m: ["code"] }]), "\x60a*b\x60");
});

test("links group their runs and keep marks inside", () => {
  const md = R.emit([{ t: "看", m: [] }, { t: "這", m: ["b"], link: "https://x.org" }, { t: "篇", m: [], link: "https://x.org" }]);
  assert.equal(md, "看[**這**篇](https://x.org)");
  assert.equal(round("[不是網址](javascript:alert(1))"), "[不是網址\\](javascript:alert(1))".replace("\\](", "\\]("));
});

test("pasted plain text is cleaned: PDF line breaks, hyphens, CJK spaces, bullets, tables", () => {
  assert.equal(R.cleanPaste("This is a long line copied out of a PDF that was\nbroken in the middle of a sentence and the fine-\ntuning word too."),
    "This is a long line copied out of a PDF that was broken in the middle of a sentence and the finetuning word too.");
  assert.equal(R.cleanPaste("機 器 學 習 是 好 的"), "機器學習是好的");
  assert.equal(R.cleanPaste("• 第一點\n・第二點\n1、第三點"), "- 第一點\n- 第二點\n1. 第三點");
  assert.equal(R.cleanPaste("短的一行\n下一行"), "短的一行\n下一行");  // 短的行不接
  assert.equal(R.cleanPaste("名稱\t數字\nA\t1\nB\t2"), "| 名稱 | 數字 |\n| --- | --- |\n| A | 1 |\n| B | 2 |");
});
