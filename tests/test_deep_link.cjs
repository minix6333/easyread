/* easyread:// 連結（electron/deep-link.cjs）：只放行 open 和認得的參數；電腦上的 AI App 用 &page= 和 &find= 請 FOLI 翻頁、標詞。
   node --test tests/test_deep_link.cjs */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const d = require("../electron/deep-link.cjs");

test("open links keep the document, page and phrase, and drop anything else", () => {
  assert.equal(d.openPath("easyread://open?id=4cf6b1e1a402&page=12&find=catastrophic forgetting"), "/open?id=4cf6b1e1a402&page=12&find=catastrophic+forgetting");
  assert.equal(d.openPath("easyread://open?id=4cf6b1e1a402&page=12x&evil=1"), "/open?id=4cf6b1e1a402");
  assert.equal(d.openPath("easyread://open?id=4cf6b1e1a402&page=3&find=%E7%AC%AC%0A2"), "/open?id=4cf6b1e1a402&page=3&find=%E7%AC%AC2");  // 換行之類的控制字元拿掉
  assert.equal(d.openPath("easyread://open?page=3"), null);  // 沒說是哪一份
  assert.equal(d.openPath("easyread://delete?id=4cf6b1e1a402"), null);
  assert.equal(d.fromArgv(["FOLI.exe", "easyread://open?id=abcd1234&page=2"]), "/open?id=abcd1234&page=2");
});
