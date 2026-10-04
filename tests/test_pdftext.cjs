/* PDF 文字層：字元怎麼串成行、雙欄怎麼排順序、沒有空格的 PDF 怎麼補空格、行尾連字號怎麼接。  node --test tests/test_pdftext.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const PR = { state: { reader: {}, chars: {} }, store: { mode: "static" }, myNotes: () => [], esc: (s) => String(s), emit() {}, on() {}, throttle: (f) => f };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/pdftext.js"), "utf8"), {
    window: { PR }, document: { addEventListener() {}, createElement: () => ({ getContext: () => ({ measureText: (t) => ({ width: t.length * 5 }) }) }) },
    fetch: () => Promise.resolve({ ok: false }),
  });
  return PR;
}
/* 一行字：從 x 開始，每個字寬 w，字間距 gap（0 表示貼著） */
function line(text, x, y, { w = 0.01, h = 0.012, gap = 0 } = {}) {
  const out = [];
  let cx = x;
  for (const ch of text) {
    if (ch === " ") { cx += w; continue; }  // 用距離表示空格，不給空格字元
    out.push([ch, +cx.toFixed(4), y, +(cx + w).toFixed(4), +(y + h).toFixed(4)]);
    cx += w + gap;
  }
  return out;
}

test("words separated only by distance get spaces back", () => {
  const PR = load();
  const lines = PR.pdfLines(line("direct preference", 0.1, 0.2));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "direct preference");
});

test("a new baseline starts a new line and columns read left then right", () => {
  const PR = load();
  // 標題橫跨兩欄，下面左右各 8 行；內容流的順序故意打亂（右欄先、由下往上），行內的字還是順的
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(line("L" + i, 0.1, 0.2 + i * 0.03), line("R" + i, 0.55, 0.2 + i * 0.03));
  const chars = rows.reverse().flat().concat(line("Title", 0.3, 0.05, { w: 0.08 }));
  const texts = PR.pdfLines(chars).map((l) => l.text);
  assert.equal(texts[0], "Title");
  assert.equal(texts.slice(1, 9).join(","), "L0,L1,L2,L3,L4,L5,L6,L7");
  assert.equal(texts.slice(9).join(","), "R0,R1,R2,R3,R4,R5,R6,R7");
});

test("single-column pages read top to bottom and keep real space characters", () => {
  const PR = load();
  const a = line("second", 0.1, 0.3), b = line("first", 0.1, 0.1);
  b.splice(2, 0, [" ", 0.12, 0.1, 0.12, 0.112]);  // 零寬的空格字元也要留
  const texts = PR.pdfLines(a.concat(b)).map((l) => l.text);
  assert.equal(texts.join("|"), "fi rst|second");
});

test("joining lines repairs hyphenation and does not pad Chinese", () => {
  const PR = load();
  assert.equal(PR.pdfJoinLines(["fine-", "tuning on human", "demonstrations"]), "fine-tuning on human demonstrations");
  assert.equal(PR.pdfJoinLines(["第一行中文", "第二行"]), "第一行中文第二行");
  assert.equal(PR.pdfJoinLines(["end of a sen-", "Tence"]), "end of a sen- Tence");  // 大寫開頭不是斷字
});

test("subscripts stay on their line, so the DOM order matches the reading order", () => {
  const PR = load();
  const chars = line("P(w", 0.1, 0.2);
  const x = chars[chars.length - 1][3];
  chars.push(["1", x, 0.206, +(x + 0.006).toFixed(4), 0.214]);  // 下標：字框小一號、低一點
  chars.push(...line(") and x", x + 0.006, 0.2), ...line("next line", 0.1, 0.23));
  assert.equal(PR.pdfLines(chars).map((l) => l.text).join("|"), "P(w1) and x|next line");
});

test("vertical watermark text is left out of the text layer", () => {
  const PR = load();
  const side = Array.from("arXiv:2305.1", (ch, i) => [ch, 0.03, +(0.3 + i * 0.012).toFixed(4), 0.05, +(0.312 + i * 0.012).toFixed(4)]);  // 字框一個疊一個
  assert.equal(PR.pdfLines(side.concat(line("Body text", 0.2, 0.31))).map((l) => l.text).join("|"), "Body text");
  // 表格裡上下排的數字有行距，不算直排
  const column = ["1", "2", "3", "4", "5"].map((ch, i) => [ch, 0.5, +(0.3 + i * 0.03).toFixed(4), 0.51, +(0.312 + i * 0.03).toFixed(4)]);
  assert.equal(PR.pdfLines(column).length, 5);
});
