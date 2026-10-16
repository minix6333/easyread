const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 術語表（reader/lexicon.js）：選到的字是不是表裡的某一條
test("a selection matches a term, its full form or its abbreviation, never a symbol", async () => {
  const items = [{ t: "supervised finetuning (SFT)", k: "term", def: "d1" }, { t: "projection sampling", k: "term", def: "d2" }, { t: "\\kappa_C", k: "symbol", def: "d3" }];
  const events = {};
  const PR = { t: (s) => s, esc: (s) => String(s), icon: () => "", pid: "p", store: { mode: "server" }, state: { paper: {} }, ls: { get: (k, d) => d, set() {} },
    api: () => Promise.resolve({ items }), on: (n, fn) => { events[n] = fn; }, $$: () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/lexicon.js"), "utf8"), { window: { PR }, document: { addEventListener() {} } });
  events.rendered();
  await new Promise((r) => setImmediate(r));
  assert.equal(PR.lexMatch("SFT").t, "supervised finetuning (SFT)");
  assert.equal(PR.lexMatch(" Supervised  Finetuning ").t, "supervised finetuning (SFT)");
  assert.equal(PR.lexMatch("projection sampling,").t, "projection sampling");
  assert.equal(PR.lexMatch("sampling"), null);
  assert.equal(PR.lexMatch("\\kappa_C"), null);
});
