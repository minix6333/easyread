const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 間隔重複的排程（common/srs.js，FSRS-4.5）
function load() {
  const PR = { t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/srs.js"), "utf8"), { window: { PR }, Math, Date });
  return PR.srs;
}
const DAY = 86400000, T0 = Date.parse("2026-10-17T08:00:00Z");
const days = (s, now) => Math.round((Date.parse(s.due) - now) / DAY);

test("a new card: again comes back in a minute, hard/good/easy in about 1/4/14 days", () => {
  const srs = load();
  const again = srs.next(null, 1, T0);
  assert.equal(Date.parse(again.due) - T0, 60000);
  assert.equal(again.state, "learning");
  assert.deepEqual([2, 3, 4].map((g) => days(srs.next(null, g, T0), T0)), [1, 4, 14]);
  assert.deepEqual(Array.from(srs.preview(null, T0)), ["1 分鐘", "1 天", "4 天", "14 天"]);
});

test("remembering stretches the interval, forgetting shrinks it and counts a lapse", () => {
  const srs = load();
  const first = srs.next(null, 3, T0);                    // 4 天
  const t1 = Date.parse(first.due);
  const good = srs.next(first, 3, t1);
  assert.ok(days(good, t1) > 4, "good after 4 days: " + days(good, t1));
  const easy = srs.next(first, 4, t1), hard = srs.next(first, 2, t1);
  assert.ok(days(easy, t1) > days(good, t1) && days(hard, t1) < days(good, t1));
  const lapse = srs.next(good, 1, Date.parse(good.due));
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.state, "relearning");
  assert.ok(lapse.s < good.s);
  assert.equal(Date.parse(lapse.due) - Date.parse(good.due), 600000);
  assert.ok(lapse.d > good.d, "difficulty goes up after forgetting");
});

test("due checks and the friendly labels", () => {
  const srs = load();
  assert.equal(srs.isDue(null, T0), true);
  const c = srs.next(null, 3, T0);
  assert.equal(srs.isDue(c, T0), false);
  assert.equal(srs.isDue(c, Date.parse(c.due) + 1), true);
  assert.equal(srs.when(null, T0), "新卡");
  assert.equal(srs.when(c, T0), "4 天後");
  assert.equal(srs.when(c, Date.parse(c.due)), "到期");
  assert.equal(srs.span(23 * 3600000), "1 天");
  assert.equal(srs.span(5 * 3600000), "5 小時");
});

test("answering Good every time keeps difficulty where it started (FSRS-4.5 reverts to D0(3) = w4)", () => {
  const srs = load();
  let s = null, now = Date.UTC(2026, 0, 1);
  for (let k = 0; k < 40; k++) { s = srs.next(s, 3, now); now = Date.parse(s.due); }
  assert.ok(Math.abs(s.d - 5.1618) < 0.01, s.d);
});
