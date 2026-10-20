/* 外部工具欄裡的 AI 讀得到正在讀的文件：放進那個網頁的程式（web/js/dock-guest.js 的純函式：頁碼的格式、底色怎麼換）、
   主程序收檔案前的檢查（electron/embed-bridge.cjs）。實際嵌進網頁的流程在 scripts/dock_ai_check.cjs。
   node --test tests/test_dock_ai.cjs */
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const G = require("../easyread/web/js/dock-guest.js");
const bridge = require("../electron/embed-bridge.cjs");

const refs = (s, max) => G.pageRefs(s, max).map((r) => s.substr(r.start, r.len) + "=" + r.page + (r.to !== r.page ? "-" + r.to : ""));

test("page numbers in Chinese answers: single pages, ranges, slides", () => {
  assert.deepEqual(refs("見第 5 頁和第3至5頁，還有第 12–14 頁。"), ["第 5 頁=5", "第3至5頁=3-5", "第 12–14 頁=12-14"]);
  assert.deepEqual(refs("第 5 張投影片、投影片第 7 張、投影片 9"), ["第 5 張投影片=5", "投影片第 7 張=7", "投影片 9=9"]);
  assert.deepEqual(refs("第五頁（中文數字）"), []);
});

test("page numbers in English answers, but not p-values, p5 or section numbers", () => {
  assert.deepEqual(refs("See p. 5, pp. 3–4, page 12, Pages 7-9, slide 3."), ["p. 5=5", "pp. 3–4=3-4", "page 12=12", "Pages 7-9=7-9", "slide 3=3"]);
  assert.deepEqual(refs("Not p5, p-value, p < 0.05, step 5, app. 5, page 12.5"), []);
});

test("page numbers past the end of the document are not links", () => {
  assert.deepEqual(refs("第 99 頁和第 3 頁", 59), ["第 3 頁=3"]);
});

const lab = (hex) => G.toLab([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
const hex = (l) => "#" + G.toRgb(l).map((c) => c.toString(16).padStart(2, "0")).join("");

test("colour conversion round-trips", () => {
  for (const h of ["#000000", "#222222", "#1f2329", "#f2f6fb", "#ffffff", "#10a37f"]) assert.equal(hex(lab(h)), h);
});

test("dark: the site's black becomes FOLI's sheet, raised surfaces stay lighter, text and brand colours are left alone", () => {
  const site = lab("#000000"), ours = lab("#1f2329");
  assert.equal(hex(G.remap(site, site, ours, true)), "#1f2329");
  const composer = G.remap(lab("#212121"), site, ours, true);
  assert.ok(composer[0] > ours[0], "the composer stays lighter than the background");
  assert.equal(G.remap(lab("#ececec"), site, ours, true), null);  // 文字
  assert.equal(G.remap(lab("#10a37f"), site, ours, true), null);  // 有顏色的按鈕
  assert.equal(G.remap(lab("#9b9b9b"), site, ours, true), null);  // 過了邊界的灰（次要文字）
});

test("light: white becomes FOLI's paper colour; a light site under a dark FOLI is not touched", () => {
  const site = lab("#ffffff");
  assert.equal(hex(G.remap(site, site, lab("#f2f6fb"), false)), "#f2f6fb");
  assert.equal(G.remap(site, site, lab("#222222"), true), null);  // 網站自己鎖在淺色、FOLI 是深色：不硬換
});

test("only files FOLI prepared in its cache share folder can be handed to the web page", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foli-share-"));
  const share = path.join(dir, "cache", "4cf6b1e1a402", "share");
  fs.mkdirSync(share, { recursive: true });
  const pdf = path.join(share, "取樣增強的監督式微調.pdf"), jpg = path.join(share, "doc p3.jpg"), html = path.join(share, "page.html");
  const chat = path.join(dir, "cache", "dock", "share", "原本的對話.md");  // 漂浮小視窗附上的原本那段對話
  fs.mkdirSync(path.dirname(chat), { recursive: true });
  for (const f of [pdf, jpg, html, chat]) fs.writeFileSync(f, "x");
  assert.deepEqual(bridge.checkFiles([pdf, jpg]), [pdf, jpg]);
  assert.deepEqual(bridge.checkFiles([chat]), [chat]);
  assert.equal(bridge.checkFiles([html]), null);                          // 不是 PDF、圖片、Markdown／文字檔
  assert.equal(bridge.checkFiles(["/etc/hosts"]), null);                  // 不在 share 資料夾
  assert.equal(bridge.checkFiles([path.join(share, "missing.pdf")]), null);
  assert.equal(bridge.checkFiles([path.join(share, "..", "..", "..", "x.pdf")]), null);
  assert.equal(bridge.checkFiles(["share/x.pdf"]), null);                 // 相對路徑
  assert.equal(bridge.checkFiles([]), null);
});

test("the right-click menu offers to jump to a page mentioned in the selected text", () => {
  assert.equal(bridge.pageIn("這在第 12 頁有推導"), 12);
  assert.equal(bridge.pageIn("see p. 7 for details"), 7);
  assert.equal(bridge.pageIn("no page here, p < 0.05"), 0);
  const sent = [];
  const items = bridge.selectionItems("見第 3 頁", true, (m) => sent.push(m));
  assert.deepEqual(items.filter((i) => i.label).map((i) => i.label), ["存成筆記", "在小視窗問這段", "在文件裡找這段", "跳到第 3 頁"]);
  items.find((i) => i.label === "跳到第 3 頁").click();
  assert.deepEqual(sent, [{ action: "page", page: 3 }]);
  assert.deepEqual(bridge.selectionItems("   ", true, () => {}), []);
});
