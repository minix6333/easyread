/* PDF 頁旁的邊註欄（pvmargin.js）：疊放、關聯、拖排順序；拖位置／拉大小的存檔不進復原記錄。  node --test tests/test_pvmargin.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const src = (rel) => fs.readFileSync(path.join(__dirname, "../easyread/web/js", rel), "utf8");

function load() {
  const reader = { notes: {} };
  const toasts = [];
  let clock = 0;
  const PR = {
    state: { reader, discussion: { entries: [] } }, t: (s) => s, toast: (m) => toasts.push(m), $: () => null, $$: () => [], el: () => ({}),
    debounce: (fn) => fn, on: () => {}, blockById: {}, prefs: {},
    myNotes: () => Object.values(reader.notes).filter((n) => !n.deleted), repliesTo: () => [],
    commit(op) { if (op.op === "note") reader.notes[op.note.id] = JSON.parse(JSON.stringify(op.note)); },
  };
  PR.saveNote = (note) => { note.updated = "t" + ++clock; PR.commit({ op: "note", note }); };
  vm.runInNewContext(src("reader/pvmargin.js"), { window: { PR }, document: { addEventListener() {}, body: { classList: { add() {}, remove() {} } } }, setTimeout });
  return { PR, reader, toasts };
}

test("cards stack below their anchors without overlapping; a dragged card keeps its spot", () => {
  const { PR } = load();
  const tops = PR.pvMarginStack([{ id: "a", y: 100, pin: null, h: 60 }, { id: "b", y: 110, pin: null, h: 40 }, { id: "c", y: 400, pin: null, h: 30 }, { id: "d", y: 50, pin: 300, h: 20 }], 8);
  assert.equal(tops.a, 100);
  assert.equal(tops.b, 168);      // 100 + 60 + 8：放不下就往下順延
  assert.equal(tops.d, 300);      // 手動拖到 300，錨點在 50 也不管
  assert.equal(tops.c, 400);
});

test("linking records both sides, unlinking removes both, self-links and missing notes are ignored", () => {
  const { PR, reader, toasts } = load();
  reader.notes.a = { id: "a", body: "甲" };
  reader.notes.b = { id: "b", body: "乙" };
  assert.ok(PR.linkNotes("a", "b"));
  assert.deepEqual([reader.notes.a.links, reader.notes.b.links], [["b"], ["a"]]);
  assert.ok(PR.linkNotes("a", "b"));  // 再連一次不會重複
  assert.deepEqual(reader.notes.a.links, ["b"]);
  assert.equal(PR.linkNotes("a", "a"), false);
  assert.equal(PR.linkNotes("a", "zzz"), false);
  PR.unlinkNotes("b", "a");
  assert.deepEqual([reader.notes.a.links, reader.notes.b.links], [[], []]);
  assert.ok(toasts.includes("已建立關聯") && toasts.includes("已取消關聯"));
});

test("reorder key lands between the neighbours on the same page", () => {
  const PR = { t: (s) => s, state: { reader: { notes: {} }, discussion: { entries: [] }, paper: { blocks: [] }, layout: {} }, store: {}, pid: "x", $: () => null, $$: () => [], ls: { get: () => null, set() {} }, api() {}, myNotes: () => [], el: () => ({}), debounce: (fn) => fn, order: {}, blockById: {} };
  const panel = { addEventListener() {}, querySelector: () => null, contains: () => false };
  PR.$ = () => panel;
  vm.runInNewContext(src("reader/notespanel.js"), { window: { PR }, document: { addEventListener() {} } });
  const items = [
    { src: "mine", page: 2, key: 0.1, data: { id: "a" } }, { src: "mine", page: 2, key: 0.3, data: { id: "b" } },
    { src: "mine", page: 2, key: 0.5, data: { id: "c" } }, { src: "mine", page: 3, key: 0.2, data: { id: "d" } },
  ];
  assert.equal(PR.reorderKey(items, "c", "a", false), 0.1 - 0.01);         // 排到第一張前面
  assert.equal(PR.reorderKey(items, "c", "a", true), (0.1 + 0.3) / 2);      // a 和 b 中間
  assert.equal(PR.reorderKey(items, "a", "c", true), 0.5 + 0.01);           // 這一頁最後（下一頁的 d 不算鄰居）
  assert.equal(PR.reorderKey(items, "a", "nope", true), null);
});

test("moving or resizing a card does not create an undo step", () => {
  const reader = { notes: {} };
  const PR = { state: { reader }, t: (s) => s, toast() {}, commit(op) {
    if (op.op === "note") reader.notes[op.note.id] = JSON.parse(JSON.stringify(op.note));
    else if (op.op === "note_del") reader.notes[op.id] = { ...(reader.notes[op.id] || { id: op.id }), deleted: true };
  } };
  let clock = 0;
  PR.saveNote = (note, opts) => { note.updated = "t" + ++clock; PR.commit(Object.assign({ op: "note", note }, opts && opts.ui ? { ui: true } : {})); };
  vm.runInNewContext(src("reader/undo.js"), { window: { PR }, document: { addEventListener() {} }, Date });
  PR.saveNote({ id: "n1", kind: "note", body: "字" });
  PR.saveNote({ id: "n1", kind: "note", body: "字", ui: { my: 0.4 } }, { ui: true });
  assert.equal(reader.notes.n1.ui.my, 0.4);
  PR.undo();  // 只退回「新增筆記」那一步：筆記整條消失，而不是只退回位置
  assert.equal(reader.notes.n1.deleted, true);
});
