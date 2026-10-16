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
    "**_又粗又斜_**",  // 又粗又斜：斜體用 _（和 ** 貼在一起時，見 emitSeq）；舊的 ***字*** 照樣讀得懂
    "**粗體裡有 ==螢光==**",
    "圖 ![](clips/a1.png) 在這裡",
  ]) assert.equal(round(md), md, md);
});

test("literal markers are escaped so they stay literal", () => {
  const runs = [{ t: "a*b*c 5$ and 10$ ~~not~~ [x](y)", m: [] }];
  const md = R.emit(runs);
  assert.equal(md, "a\\*b\\*c 5\\$ and 10\\$ \\~~not\\~~ \\[x\\](y)");
  assert.deepEqual(JSON.parse(JSON.stringify(R.runsOfTree(R.parse(md)))), [{ t: "a*b*c 5$ and 10$ ~~not~~ [x](y)", m: [], link: null }]);
  // 行首的 # - > 1. 也跳脫（不然重新讀的時候變成標題、清單、引用）
  assert.equal(R.emit([{ t: "# 不是標題", m: [] }]), "\\# 不是標題");
  assert.equal(R.emit([{ t: "- 不是清單", m: [] }, { br: 1 }, { t: "1. 也不是", m: [] }]), "\\- 不是清單\n1\\. 也不是");
});

test("overlapping marks open and close in a stable order", () => {
  const md = R.emit([{ t: "粗", m: ["b"] }, { t: "粗斜", m: ["b", "i"] }, { t: "斜", m: ["i"] }]);
  assert.equal(md, "**粗_粗斜_**_斜_");  // 斜體貼著粗體時用 _：以前寫成 **粗*粗斜****斜*，讀不回來
  assert.equal(R.emit([{ t: "x", m: ["code", "b"] }]), "**\x60x\x60**");  // 程式碼在最裡面，裡面的字不跳脫
  assert.equal(R.emit([{ t: "a*b", m: ["code"] }]), "\x60a*b\x60");
});

test("links group their runs and keep marks inside", () => {
  const md = R.emit([{ t: "看", m: [] }, { t: "這", m: ["b"], link: "https://x.org" }, { t: "篇", m: [], link: "https://x.org" }]);
  assert.equal(md, "看[**這**篇](https://x.org)");
  assert.equal(round("[不是網址](javascript:alert(1))"), "\\[不是網址\\](javascript:alert(1))");
});

test("pasted plain text is cleaned: PDF line breaks, hyphens, CJK spaces, bullets, tables", () => {
  assert.equal(R.cleanPaste("This is a long line copied out of a PDF that was\nbroken in the middle of a sentence and the fine-\ntuning word too."),
    "This is a long line copied out of a PDF that was broken in the middle of a sentence and the finetuning word too.");
  assert.equal(R.cleanPaste("機 器 學 習 是 好 的"), "機器學習是好的");
  assert.equal(R.cleanPaste("• 第一點\n・第二點\n1、第三點"), "- 第一點\n- 第二點\n1. 第三點");
  assert.equal(R.cleanPaste("短的一行\n下一行"), "短的一行\n下一行");  // 短的行不接
  assert.equal(R.cleanPaste("名稱\t數字\nA\t1\nB\t2"), "| 名稱 | 數字 |\n| --- | --- |\n| A | 1 |\n| B | 2 |");
});

// 存回去再讀回來要一模一樣（點進一塊再點出來，Markdown 不能被改壞）：runs → md → runs
const back = (runs) => JSON.parse(JSON.stringify(R.runsOfTree(R.parse(R.emit(runs))))).map((r) => (r.t != null ? { t: r.t, m: r.m.slice().sort() } : r.br ? { br: 1 } : r));
const norm = (runs) => runs.map((r) => (r.t != null ? { t: r.t, m: (r.m || []).slice().sort() } : r));
test("bold and italic next to each other read back the same", () => {
  for (const runs of [
    [{ t: "粗", m: ["b"] }, { t: "粗斜", m: ["b", "i"] }, { t: "斜", m: ["i"] }],
    [{ t: "整段斜", m: ["i"] }, { t: "這字粗", m: ["i", "b"] }],
    [{ t: "a", m: ["b"] }, { t: "b", m: ["i"] }],
    [{ t: "斜", m: ["i"] }, { t: "粗", m: ["b"] }],
    [{ t: "重點", m: ["b"] }, { t: "斜", m: ["b", "i"] }],
    [{ t: "p<0.05*", m: ["b"] }],
    [{ t: "又粗又斜", m: ["b", "i"] }],
    [{ t: "snake_case 和 _底線_", m: [] }],
  ]) assert.deepEqual(back(runs), norm(runs), R.emit(runs));
});
test("numbered-looking lines, links with parentheses and literal link text survive", () => {
  const md = R.emit([{ t: "1. Introduction", m: [] }]);
  assert.equal(md, "1\\. Introduction");  // 跳脫的是點，不是數字（\1. 會一直留著一條反斜線）
  assert.deepEqual(back([{ t: "1. Introduction", m: [] }]), [{ t: "1. Introduction", m: [] }]);
  const url = "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)";
  const lmd = R.emit([{ t: "Transformer", m: [], link: url }]);
  const tree = R.parse(lmd);
  assert.equal(tree.length, 1);
  assert.equal(decodeURIComponent(tree[0].link), url);
  assert.deepEqual(back([{ t: "見 [x](https://e.com) 這段", m: [] }]), [{ t: "見 [x](https://e.com) 這段", m: [] }]);
});
test("an empty formula is not saved as $$ (that would swallow the rest of the note)", () => {
  assert.equal(R.emit([{ t: "a", m: [] }, { tex: "", m: [] }, { t: "b", m: [] }]), "ab");
});
