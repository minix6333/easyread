/* 筆記的語法（圖片、標題字級、待辦）和復原／重做。  node --test tests/test_notes.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const src = (rel) => fs.readFileSync(path.join(__dirname, "../easyread/web/js", rel), "utf8");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function markup() {
  const PR = { t: (s) => s, esc, imageUrl: (rel) => "/p/x/" + rel };
  vm.runInNewContext(src("common/markup.js"), { window: { PR }, katex: require("../easyread/web/vendor/katex/katex.min.js") });
  return PR;
}

test("pasted images render only from this document's clips folder", () => {
  const PR = markup();
  const html = PR.mdBlocks("看這張\n\n![](clips/u-0a1b.png)\n\n![40%](clips/c-p3-ff.png)\n\n![x](https://example.com/a.png)\n\n![y](clips/../paper.json)");
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.ok(html.includes('src="/p/x/clips/u-0a1b.png"'));
  assert.ok(html.includes('style="width:40%"'));
  assert.ok(!html.includes('src="https://example.com'));
  assert.ok(!html.includes("paper.json\""));
  assert.equal(PR.plain("重點 ![](clips/u-1.png) **粗**"), "重點  粗");
});

test("headings carry their size, to-dos their state, and inline styles still work", () => {
  const PR = markup();
  const html = PR.mdBlocks("# 特大\n\n## 大\n\n### 一般\n\n- [ ] 要查\n- [x] 查完\n- 普通\n\n~~不要~~ [連結](https://a.b/c) $x^2$");
  assert.deepEqual(html.match(/class="md-h" data-l="\d"/g), ['class="md-h" data-l="1"', 'class="md-h" data-l="2"', 'class="md-h" data-l="3"']);
  assert.ok(html.includes('<li class="todo"><i></i>要查</li>'));
  assert.ok(html.includes('<li class="todo done"><i></i>查完</li>'));
  assert.ok(html.includes("<li>普通</li>"));
  assert.ok(html.includes("<del>不要</del>"));
  assert.ok(html.includes('<a href="https://a.b/c" target="_blank" rel="noopener">連結</a>'));
  assert.ok(html.includes('class="katex"'));
});

function undoable() {
  const reader = { notes: {}, page_notes: {}, paper_note: {} };
  const toasts = [], keys = [];
  let clock = 0;
  const PR = {
    state: { reader }, t: (s) => s, toast: (m) => toasts.push(m),
    commit(op) {  // 和 store.js 同一套規則的精簡版
      if (op.op === "note") reader.notes[op.note.id] = JSON.parse(JSON.stringify(op.note));
      else if (op.op === "note_del") reader.notes[op.id] = { ...(reader.notes[op.id] || { id: op.id }), deleted: true };
      else if (op.op === "page_note") reader.page_notes[op.page] = Object.assign({ body: op.body || "" }, op.star ? { star: true } : {});
      else if (op.op === "paper_note") reader.paper_note = { body: op.body || "" };
    },
  };
  PR.saveNote = (note) => { note.updated = "t" + ++clock; PR.commit({ op: "note", note }); };
  vm.runInNewContext(src("reader/undo.js"), { window: { PR }, document: { addEventListener: (n, fn) => keys.push(fn) }, Date });
  // press(鍵, shift, 游標在不在輸入框裡)：回傳這次按鍵有沒有被攔下來
  const press = (key, shiftKey, inField) => {
    let taken = false;
    keys.forEach((fn) => fn({ key, metaKey: true, shiftKey: !!shiftKey, target: { closest: () => (inField ? {} : null) }, preventDefault() { taken = true; } }));
    return taken;
  };
  return { PR, reader, toasts, press };
}
const alive = (reader) => Object.values(reader.notes).filter((n) => !n.deleted);

test("undo walks back through create, edit, recolor and delete; redo replays them", () => {
  const { PR, reader } = undoable();
  PR.saveNote({ id: "n1", kind: "note", body: "第", color: "yellow" });
  PR.saveNote({ id: "n1", kind: "note", body: "第一版", color: "yellow" });        // 打字的自動存檔：和新增併成一步
  PR.saveNote({ id: "n1", kind: "note", body: "第一版", color: "green" });         // 換顏色：另一步
  PR.commit({ op: "note_del", id: "n1" });                                          // 刪掉：再一步
  assert.equal(alive(reader).length, 0);
  PR.undo();
  assert.equal(alive(reader)[0].color, "green");
  PR.undo();
  assert.equal(alive(reader)[0].color, "yellow");
  assert.equal(alive(reader)[0].body, "第一版");
  PR.undo();
  assert.equal(alive(reader).length, 0);                                            // 連同打的字一起退回「還沒有這條筆記」
  PR.redo();
  assert.equal(alive(reader)[0].body, "第一版");
  PR.redo(); PR.redo();
  assert.equal(alive(reader).length, 0);
});

test("page notes undo as one step per burst of typing, and a new action clears redo", () => {
  const { PR, reader, toasts } = undoable();
  PR.commit({ op: "page_note", page: 2, body: "a" });
  PR.commit({ op: "page_note", page: 2, body: "ab" });
  PR.commit({ op: "page_note", page: 2, body: "ab", star: true });                 // 標重點：另一步
  PR.undo();
  assert.deepEqual(reader.page_notes[2], { body: "ab" });
  PR.undo();
  assert.deepEqual(reader.page_notes[2], { body: "" });
  PR.commit({ op: "page_note", page: 5, body: "新的" });
  PR.redo();
  assert.equal(toasts.at(-1), "沒有可以重做的");
  assert.deepEqual(reader.page_notes[2], { body: "" });
});

test("the shortcut undoes annotations but leaves typing in a text field to the browser", () => {
  const { PR, reader, press } = undoable();
  PR.saveNote({ id: "n1", kind: "highlight", body: "" });
  assert.equal(press("z", false, true), false);   // 游標在輸入框裡：不攔，筆記還在
  assert.equal(alive(reader).length, 1);
  assert.equal(press("z"), true);
  assert.equal(alive(reader).length, 0);
  assert.equal(press("z", true), true);           // ⌘⇧Z 重做
  assert.equal(alive(reader).length, 1);
});
