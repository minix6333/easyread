// 回答裡的圖（```flow）：語法解析和排版（js/common/flow.js 的純函式）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = (rel) => fs.readFileSync(path.join(__dirname, "../easyread/web/js", rel), "utf8");
function load() {
  const PR = { esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), t: (s) => s };
  vm.runInNewContext(src("common/flow.js"), { window: { PR } });
  return PR;
}
const size = () => ({ w: 80, h: 34 });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("節點形狀、文字、連線樣式", () => {
  const PR = load();
  const g = PR.flowParse('flowchart LR\n  A([開始]) --> B["f(x) = x^2"]\n  B -->|是| C{判斷}\n  C -.-> D[(資料庫)]\n  D ==> E(圓角<br>兩行)\n  E <--> A\n  E --- F');
  assert.equal(g.dir, "LR");
  assert.deepEqual(Object.keys(g.nodes), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(g.nodes.A.shape, "pill");
  assert.equal(g.nodes.B.text, "f(x) = x^2");
  assert.equal(g.nodes.C.shape, "decision");
  assert.equal(g.nodes.D.shape, "db");
  assert.equal(g.nodes.E.text, "圓角\n兩行");
  assert.equal(g.nodes.F.text, "F");
  const e = (a, b) => g.edges.find((x) => x.from === a && x.to === b);
  assert.equal(e("B", "C").label, "是");
  assert.equal(e("C", "D").style, "dotted");
  assert.equal(e("D", "E").style, "thick");
  assert.equal(e("E", "A").both, true);
  assert.equal(e("E", "F").arrow, false);
});

test("連寫、& 併排、線中間的說明", () => {
  const PR = load();
  const g = PR.flowParse("graph TD\nA --> B --> C\nA & B --> D\nC -- 回饋 --> A");
  assert.equal(g.edges.length, 5);
  assert.ok(g.edges.some((x) => x.from === "B" && x.to === "D"));
  assert.equal(g.edges.find((x) => x.from === "C" && x.to === "A").label, "回饋");
});

test("架構圖：分組、巢狀、組內方向、連到分組", () => {
  const PR = load();
  const g = PR.flowParse("flowchart TD\n  in[輸入] --> enc\n  subgraph enc[編碼器]\n    direction LR\n    a[注意力] --> f[前饋]\n    subgraph inner[\"殘差 (x2)\"]\n      r[相加]\n    end\n  end\n  enc --> out[輸出]");
  assert.deepEqual(Object.keys(g.groups), ["enc", "inner"]);
  assert.equal(g.groups.enc.title, "編碼器");
  assert.equal(g.groups.enc.dir, "LR");
  assert.equal(g.groups.inner.parent, "enc");
  assert.equal(g.groups.inner.title, "殘差 (x2)");
  assert.equal(g.nodes.a.group, "enc");
  assert.equal(g.nodes.r.group, "inner");
  assert.ok(!g.nodes.enc, "分組的 id 不是節點");
  const L = PR.flowLayout(g, size);
  const G = L.groups.enc, inside = (p) => p.x >= G.x && p.y >= G.y && p.x + p.w <= G.x + G.w + 0.01 && p.y + p.h <= G.y + G.h + 0.01;
  assert.ok(inside(L.nodes.a) && inside(L.nodes.f) && inside(L.groups.inner) && inside(L.nodes.r));
  assert.ok(L.nodes.a.x + L.nodes.a.w <= L.nodes.f.x, "組內由左到右");
  assert.ok(L.nodes.in.y + L.nodes.in.h <= G.y && G.y + G.h <= L.nodes.out.y, "外層由上到下：輸入 → 編碼器 → 輸出");
  assert.ok(!overlap(L.nodes.in, G) && !overlap(L.nodes.out, G));
});

test("排版：照方向分排、同排不重疊、分支左右對稱", () => {
  const PR = load();
  const g = PR.flowParse("flowchart TD\nA --> B\nA --> C\nA --> D\nB --> E\nC --> E\nD --> E");
  const L = PR.flowLayout(g, size), n = L.nodes;
  assert.ok(n.A.y < n.B.y && n.B.y === n.C.y && n.C.y === n.D.y && n.D.y < n.E.y);
  assert.ok(!overlap(n.B, n.C) && !overlap(n.C, n.D));
  const cx = (p) => p.x + p.w / 2;
  assert.ok(Math.abs(cx(n.A) - cx(n.C)) < 1 && Math.abs(cx(n.E) - cx(n.C)) < 1, "上下游在中間那個的正上／正下方");
  assert.ok(Object.values(n).every((p) => p.x >= 0 && p.y >= 0 && p.x + p.w <= L.w + 0.01 && p.y + p.h <= L.h + 0.01));
  const lr = PR.flowLayout(PR.flowParse("flowchart LR\nA --> B --> C"), size).nodes;
  assert.ok(lr.A.x < lr.B.x && lr.B.x < lr.C.x && lr.A.y === lr.B.y);
});

test("跨排的線繞過中間的框；有環不會卡住", () => {
  const PR = load();
  const g = PR.flowParse("flowchart TD\nA --> B --> C\nA --> C\nC --> A");
  const L = PR.flowLayout(g, size);
  const via = L.routes["|A>C"];
  assert.equal(via.length, 1);
  assert.ok(via[0].x < L.nodes.B.x || via[0].x > L.nodes.B.x + L.nodes.B.w, "途經的點不在 B 的框裡");
  assert.ok(L.routes["|C>A"] && L.routes["|C>A"].length === 1);
  const r = PR.flowRoute(L.nodes.A, L.nodes.C, "TD", via);
  assert.match(r.d, /^M[\d.]+ [\d.]+( C[\d. -]+){2}$/);
  const side = PR.flowRoute({ x: 0, y: 0, w: 80, h: 34 }, { x: 120, y: 0, w: 80, h: 34 }, "TD");
  assert.ok(side.d.startsWith("M80 17"), "同一排的兩個框從側邊連");
});

test("共同的那一層", () => {
  const PR = load();
  const g = PR.flowParse("flowchart LR\nsubgraph G1\n a --> b\nend\nsubgraph G2\n c\nend\na --> c\nx --> G1");
  assert.deepEqual({ ...PR.flowMeet(g, "a", "c") }, { level: "", a: "G1", b: "G2" });
  assert.deepEqual({ ...PR.flowMeet(g, "a", "b") }, { level: "G1", a: "a", b: "b" });
  assert.equal(PR.flowMeet(g, "a", "G1"), null);
  assert.equal(PR.flowMeet(g, "a", "a"), null);
});
