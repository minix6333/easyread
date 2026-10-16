const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const answer = "## 结果\n误差为 2%。器件计算 $y=Wx$。\n\n## 局限\n测试采用室温和固定权重。";
const source = name => fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/" + name + ".js"), "utf8");
const settled = () => new Promise(resolve => setImmediate(resolve));

async function reader(threads = [], options = {}) {
  const listeners = new Map(), events = new Map(), nodes = new Map(), requests = [], copied = [], confirmations = [];
  let finish;
  const panel = { addEventListener() {}, classList: { add() {}, remove() {} } };
  Object.defineProperty(panel, "innerHTML", {
    get() { return this.html || ""; },
    set(html) {
      this.html = html;
      const ta = { value: (html.match(/<textarea[^>]*>(.*?)<\/textarea>/s) || [])[1] || "", focus() {} };
      nodes.set("#chatInput", ta);
      nodes.set("#chatList", { scrollHeight: 100, scrollTop: 0, clientHeight: 100 });
      // “简明回答”开关：亮着就是 ste100
      nodes.set("#chatAnswerStyle", {
        value: /class="ch-pill on"/.test(html) ? "ste100" : "standard",
        disabled: /data-c="style" disabled/.test(html),
      });
    },
  });
  nodes.set("#chatpanel", panel);
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    state: {}, store: { mode: "server" }, pid: "test", token: "test-token", side: null,
    $: selector => nodes.get(selector) || null,
    on(name, fn) { events.set(name, fn); }, openSide(side) { this.side = side; }, readingBlock: () => null, blockById: {}, myNotes: () => [],
    api: async () => ({ threads: structuredClone(threads), models: [{ id: "m", label: "Model" }, { id: "m2", label: "Other model" }], default: "m" }),
    confirm: async opts => { confirmations.push(opts); return true; },
    nowIso: () => "2026-01-01T00:00:00Z", shortTime: () => "today", autosize() {},
    esc: text => String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), icon: () => "", hasIcon: () => true, logo: () => "", md: text => text, mdBlocks: text => text,
    throttle: fn => fn, debounce: fn => fn, usageChip: () => "", usagePop: () => "", toast() {},
    // 上網查資料的開關（util.js）、來源清單（markup.js）、狀態的字：照真的那幾個的樣子
    webState: true,
    web: { on() { return PR.webState; }, set(v) { PR.webState = !!v; }, ok: m => !m || m.web !== false, body(m) { return { web: PR.webState && (!m || m.web !== false) }; } },
    sourcesHtml: list => (list || []).map(x => '<a class="src" href="' + x.url + '">' + x.domain + "</a>").join(""), webStatusText: s => (s && s.kind === "search" ? "搜尋「" + s.query + "」" : ""),
  };
  if (options.markup) vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/markup.js"), "utf8"), {
    window: { PR }, katex: require("../easyread/web/vendor/katex/katex.min.js"),
  });
  vm.runInNewContext(source("chat-effort"), { window: { PR } });
  vm.runInNewContext(source("chat"), {
    window: { PR, addEventListener() {} },
    document: { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    setTimeout() {}, AbortController, TextDecoder,
    fetch: async (url, opts) => {
      requests.push(JSON.parse(opts.body));
      if (options.failFirst && requests.length === 1) return new Response(JSON.stringify({ error: "连接失败" }), { status: 400 });
      return new Response(new ReadableStream({
        start(ctrl) {
          opts.signal.addEventListener("abort", () => ctrl.error(Object.assign(new Error("Stopped"), { name: "AbortError" })));
          finish = () => {
            const events = [{ thread: "new", model: "Model", answer_style: requests.at(-1).answer_style },
              { t: answer }, { done: true, id: "answer" }];
            ctrl.enqueue(new TextEncoder().encode(events.map(e => JSON.stringify(e) + "\n").join("")));
            ctrl.close();
          };
        },
      }));
    },
  });
  const dispatch = async (name, target) => { for (const fn of listeners.get(name) || []) await fn({ target }); };
  const action = (name, card, row) => ({ dataset: { c: name, m: name === "model" ? "m2" : undefined }, closest: selector => {
    if (selector === "#chatpanel") return panel;
    if (selector === "[data-c]") return actionTarget;
    if (selector === ".cm.ai") return card;
    if (selector === ".ch-thread[data-t]") return row;
    return null;
  } });
  let actionTarget;
  const click = (name, card, row) => { actionTarget = action(name, card, row); return dispatch("click", actionTarget); };
  const selectThread = id => {
    const row = { dataset: { t: id } };
    return dispatch("click", { closest: selector => selector.includes(".ch-thread[data-t]") ? row : selector === "#chatpanel" ? panel : null });
  };
  PR.toggleChat(true);
  await settled();
  const setStyle = async value => { if (nodes.get("#chatAnswerStyle").value !== value) await click("style"); };
  return { PR, panel, nodes, requests, copied, confirmations, dispatch, click, selectThread, setStyle,
    emit: async name => { await events.get(name)(); await settled(); }, finish: () => finish() };
}

test("STE selection reaches the request, stays fixed during streaming, and copies the complete Chinese answer", async () => {
  const r = await reader();
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  r.nodes.get("#chatInput").value = "总结论文";
  await r.setStyle("ste100");
  assert.equal(r.nodes.get("#chatInput").value, "总结论文");
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[0].answer_style, "ste100");
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, true);
  await r.setStyle("standard");
  r.finish();
  await sending;
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, false);
  assert.ok(r.panel.innerHTML.includes('class="cm-style" title="简明回答"'));
  assert.ok(r.panel.innerHTML.includes('class="ch-pill on"'));
  assert.ok(!r.panel.innerHTML.includes("英文在前"));
  assert.ok(r.panel.innerHTML.includes(answer));
  await r.click("copy", { dataset: { id: "answer" } });
  assert.deepEqual(r.copied, [answer]);
});

test("each saved conversation restores its mode; legacy and new conversations start in normal mode", async () => {
  const r = await reader([
    { id: "ste", title: "STE", answer_style: "ste100", messages: [{ id: "a", role: "assistant", content: answer, answer_style: "ste100" }] },
    { id: "old", title: "Old", messages: [{ id: "b", role: "assistant", content: "旧回答" }] },
  ]);
  await r.selectThread("ste");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.ok(r.panel.innerHTML.includes("cm-style"));
  await r.selectThread("old");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  assert.ok(!r.panel.innerHTML.includes("cm-style"));
  await r.selectThread("ste");
  await r.click("new");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
});

test("saved formulas render in answers, questions and thread titles without rewriting copy content", async () => {
  const content = String.raw`积分：\[\frac{1}{L}\int_0^L e^{-(a+j\beta)z}\,dz\]`;
  const r = await reader([{ id: "formula", title: String.raw`$\alpha$ 的解释 <img src=x>`, answer_style: "ste100", messages: [
    { id: "q", role: "user", content: String.raw`解释 \(\alpha\)。` },
    { id: "a", role: "assistant", content, answer_style: "ste100" },
  ] }], { markup: true });
  await r.selectThread("formula");
  assert.equal((r.panel.innerHTML.match(/class="katex"/g) || []).length, 3);
  assert.ok(r.panel.innerHTML.includes('class="katex-display"'));
  assert.ok(r.panel.innerHTML.includes("&lt;img src=x&gt;"));
  assert.ok(!r.panel.innerHTML.includes("<img"));
  await r.click("list");
  assert.equal((r.panel.innerHTML.match(/class="katex"/g) || []).length, 4);
  await r.click("copy", { dataset: { id: "a" } });
  assert.deepEqual(r.copied, [content]);
});

test("switching conversation during a streamed answer cannot change the visible mode", async () => {
  const r = await reader([{ id: "old", title: "Old", messages: [] }]);
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "question";
  const sending = r.click("send");
  await settled();
  await r.selectThread("old");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  r.finish();
  await sending;
  assert.ok(r.panel.innerHTML.includes(answer));
});

test("saving model settings keeps the chosen mode and unsent draft", async () => {
  const r = await reader([{ id: "old", title: "Old", answer_style: "standard", messages: [] }]);
  await r.selectThread("old");
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "还没发送的问题";
  await r.emit("settings-saved");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.equal(r.nodes.get("#chatInput").value, "还没发送的问题");
});

test("saving settings during an answer cannot discard the active conversation", async () => {
  const r = await reader();
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "正在回答的问题";
  const sending = r.click("send");
  await settled();
  await r.emit("settings-saved");
  assert.ok(r.panel.innerHTML.includes("正在回答的问题"));
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, true);
  r.finish();
  await sending;
  assert.ok(r.panel.innerHTML.includes(answer));
});

test("the selected model and mode return together when switching back to a conversation", async () => {
  const r = await reader([
    { id: "first", title: "First", model: "m", messages: [] },
    { id: "second", title: "Second", model: "m", messages: [] },
  ]);
  await r.selectThread("first");
  await r.setStyle("ste100");
  await r.click("model");
  r.nodes.get("#chatInput").value = "用另一模型回答";
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[0].model, "m2");
  r.finish();
  await sending;
  await r.selectThread("second");
  await r.selectThread("first");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.ok(r.panel.innerHTML.includes('title="换模型和思考强度">Other model'));
});

test("a streamed conversation cannot be deleted; stopping enables a new normal conversation", async () => {
  const r = await reader([{ id: "old", title: "Old", messages: [] }]);
  await r.selectThread("old");
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "正在回答的问题";
  const sending = r.click("send");
  await settled();
  await r.click("del", null, { dataset: { t: "old" } });
  assert.equal(r.confirmations.length, 0);
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  await r.click("stop");
  await sending;
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, false);
  assert.ok(r.panel.innerHTML.includes("已停止"));
  await r.click("new");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
});

test("a failed first question can be left for a new conversation and retried without leaking a local ID", async () => {
  const r = await reader([], { failFirst: true });
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "失败的问题";
  await r.click("send");
  assert.ok(r.panel.innerHTML.includes("连接失败"));
  await r.click("list");
  const localId = r.panel.innerHTML.match(/data-t="([^"]*)"/)[1];
  await r.click("new");
  assert.ok(!r.panel.innerHTML.includes("失败的问题"));
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  await r.selectThread(localId);
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  r.nodes.get("#chatInput").value = "重试问题";
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[1].thread, null);
  r.finish();
  await sending;
  assert.ok(r.panel.innerHTML.includes(answer));
});

test("Markdown export includes all conversations and complete answers, online and offline", async () => {
  const chat = { threads: [
    { messages: [{ role: "user", content: "first" }, { role: "assistant", content: answer, model: "Model" }] },
    { messages: [{ role: "user", content: "second" }, { role: "assistant", content: "normal answer", model: "Model" }] },
  ] };
  for (const mode of ["server", "static"]) {
    let go, blob, downloaded = false;
    const dlg = { addEventListener(name, fn) { go = fn; }, classList: { remove() {} } };
    const panel = { addEventListener() {} };
    const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
      state: { paper: { meta: { title_en: "Test paper" }, blocks: [] }, reader: {}, discussion: {}, chat }, store: { mode }, pid: "test",
      $: selector => selector === "#readerDlg" ? dlg : panel,
      $$: () => [{ dataset: { exp: "chat" }, checked: true }], ls: { get: (k, fallback) => fallback, set() {} },
      api: async () => chat, myNotes: () => [], el: () => ({ click() { downloaded = true; }, remove() {} }),
      debounce: fn => fn,
    };
    const context = {
      window: { PR }, document: { addEventListener() {}, body: { appendChild() {} } },
      Blob, URL: { createObjectURL(value) { blob = value; return "blob:test"; } },
    };
    vm.runInNewContext(source("notespanel"), context);
    vm.runInNewContext(source("export"), context);
    await go({ target: { closest: selector => selector === "[data-exp-go]" } });
    const text = await blob.text();
    assert.ok(downloaded);
    assert.ok(text.includes(answer));
    assert.ok(text.includes("first"));
    assert.ok(text.includes("second"));
    assert.ok(text.includes("normal answer"));
  }
});

test("a failed chat export keeps the dialog open, creates no file, and treats the error as text", async () => {
  let go, closed = false, downloaded = false;
  const notices = [];
  const dlg = { addEventListener(name, fn) { go = fn; }, classList: { remove() { closed = true; } } };
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    state: { chat: {} }, store: { mode: "server" }, pid: "test",
    $: () => dlg, $$: () => [{ dataset: { exp: "chat" }, checked: true }], ls: { set() {} },
    api: async () => { throw new Error('<img src=x onerror="alert(1)">'); },
    esc: text => String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    toast: text => notices.push(text), notesMarkdown() { downloaded = true; },
  };
  vm.runInNewContext(source("export"), { window: { PR } });
  await go({ target: { closest: selector => selector === "[data-exp-go]" } });
  assert.equal(closed, false);
  assert.equal(downloaded, false);
  assert.ok(notices[0].includes('&lt;img'));
  assert.ok(!notices[0].includes('<img'));
});

test("thinking effort lives in the model menu and shows on the model button once chosen", async () => {
  const r = await reader([], {});
  r.PR.state.models = null;
  await r.click("menu");
  assert.ok(r.panel.innerHTML.includes('class="ch-effort-sec"'));
  assert.ok(!r.panel.innerHTML.includes("ch-effort-pop"));
  assert.ok(!r.panel.innerHTML.includes("ch-model-effort"));
  const b = { dataset: { c: "effort-level", effort: "high" }, closest: (sel) => sel === "[data-c]" ? b : sel === "#chatpanel" ? r.panel : null };
  await r.dispatch("click", b);
  assert.ok(r.panel.innerHTML.includes('class="ch-effort-sec"'), "menu stays open");
  assert.match(r.panel.innerHTML, /ch-model-effort"> · 高/);
  r.nodes.get("#chatInput").value = "问题";
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[0].chat_options.reasoning_effort, "high");
  r.finish(); await sending;
});

test("a Codex model that has a Fast tier gets a speed switch in the model menu; it edits the model card", async () => {
  const E = (() => { const PR = { t: (x, v) => v ? x.replace(/\{(\w+)\}/g, (m, k) => v[k]) : x, esc: (x) => String(x) }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/chat-effort.js"), "utf8"), { window: { PR } }); return PR.chatEffort; })();
  const st = { catalog: { codex: { default: "sol", configured_tier: "", models: [{ id: "sol", fast: 2 }, { id: "old", fast: 0 }] } }, chatOptions: {} };
  const sol = { id: "a", engine: "codex", model: "sol", service_tier: "" };
  assert.equal(E.fastSpeed(st, sol), 2);
  assert.equal(E.fastSpeed(st, { engine: "codex", model: "old" }), 0);
  assert.equal(E.fastSpeed(st, { engine: "claude", model: "opus" }), 0);
  assert.equal(E.speedSection(st, { engine: "codex", model: "old" }), "", "no Fast tier: no section");
  let html = E.speedSection(st, sol);
  assert.match(html, /約 2 倍速/);
  assert.match(html, /data-fast="0" role="radio" aria-checked="true"/);
  assert.ok(!E.suffix(st, sol).includes("Fast"));
  assert.equal(E.tierFor(st, sol, true), "fast");
  assert.equal(E.tierFor(st, sol, false), "", "standard: follow Codex when Codex itself is standard");
  sol.service_tier = "fast";
  html = E.speedSection(st, sol);
  assert.match(html, /data-fast="1" role="radio" aria-checked="true"/);
  assert.match(E.suffix(st, sol), /· Fast/);
  st.catalog.codex.configured_tier = "fast";  // Codex 自己的設定就是 fast：卡片沒設也是 Fast，選標準要明講 default
  sol.service_tier = "";
  assert.ok(E.isFast(st, sol));
  assert.equal(E.tierFor(st, sol, false), "default");
});


test("the globe switch sends web with each question, turns off with one click, and saved answers list their sources", async () => {
  const r = await reader([{ id: "w", title: "W", messages: [{ id: "a", role: "assistant", content: "3.14 是 2025 年發佈的。", sources: [{ url: "https://python.org/x", title: "Python 3.14.0", domain: "python.org" }] }] }]);
  assert.match(r.panel.innerHTML, /class="ch-web on" data-c="web"/, "on by default");
  r.nodes.get("#chatInput").value = "Python 3.14 哪天發佈";
  const first = r.click("send");
  await settled();
  assert.equal(r.requests[0].web, true);
  r.finish();
  await first;
  await r.click("web");
  assert.match(r.panel.innerHTML, /class="ch-web" data-c="web"/, "one click turns it off");
  r.nodes.get("#chatInput").value = "不用查";
  const second = r.click("send");
  await settled();
  assert.equal(r.requests[1].web, false);
  r.finish();
  await second;
  await r.selectThread("w");
  assert.ok(r.panel.innerHTML.includes('href="https://python.org/x"'), "a saved answer shows where it looked");
});
