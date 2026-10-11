/* 區塊式筆記編輯器（像 Craft）：一段一個區塊，滑過去左邊有把手，可以拖著換順序；打「/」叫出區塊選單；
   Enter 新區塊、Backspace 併回上一塊、方向鍵在區塊間走；Tab 縮排清單；⌘B／⌘I／⌘E／⌘K 加標記。
   儲存的還是 Markdown（和以前的筆記、雲端同步、AI 的提示詞都相容）：每個區塊就是 Markdown 的一段，
   平常顯示排好的樣子（PR.md／PR.mdBlocks），點進去那一塊才變成輸入框、寫的是這一塊的 Markdown。
   區塊種類：內文、標題（三級）、清單（圓點／編號／待辦）、引用、說明框（> [!note|tip|warn|toggle] 標題）、
   出處卡（> [!ref 筆記id] 原話——指回文件裡某一條筆記，見 host.refs）、程式碼、公式、分隔線、圖片、表格、流程圖和示意圖（當程式碼編）。
   用法：const ed = PR.blockEditor(容器, { value, onChange(md), placeholder, compact, upload(file)→src, refs:{get(id), go(id)}, ai(sel) })
   ed.getValue() / setValue(md) / focus(at) / insert(md) / selection() / preview(from, to, md) / acceptPreview() / rejectPreview() / destroy()
   純函式（tests/test_blocks.cjs）：PR.blocksParse(md) → [{type,…}]、PR.blocksSerialize(blocks) → md。 */
(function (PR) {
  "use strict";
  const t = (s, v) => (PR.t ? PR.t(s, v) : s);
  const esc = (s) => (PR.esc ? PR.esc(s) : String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]));
  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;  // i18n-ok regex
  const HEADING = /^(#{1,6})\s+(.*)$/;
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
  const QUOTE = /^>\s?(.*)$/;
  const CALLOUT = /^\[!(\w+)(?:\s+([^\]]*))?\]\s*(.*)$/;
  const DIVIDER = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const IMAGE = /^!\[[^\]]*\]\([^)]+\)\s*$/;
  const TABLE = /^\s*\|.*\|\s*$/;
  const MATH = /^\s*\$\$\s*$/;
  const CALLOUT_KINDS = ["note", "tip", "warn", "toggle", "ref", "ai"];
  let seq = 0;
  const bid = () => "k" + (++seq).toString(36) + Date.now().toString(36).slice(-3);

  /* ---------- Markdown ⇄ 區塊（純函式） ---------- */
  function parse(md) {
    const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const push = (b) => { b.id = bid(); out.push(b); };
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = FENCE.exec(line))) {
        const fence = m[1][0], lang = m[2].toLowerCase(), body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence.repeat(3)) && lines[i].trim().replace(/[`~]/g, "") === "")) body.push(lines[i++]);
        i++;  // 收尾的圍欄（沒有也算結束）
        push({ type: "code", lang, text: body.join("\n") });
        continue;
      }
      if (MATH.test(line)) {
        const body = [];
        i++;
        while (i < lines.length && !MATH.test(lines[i])) body.push(lines[i++]);
        i++;
        push({ type: "math", text: body.join("\n") });
        continue;
      }
      if (DIVIDER.test(line)) { push({ type: "divider", text: "" }); i++; continue; }
      if ((m = HEADING.exec(line))) { push({ type: "heading", level: Math.min(3, m[1].length), text: m[2].trim() }); i++; continue; }
      if (IMAGE.test(line)) { push({ type: "image", text: line.trim() }); i++; continue; }
      if ((m = LIST.exec(line))) {
        const kind = m[3] != null ? "todo" : /\d/.test(m[2]) ? "number" : "bullet";
        const b = { type: "list", kind, indent: Math.min(4, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), text: m[4] };
        if (kind === "todo") b.checked = /x/i.test(m[3]);
        i++;
        // 同一項接著的縮排行（續行）併進來
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i]) && !FENCE.test(lines[i])) b.text += "\n" + lines[i++].trim();
        push(b);
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
        const c = CALLOUT.exec(body[0] || "");
        if (c && CALLOUT_KINDS.includes(c[1].toLowerCase())) {
          const kind = c[1].toLowerCase();
          push({ type: "callout", kind, args: (c[2] || "").trim(), text: [c[3]].concat(body.slice(1)).join("\n").replace(/\s+$/, "") });
        } else push({ type: "quote", text: body.join("\n") });
        continue;
      }
      if (TABLE.test(line)) {
        const body = [];
        while (i < lines.length && TABLE.test(lines[i])) body.push(lines[i++]);
        push({ type: "table", text: body.join("\n") });
        continue;
      }
      // 內文：收到空行、或下一行是別種區塊為止
      const body = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !LIST.test(lines[i]) && !QUOTE.test(lines[i]) && !DIVIDER.test(lines[i]) && !MATH.test(lines[i]) && !TABLE.test(lines[i]) && !IMAGE.test(lines[i])) body.push(lines[i++]);
      push({ type: "p", text: body.join("\n") });
    }
    return out;
  }
  function one(b) {
    switch (b.type) {
      case "heading": return "#".repeat(b.level || 1) + " " + (b.text || "").replace(/\n+/g, " ");
      case "list": {
        const pad = "  ".repeat(b.indent || 0);
        const mark = b.kind === "number" ? "1." : "-";
        const box = b.kind === "todo" ? (b.checked ? "[x] " : "[ ] ") : "";
        return pad + mark + " " + box + (b.text || "").split("\n").join("\n" + pad + "  ");
      }
      case "quote": return (b.text || "").split("\n").map((l) => "> " + l).join("\n");
      case "callout": {
        const lines = (b.text || "").split("\n");
        return ["> [!" + b.kind + (b.args ? " " + b.args : "") + "] " + lines[0]].concat(lines.slice(1).map((l) => "> " + l)).join("\n");
      }
      case "code": return "```" + (b.lang || "") + "\n" + (b.text || "") + "\n```";
      case "math": return "$$\n" + (b.text || "") + "\n$$";
      case "divider": return "---";
      default: return b.text || "";
    }
  }
  function serialize(blocks) {
    let out = "";
    blocks.forEach((b, i) => {
      if (i) out += b.type === "list" && blocks[i - 1].type === "list" ? "\n" : "\n\n";  // 連著的清單項不空行，別的 Markdown 工具才當成一份清單
      out += one(b);
    });
    return out;
  }
  PR.blocksParse = parse;
  PR.blocksSerialize = serialize;
  PR.blocksOne = one;

  /* ---------- 區塊選單（「/」叫出來） ---------- */
  const MENU = () => [
    { k: "p", icon: "type", label: t("內文"), hint: t("一般的段落"), kw: "text p" },
    { k: "h1", icon: "bigger", label: t("標題"), hint: t("最大的標題"), kw: "h1 heading title" },
    { k: "h2", icon: "bigger", label: t("副標題"), hint: t("第二級"), kw: "h2" },
    { k: "h3", icon: "bigger", label: t("小標題"), hint: t("第三級"), kw: "h3" },
    { k: "bullet", icon: "log", label: t("清單"), hint: t("圓點清單"), kw: "list bullet ul" },
    { k: "number", icon: "list", label: t("編號清單"), hint: t("1. 2. 3."), kw: "number ol" },
    { k: "todo", icon: "check", label: t("待辦"), hint: t("可以打勾"), kw: "todo task" },
    { k: "toggle", icon: "chevron", label: t("收合"), hint: t("點標題展開內容"), kw: "toggle fold" },
    { k: "quote", icon: "quote", label: t("引用"), hint: t("引別人的話"), kw: "quote" },
    { k: "note", icon: "info", label: t("說明框"), hint: t("重點、提醒"), kw: "callout note tip" },
    { k: "warn", icon: "alert", label: t("警示框"), hint: t("要小心的地方"), kw: "warn" },
    { k: "code", icon: "template", label: t("程式碼"), hint: t("等寬字"), kw: "code" },
    { k: "math", icon: "sigma", label: t("公式"), hint: t("獨立一行的 TeX"), kw: "math tex" },
    { k: "divider", icon: "more", label: t("分隔線"), hint: "", kw: "divider hr" },
    { k: "image", icon: "image", label: t("圖片"), hint: t("選檔或貼上"), kw: "image" },
    { k: "table", icon: "panel", label: t("表格"), hint: t("三欄的表"), kw: "table" },
    { k: "flow", icon: "region", label: t("流程圖"), hint: t("Mermaid flowchart"), kw: "flow mermaid" },
    { k: "ai", icon: "sparkle", label: t("AI 寫"), hint: t("描述要寫什麼"), kw: "ai" },
  ];

  /* ---------- 編輯器 ---------- */
  PR.blockEditor = function (host, opts) {
    opts = opts || {};
    const root = typeof host === "string" ? document.querySelector(host) : host;
    const state = { blocks: parse(opts.value || ""), editing: null, selected: new Set(), preview: null, menu: null, drag: null, history: [], future: [], compact: !!opts.compact };
    const listeners = {};
    if (!state.blocks.length) state.blocks = [{ id: bid(), type: "p", text: "" }];  // 空的也要有一塊可以點進去
    root.classList.add("bk");
    if (state.compact) root.classList.add("compact");
    root.innerHTML = '<div class="bk-list"></div>';
    const list = root.firstElementChild;
    const changeSoon = debounce(() => emit("change", getValue()), 400);
    function emit(ev, data) { (listeners[ev] || []).forEach((fn) => fn(data)); if (ev === "change" && opts.onChange) opts.onChange(data); }
    function debounce(fn, ms) { let h; return Object.assign((...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }, { flush: () => { clearTimeout(h); fn(); } }); }
    const getValue = () => serialize(state.blocks);
    const idx = (id) => state.blocks.findIndex((b) => b.id === id);
    const blockEl = (id) => list.querySelector('.bk-b[data-id="' + id + '"]');

    /* ---------- 畫 ---------- */
    function numberOf(i) {
      let n = 1;
      for (let k = i - 1; k >= 0 && state.blocks[k].type === "list" && state.blocks[k].kind === "number" && (state.blocks[k].indent || 0) >= (state.blocks[i].indent || 0); k--) if ((state.blocks[k].indent || 0) === (state.blocks[i].indent || 0)) n++;
      return n;
    }
    const inline = (s) => PR.md ? PR.md(s, { cite: false, xref: false }) : esc(s);
    const blocksHtml = (s) => PR.mdBlocks ? PR.mdBlocks(s) : "<p>" + esc(s) + "</p>";
    function viewHtml(b, i) {
      const text = b.text || "";
      switch (b.type) {
        case "heading": return '<div class="bk-t bk-h' + b.level + '">' + (text ? inline(text) : '<span class="bk-ph">' + t("標題") + "</span>") + "</div>";
        case "list": {
          const mark = b.kind === "number" ? '<span class="bk-mark n">' + numberOf(i) + ".</span>" : b.kind === "todo" ? '<button class="bk-mark todo' + (b.checked ? " on" : "") + '" data-bk="toggle-todo" aria-label="' + t("待辦") + '"></button>' : '<span class="bk-mark b"></span>';
          return mark + '<div class="bk-t' + (b.checked ? " done" : "") + '">' + (text ? inline(text) : '<span class="bk-ph">' + t("清單項目") + "</span>") + "</div>";
        }
        case "quote": return '<div class="bk-t bk-quote">' + blocksHtml(text) + "</div>";
        case "callout": {
          const lines = text.split("\n"), title = lines[0], body = lines.slice(1).join("\n");
          if (b.kind === "ref") return refHtml(b, title, body);
          const open = b.kind !== "toggle" || b.open;
          return '<div class="bk-callout k-' + b.kind + (open ? " open" : "") + '"><div class="bk-ch">' + (b.kind === "toggle" ? '<button class="bk-chev" data-bk="toggle-open" aria-label="' + t("展開") + '">' + (PR.icon ? PR.icon("chevron", "sm") : "›") + "</button>" : '<span class="bk-ci">' + (PR.icon ? PR.icon(b.kind === "warn" ? "alert" : b.kind === "ai" ? "sparkle" : "info", "sm") : "") + "</span>") +
            '<div class="bk-ct">' + (title ? inline(title) : '<span class="bk-ph">' + t("標題") + "</span>") + "</div></div>" + (body && open ? '<div class="bk-cb">' + blocksHtml(body) + "</div>" : "") + "</div>";
        }
        case "code": {
          if (/^(flow|flowchart|mermaid|graph|viz)$/.test(b.lang || "")) return '<div class="bk-fig">' + blocksHtml(one(b)) + "</div>";
          return '<div class="bk-code"><span class="bk-lang">' + esc(b.lang || "") + "</span><pre><code>" + esc(text) + "</code></pre></div>";
        }
        case "math": return '<div class="bk-math">' + (text.trim() ? blocksHtml("$$\n" + text + "\n$$") : '<span class="bk-ph">' + t("公式") + "</span>") + "</div>";
        case "divider": return '<hr class="bk-hr">';
        case "image": case "table": return '<div class="bk-t">' + blocksHtml(text) + "</div>";
        default: return '<div class="bk-t">' + (text ? inline(text) : '<span class="bk-ph">' + (i === 0 && state.blocks.length === 1 ? esc(opts.placeholder || t("寫點什麼，或按「/」選區塊…")) : "") + "</span>") + "</div>";
      }
    }
    /* 出處卡：指回文件裡的一條筆記（host.refs.get 給內容），收起時只有一行，點標題展開；右邊有跳過去的按鈕 */
    function refHtml(b, title, body) {
      const ref = opts.refs && opts.refs.get ? opts.refs.get(b.args.split(/\s+/)[0]) : null;
      const page = ref && ref.page ? '<span class="bk-page">p.' + ref.page + "</span>" : (b.args.match(/\bp(\d+)\b/) ? '<span class="bk-page">p.' + b.args.match(/\bp(\d+)\b/)[1] + "</span>" : "");
      const live = ref ? (ref.body || "") : body;
      return '<div class="bk-callout k-ref' + (b.open ? " open" : "") + (ref ? "" : " lost") + '"><div class="bk-ch"><button class="bk-chev" data-bk="toggle-open" aria-label="' + t("展開") + '">' + (PR.icon ? PR.icon("chevron", "sm") : "›") + "</button>" +
        '<div class="bk-ct">' + (title ? inline(title) : (ref && ref.title ? inline(ref.title) : '<span class="bk-ph">' + t("筆記") + "</span>")) + "</div>" + page +
        (opts.refs && opts.refs.go ? '<button class="bk-go" data-bk="go" title="' + t("跳到文件裡的這個位置") + '">' + (PR.icon ? PR.icon("link", "sm") : "→") + "</button>" : "") + "</div>" +
        (b.open ? '<div class="bk-cb">' + (ref ? (live.trim() ? blocksHtml(live) : '<p class="bk-lost">' + t("（這條只有畫線，沒有寫字）") + "</p>") : '<p class="bk-lost">' + t("（這條筆記已經不在了）") + "</p>") + "</div>" : "") + "</div>";
    }
    function editHtml(b) {
      let text = b.text || "";
      let extra = "";
      if (b.type === "code") extra = '<input class="bk-lang-in" value="' + esc(b.lang || "") + '" placeholder="' + t("語言") + '" spellcheck="false">';
      if (b.type === "callout") extra = '<span class="bk-kind">' + esc(b.kind === "ref" ? t("出處") : b.kind) + "</span>";
      return extra + '<textarea class="bk-in" rows="1" spellcheck="false">' + esc(text) + "</textarea>";
    }
    function render() {
      const html = state.blocks.map((b, i) => {
        const editing = state.editing === b.id;
        const cls = "bk-b t-" + b.type + (b.type === "list" ? " l-" + b.kind + " in-" + (b.indent || 0) : "") + (b.type === "heading" ? " hl-" + b.level : "") + (editing ? " editing" : "") + (state.selected.has(b.id) ? " sel" : "");
        const prev = state.preview && state.preview.from === i ? previewHtml() : "";
        return prev + '<div class="' + cls + '" data-id="' + b.id + '" data-i="' + i + '"><div class="bk-handle" draggable="true" title="' + t("拖動換順序；點一下選取這一塊") + '">' + (PR.icon ? PR.icon("more", "sm") : "⋮") + "</div>" +
          (editing ? editHtml(b) : viewHtml(b, i)) + "</div>";
      }).join("");
      list.innerHTML = html + (state.preview && state.preview.from >= state.blocks.length ? previewHtml() : "") + '<div class="bk-tail" data-bk="tail"></div>';
      if (state.editing) {
        const ta = list.querySelector(".bk-b.editing .bk-in");
        if (ta) { autosize(ta); }
      }
      emit("render");
    }
    function previewHtml() {
      const p = state.preview;
      return '<div class="bk-preview"><div class="bk-pv-head">' + (PR.icon ? PR.icon("sparkle", "sm") : "") + "<b>" + esc(p.label || t("AI 的建議")) + "</b>" + (p.streaming ? '<span class="spin"></span>' : "") + '<span class="grow"></span>' +
        (p.streaming ? '<button class="btn sm" data-bk="pv-stop">' + t("停止") + "</button>" : '<button class="btn sm accent" data-bk="pv-accept">' + t("採用") + '</button><button class="btn sm" data-bk="pv-reject">' + t("捨棄") + "</button>") + "</div>" +
        '<div class="bk-pv-body">' + (p.md ? blocksHtml(p.md) : '<p class="bk-ph">' + t("正在想…") + "</p>") + "</div></div>";
    }
    function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
    /* 只重畫一塊（打字時），不整份重畫 */
    function repaint(id) {
      const el = blockEl(id), i = idx(id);
      if (!el || i < 0) return render();
      const b = state.blocks[i];
      el.className = "bk-b t-" + b.type + (b.type === "list" ? " l-" + b.kind + " in-" + (b.indent || 0) : "") + (b.type === "heading" ? " hl-" + b.level : "") + (state.editing === id ? " editing" : "") + (state.selected.has(id) ? " sel" : "");
      el.innerHTML = '<div class="bk-handle" draggable="true" title="' + t("拖動換順序；點一下選取這一塊") + '">' + (PR.icon ? PR.icon("more", "sm") : "⋮") + "</div>" + (state.editing === id ? editHtml(b) : viewHtml(b, i));
      if (state.editing === id) { const ta = el.querySelector(".bk-in"); if (ta) autosize(ta); }
    }

    /* ---------- 歷史（跨區塊的復原） ---------- */
    function snapshot() {
      const md = getValue();
      if (state.history[state.history.length - 1] === md) return;
      state.history.push(md);
      if (state.history.length > 80) state.history.shift();
      state.future = [];
    }
    function changed(id) { changeSoon(); if (id) repaint(id); else render(); }
    function undo() {
      if (!state.history.length) return false;
      state.future.push(getValue());
      load(state.history.pop(), true);
      return true;
    }
    function redo() {
      if (!state.future.length) return false;
      state.history.push(getValue());
      load(state.future.pop(), true);
      return true;
    }
    function load(md, keepFocus) {
      const focusAt = state.editing ? idx(state.editing) : -1;
      state.blocks = parse(md);
      if (!state.blocks.length) state.blocks = [{ id: bid(), type: "p", text: "" }];
      state.editing = keepFocus && focusAt >= 0 && state.blocks[Math.min(focusAt, state.blocks.length - 1)] ? state.blocks[Math.min(focusAt, state.blocks.length - 1)].id : null;
      state.selected.clear();
      render();
      if (state.editing) focusEdit(state.editing, "end");
      changeSoon();
    }

    /* ---------- 進出編輯 ---------- */
    function startEdit(id, where) {
      if (state.editing === id) return;
      const was = state.editing;
      state.editing = id;
      state.selected.clear();
      closeMenu();
      if (was) repaint(was);
      repaint(id);
      focusEdit(id, where);
    }
    function focusEdit(id, where) {
      const ta = blockEl(id) && blockEl(id).querySelector(".bk-in");
      if (!ta) return;
      ta.focus({ preventScroll: false });
      const n = ta.value.length;
      if (where === "start") ta.setSelectionRange(0, 0);
      else if (where === "end" || where == null) ta.setSelectionRange(n, n);
      else if (typeof where === "number") { const k = Math.max(0, Math.min(n, where)); ta.setSelectionRange(k, k); }
      else if (where && where.line === "last") { const k = Math.min(n, ta.value.lastIndexOf("\n") + 1 + (where.col || 0)); ta.setSelectionRange(k, k); }
    }
    function stopEdit() {
      if (!state.editing) return;
      const id = state.editing;
      pullText(id);
      state.editing = null;
      closeMenu();
      repaint(id);
      changeSoon.flush();
      if (state.pendingValue != null) { const md = state.pendingValue; state.pendingValue = null; if (md !== getValue()) load(md, false); }  // 打字時外面改了內容：現在才換上
      emit("blur");
    }
    /* 把輸入框裡的字收回區塊（同時認 Markdown 的開頭記號：- 、1. 、# 、> 、[] 、--- 、``` 、$$） */
    function pullText(id) {
      const el = blockEl(id), ta = el && el.querySelector(".bk-in");
      const i = idx(id);
      if (!ta || i < 0) return;
      const b = state.blocks[i];
      b.text = ta.value;
      const langIn = el.querySelector(".bk-lang-in");
      if (langIn) b.lang = langIn.value.trim().toLowerCase();
    }
    function convertByPrefix(id) {
      const i = idx(id); if (i < 0) return false;
      const b = state.blocks[i], ta = blockEl(id).querySelector(".bk-in");
      if (!ta || b.type !== "p" && b.type !== "heading" && b.type !== "list") return false;
      const v = ta.value;
      let m, nb = null;
      if ((m = /^(#{1,3})\s$/.exec(v) || /^(#{1,3})\s(.*)$/.exec(v)) && b.type !== "list") nb = { type: "heading", level: m[1].length, text: m[2] || "" };
      else if ((m = /^(?:-|\*)\s\[([ x])\]\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "todo", checked: m[1] === "x", indent: 0, text: m[2] };
      else if ((m = /^\[\]\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "todo", checked: false, indent: 0, text: m[1] };
      else if ((m = /^(?:-|\*)\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "bullet", indent: 0, text: m[1] };
      else if ((m = /^1[.)]\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "number", indent: 0, text: m[1] };
      else if ((m = /^>\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "quote", text: m[1] };
      else if (/^(---|\*\*\*)$/.test(v) && b.type === "p") nb = { type: "divider", text: "" };
      else if ((m = /^```([\w+-]*)$/.exec(v)) && b.type === "p") nb = { type: "code", lang: m[1], text: "" };
      else if (/^\$\$$/.test(v) && b.type === "p") nb = { type: "math", text: "" };
      if (!nb) return false;
      snapshot();
      state.blocks[i] = Object.assign({ id }, nb);
      if (nb.type === "divider") { state.editing = null; insertAfter(i, { type: "p", text: "" }, true); return true; }
      repaint(id); focusEdit(id, "end"); changeSoon();
      return true;
    }
    function insertAfter(i, b, edit) {
      b.id = bid();
      state.blocks.splice(i + 1, 0, b);
      if (edit) { state.editing = b.id; }
      render();
      if (edit) focusEdit(b.id, "start");
      changeSoon();
      return b;
    }
    function setType(id, k) {
      const i = idx(id); if (i < 0) return;
      const b = state.blocks[i];
      snapshot();
      const text = (b.type === "callout" ? b.text : b.text) || "";
      const base = { id, text };
      const map = { p: { type: "p" }, h1: { type: "heading", level: 1 }, h2: { type: "heading", level: 2 }, h3: { type: "heading", level: 3 },
        bullet: { type: "list", kind: "bullet", indent: b.indent || 0 }, number: { type: "list", kind: "number", indent: b.indent || 0 }, todo: { type: "list", kind: "todo", indent: b.indent || 0, checked: false },
        quote: { type: "quote" }, note: { type: "callout", kind: "note" }, warn: { type: "callout", kind: "warn" }, toggle: { type: "callout", kind: "toggle", open: true },
        code: { type: "code", lang: b.lang || "" }, math: { type: "math" }, divider: { type: "divider", text: "" }, flow: { type: "code", lang: "flow", text: text || "flowchart LR\n  A[開始] --> B[下一步]" },  // i18n-ok 範本內容
        table: { type: "table", text: text || "| 欄位 | 欄位 | 欄位 |\n| --- | --- | --- |\n|  |  |  |" } };  // i18n-ok 範本內容
      if (!map[k]) return;
      state.blocks[i] = Object.assign(base, map[k]);
      if (k === "divider") { state.editing = null; render(); insertAfter(i, { type: "p", text: "" }, true); return; }
      state.editing = id;
      repaint(id); focusEdit(id, "end"); changeSoon();
    }

    /* ---------- 鍵盤 ---------- */
    function onKey(e) {
      const ta = e.target.closest(".bk-in");
      if (!ta || e.isComposing) return;
      const el = ta.closest(".bk-b"), id = el.dataset.id, i = idx(id), b = state.blocks[i];
      if (!b) return;
      const mod = e.metaKey || e.ctrlKey;
      if (state.menu) { if (menuKey(e)) return; }
      if (e.key === "Escape") { e.preventDefault(); stopEdit(); state.selected.add(id); repaint(id); return; }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") { if (state.history.length && ta.value === b.text) { e.preventDefault(); undo(); } return; }
      if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { if (state.future.length) { e.preventDefault(); redo(); } return; }
      if (mod && !e.shiftKey && "bie".includes(e.key.toLowerCase())) { e.preventDefault(); wrap(ta, { b: "**", i: "*", e: "$" }[e.key.toLowerCase()]); return; }
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); wrap(ta, "[", "](url)"); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); pullText(id); stopEdit(); insertAfter(i, { type: "p", text: "" }, true); return; }
      if (e.key === "Enter" && !e.shiftKey && b.type !== "code" && b.type !== "math" && b.type !== "table" && !(b.type === "callout" && b.kind !== "ref") && b.type !== "quote") {
        e.preventDefault();
        pullText(id);
        const at = ta.selectionStart, before = ta.value.slice(0, at), after = ta.value.slice(ta.selectionEnd);
        if (b.type === "list" && !ta.value.trim()) { snapshot(); if (b.indent) { b.indent--; repaint(id); focusEdit(id); } else { state.blocks[i] = { id, type: "p", text: "" }; repaint(id); focusEdit(id); } changeSoon(); return; }
        snapshot();
        b.text = before.replace(/\s+$/, "");
        const nb = b.type === "list" ? { type: "list", kind: b.kind, indent: b.indent || 0, text: after.replace(/^\s+/, ""), checked: false } : { type: "p", text: after.replace(/^\s+/, "") };
        state.editing = null;
        insertAfter(i, nb, true);
        return;
      }
      if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        if (b.type === "list" || b.type === "heading" || b.type === "quote" || (b.type === "callout" && b.kind !== "ref")) {  // 先變回內文
          e.preventDefault(); snapshot(); pullText(id);
          const text = b.type === "callout" ? b.text : b.text;
          state.blocks[i] = { id, type: "p", text };
          repaint(id); focusEdit(id, "start"); changeSoon();
          return;
        }
        if (i > 0 && (b.type === "p" || b.type === "image" || b.type === "table")) {  // 併到上一塊
          const prev = state.blocks[i - 1];
          e.preventDefault(); snapshot(); pullText(id);
          if (prev.type === "divider" || prev.type === "code" || prev.type === "math" || prev.type === "image" || prev.type === "callout") {
            if (!b.text.trim()) { state.blocks.splice(i, 1); state.editing = null; render(); select(prev.id); } else { stopEdit(); select(prev.id); }
            changeSoon(); return;
          }
          const col = (prev.text || "").length;
          prev.text = (prev.text || "") + (b.text ? (prev.type === "list" || prev.type === "heading" ? " " : "\n") + b.text : "");
          state.blocks.splice(i, 1);
          state.editing = prev.id;
          render(); focusEdit(prev.id, col); changeSoon();
          return;
        }
      }
      if (e.key === "Tab" && b.type === "list") { e.preventDefault(); snapshot(); b.indent = Math.max(0, Math.min(4, (b.indent || 0) + (e.shiftKey ? -1 : 1))); pullText(id); repaint(id); focusEdit(id, ta.selectionStart); changeSoon(); return; }
      if (e.key === "ArrowUp" && !e.shiftKey && caretLine(ta) === 0 && i > 0) { e.preventDefault(); const col = ta.selectionStart; stopEdit(); moveTo(i - 1, { line: "last", col }); return; }
      if (e.key === "ArrowDown" && !e.shiftKey && caretLine(ta) === lineCount(ta) - 1 && i < state.blocks.length - 1) { e.preventDefault(); const col = ta.selectionStart - (ta.value.lastIndexOf("\n") + 1); stopEdit(); moveTo(i + 1, col); return; }
    }
    function moveTo(i, where) {
      const b = state.blocks[i];
      if (!b) return;
      if (b.type === "divider") { select(b.id); return; }
      startEdit(b.id, where);
    }
    const caretLine = (ta) => ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    const lineCount = (ta) => ta.value.split("\n").length;
    function wrap(ta, open, close) {
      close = close == null ? open : close;
      const a = ta.selectionStart, z = ta.selectionEnd, v = ta.value, sel = v.slice(a, z);
      const already = v.slice(a - open.length, a) === open && v.slice(z, z + close.length) === close;
      ta.focus();
      if (already) { ta.setSelectionRange(a - open.length, z + close.length); document.execCommand("insertText", false, sel); ta.setSelectionRange(a - open.length, z - open.length); }
      else { document.execCommand("insertText", false, open + sel + close); ta.setSelectionRange(a + open.length, z + open.length); }
      onInput({ target: ta });
    }
    function onInput(e) {
      const ta = e.target.closest && e.target.closest(".bk-in");
      if (!ta) { const li = e.target.closest && e.target.closest(".bk-lang-in"); if (li) { pullText(li.closest(".bk-b").dataset.id); changeSoon(); } return; }
      autosize(ta);
      const id = ta.closest(".bk-b").dataset.id, i = idx(id), b = state.blocks[i];
      if (!b) return;
      // 「/」在區塊開頭（或整塊是空的）：叫出區塊選單
      if (/^\/[^\s/]*$/.test(ta.value) && (b.type === "p" || b.type === "list" || b.type === "heading")) { openMenu(id, ta.value.slice(1)); }
      else if (state.menu) closeMenu();
      if (convertByPrefix(id)) return;
      b.text = ta.value;
      changeSoon();
    }

    /* ---------- 區塊選單 ---------- */
    function openMenu(id, q) {
      const el = blockEl(id);
      if (!el) return;
      let m = root.querySelector(".bk-menu");
      if (!m) { m = document.createElement("div"); m.className = "bk-menu"; root.append(m); }
      const items = MENU().filter((it) => !q || (it.label + " " + it.kw).toLowerCase().includes(q.toLowerCase()));
      if (!items.length) { closeMenu(); return; }
      state.menu = { id, items, at: 0 };
      m.innerHTML = items.map((it, k) => '<button class="bk-mi' + (k === 0 ? " on" : "") + '" data-k="' + it.k + '">' + (PR.icon ? PR.icon(it.icon, "sm") : "") + "<span><b>" + esc(it.label) + "</b>" + (it.hint ? "<small>" + esc(it.hint) + "</small>" : "") + "</span></button>").join("");
      const r = el.getBoundingClientRect(), rr = root.getBoundingClientRect();
      m.style.top = (r.bottom - rr.top + root.scrollTop + 4) + "px";
      m.style.left = Math.max(8, r.left - rr.left + 28) + "px";
      m.classList.add("open");
    }
    function closeMenu() { state.menu = null; const m = root.querySelector(".bk-menu"); if (m) m.classList.remove("open"); }
    function menuKey(e) {
      const mn = state.menu, m = root.querySelector(".bk-menu");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mn.at = (mn.at + (e.key === "ArrowDown" ? 1 : mn.items.length - 1)) % mn.items.length; m.querySelectorAll(".bk-mi").forEach((x, k) => x.classList.toggle("on", k === mn.at)); return true; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMenu(mn.items[mn.at].k); return true; }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); return true; }
      return false;
    }
    function pickMenu(k) {
      const mn = state.menu; if (!mn) return;
      const id = mn.id, i = idx(id);
      closeMenu();
      const ta = blockEl(id) && blockEl(id).querySelector(".bk-in");
      if (ta) ta.value = "";  // 把打的「/xx」清掉
      if (k === "image") { pickImage(id); return; }
      if (k === "ai") { pullText(id); state.blocks[i].text = ""; stopEdit(); api.askAi(i); return; }
      setType(id, k);
    }
    async function pickImage(id) {
      if (!opts.upload) return;
      const f = document.createElement("input");
      f.type = "file"; f.accept = "image/png,image/jpeg,image/gif,image/webp";
      f.onchange = async () => { const file = f.files && f.files[0]; if (!file) return; await putImage(id, file); };
      f.click();
    }
    async function putImage(id, file) {
      const i = idx(id); if (i < 0) return;
      try {
        const src = await opts.upload(file);
        if (!src) return;
        snapshot();
        const b = state.blocks[i];
        if (!(b.text || "").trim() && (b.type === "p")) { state.blocks[i] = { id, type: "image", text: "![](" + src + ")" }; state.editing = null; render(); insertAfter(i, { type: "p", text: "" }, true); }
        else { stopEdit(); insertAfter(i, { type: "image", text: "![](" + src + ")" }, false); insertAfter(i + 1, { type: "p", text: "" }, true); }
        changeSoon();
      } catch (err) { if (PR.toast) PR.toast(esc(err.message)); }
    }

    /* ---------- 選取、拖曳 ---------- */
    function select(id, add) {
      if (!add) state.selected.clear();
      state.selected.add(id);
      if (state.editing) stopEdit();
      render();
    }
    function selectedRange() {
      const is = state.blocks.map((b, i) => (state.selected.has(b.id) ? i : -1)).filter((i) => i >= 0);
      if (!is.length) return null;
      return { from: Math.min(...is), to: Math.max(...is) };
    }
    function deleteSelected() {
      const r = selectedRange(); if (!r) return;
      snapshot();
      state.blocks.splice(r.from, r.to - r.from + 1);
      if (!state.blocks.length) state.blocks = [{ id: bid(), type: "p", text: "" }];
      state.selected.clear();
      render(); changeSoon();
      const next = state.blocks[Math.min(r.from, state.blocks.length - 1)];
      if (next && next.type !== "divider") startEdit(next.id, "start");
    }
    function moveBlocks(from, to, before) {  // 把 from..to 這一段搬到 before 這塊前面（before 是 index，可能是 length）
      const r = selectedRange() && state.selected.has(state.blocks[from].id) ? selectedRange() : { from, to };
      if (before >= r.from && before <= r.to + 1) return;
      snapshot();
      const chunk = state.blocks.splice(r.from, r.to - r.from + 1);
      const at = before > r.to ? before - chunk.length : before;
      state.blocks.splice(at, 0, ...chunk);
      state.selected = new Set(chunk.map((b) => b.id));
      render(); changeSoon();
    }

    /* ---------- 事件 ---------- */
    root.addEventListener("keydown", onKey);
    root.addEventListener("input", onInput);
    root.addEventListener("focusout", (e) => {
      if (!e.target.closest || !e.target.closest(".bk-in, .bk-lang-in")) return;
      setTimeout(() => {
        const a = document.activeElement;
        if (a && root.contains(a) && a.closest(".bk-b.editing, .bk-menu")) return;
        if (state.menu && a && a.closest && a.closest(".bk-menu")) return;
        stopEdit();
      }, 0);
    });
    root.addEventListener("mousedown", (e) => {
      const mi = e.target.closest(".bk-mi");
      if (mi) { e.preventDefault(); pickMenu(mi.dataset.k); return; }
      const h = e.target.closest(".bk-handle");
      if (h) { e.preventDefault(); const id = h.closest(".bk-b").dataset.id; if (e.shiftKey && state.selected.size) { const r = selectedRange(), i = idx(id); const a = Math.min(r.from, i), z = Math.max(r.to, i); state.selected = new Set(state.blocks.slice(a, z + 1).map((b) => b.id)); if (state.editing) stopEdit(); render(); } else select(id, e.metaKey || e.ctrlKey); return; }
    });
    root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-bk]");
      if (act) {
        const k = act.dataset.bk, el = act.closest(".bk-b"), id = el && el.dataset.id, i = id ? idx(id) : -1, b = i >= 0 ? state.blocks[i] : null;
        if (k === "toggle-todo" && b) { e.preventDefault(); snapshot(); b.checked = !b.checked; repaint(id); changeSoon(); return; }
        if (k === "toggle-open" && b) { e.preventDefault(); b.open = !b.open; repaint(id); return; }
        if (k === "go" && b && opts.refs && opts.refs.go) { e.preventDefault(); opts.refs.go(b.args.split(/\s+/)[0]); return; }
        if (k === "tail") { const last = state.blocks[state.blocks.length - 1]; if (last && last.type === "p" && !last.text) startEdit(last.id, "end"); else insertAfter(state.blocks.length - 1, { type: "p", text: "" }, true); return; }
        if (k === "pv-accept") { api.acceptPreview(); return; }
        if (k === "pv-reject") { api.rejectPreview(); return; }
        if (k === "pv-stop") { if (state.preview && state.preview.stop) state.preview.stop(); return; }
      }
      if (e.target.closest("a, button, input, textarea, .bk-handle, .bk-preview, .katex-display, img")) return;
      const el = e.target.closest(".bk-b");
      if (!el) { if (e.target.closest(".bk-list") === list && e.target === list) { const last = state.blocks[state.blocks.length - 1]; if (last && last.type === "p" && !last.text) startEdit(last.id); else insertAfter(state.blocks.length - 1, { type: "p", text: "" }, true); } return; }
      const b = state.blocks[idx(el.dataset.id)];
      if (!b || b.type === "divider") { if (b) select(b.id); return; }
      if (state.editing === el.dataset.id) return;
      if (b.type === "callout" && b.kind === "ref" && !e.target.closest(".bk-ct")) { return; }
      startEdit(el.dataset.id, "end");
    });
    document.addEventListener("keydown", (e) => {
      if (!state.selected.size || state.editing || !root.isConnected) return;
      if (e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSelected(); }
      else if (e.key === "Escape") { state.selected.clear(); render(); }
      else if (e.key === "Enter") { const r = selectedRange(); e.preventDefault(); const b = state.blocks[r.from]; if (b.type !== "divider") startEdit(b.id, "end"); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { const r = selectedRange(); e.preventDefault(); snapshot(); const copy = state.blocks.slice(r.from, r.to + 1).map((b) => Object.assign({}, b, { id: bid() })); state.blocks.splice(r.to + 1, 0, ...copy); state.selected = new Set(copy.map((b) => b.id)); render(); changeSoon(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { const r = selectedRange(); const i = e.key === "ArrowUp" ? Math.max(0, r.from - 1) : Math.min(state.blocks.length - 1, r.to + 1); e.preventDefault(); if (e.altKey) { moveBlocks(r.from, r.to, e.key === "ArrowUp" ? i : i + 1); } else select(state.blocks[i].id); }
    });
    // 拖把手換順序：插入線跟著滑鼠走
    list.addEventListener("dragstart", (e) => {
      const h = e.target.closest(".bk-handle"); if (!h) return;
      const id = h.closest(".bk-b").dataset.id;
      if (!state.selected.has(id)) select(id);
      state.drag = { id };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", "block"); } catch (err) { /* 有些環境不給設 */ }
      h.closest(".bk-b").classList.add("dragging");
    });
    list.addEventListener("dragover", (e) => {
      if (!state.drag) return;
      e.preventDefault();
      const el = e.target.closest(".bk-b");
      list.querySelectorAll(".bk-b.drop-before, .bk-b.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
    });
    list.addEventListener("drop", (e) => {
      if (!state.drag) return;
      e.preventDefault();
      const target = list.querySelector(".bk-b.drop-before, .bk-b.drop-after");
      const from = idx(state.drag.id);
      state.drag = null;
      if (!target) { render(); return; }
      const ti = idx(target.dataset.id), before = target.classList.contains("drop-before") ? ti : ti + 1;
      const r = selectedRange() || { from, to: from };
      moveBlocks(r.from, r.to, before);
    });
    list.addEventListener("dragend", () => { state.drag = null; list.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((x) => x.classList.remove("dragging", "drop-before", "drop-after")); });
    // 貼圖片
    root.addEventListener("paste", (e) => {
      const ta = e.target.closest && e.target.closest(".bk-in");
      if (!ta || !opts.upload) return;
      const files = Array.from((e.clipboardData && e.clipboardData.items) || []).filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      const id = ta.closest(".bk-b").dataset.id;
      pullText(id);
      putImage(id, files[0]);
    });

    /* ---------- 對外 ---------- */
    const api = {
      getValue,
      setValue(md) { if (md === getValue()) { state.pendingValue = null; return; } if (state.editing) { state.pendingValue = md; return; } load(md, false); },
      root,
      rebind(fn) { opts.onChange = fn; },
      focus(at) { const b = at === "start" ? state.blocks[0] : state.blocks[state.blocks.length - 1]; if (b) startEdit(b.id, at === "start" ? "start" : "end"); },
      blur() { stopEdit(); },
      isEditing: () => !!state.editing,
      insert(md, where) {  // 在最後（或某個索引後）加上幾段
        snapshot();
        const nb = parse(md);
        const at = where == null ? state.blocks.length - 1 : where;
        nb.forEach((b, k) => state.blocks.splice(at + 1 + k, 0, b));
        render(); changeSoon.flush();
        return nb.map((b) => b.id);
      },
      selection() {  // 給 AI 用：選了哪幾塊（或正在編的那一塊）、它們的 Markdown
        let r = selectedRange();
        if (!r && state.editing) { const i = idx(state.editing); r = { from: i, to: i }; }
        if (!r) return null;
        return { from: r.from, to: r.to, md: serialize(state.blocks.slice(r.from, r.to + 1)), all: serialize(state.blocks) };
      },
      preview(from, to, md, extra) {  // AI 的建議：先放在原來那幾塊下面給讀者看，採用才真的換
        if (state.editing) stopEdit();
        state.preview = Object.assign({ from, to, md }, extra || {});
        render();
        const el = list.querySelector(".bk-preview");
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      },
      updatePreview(md, extra) { if (!state.preview) return; Object.assign(state.preview, { md }, extra || {}); const el = list.querySelector(".bk-pv-body"); if (el) el.innerHTML = md ? blocksHtml(md) : '<p class="bk-ph">' + t("正在想…") + "</p>"; const head = list.querySelector(".bk-preview"); if (head && extra && "streaming" in extra) render(); },
      acceptPreview() {
        const p = state.preview; if (!p) return;
        snapshot();
        const nb = parse(p.md);
        const count = p.to >= p.from && p.to < state.blocks.length ? p.to - p.from + 1 : 0;
        state.blocks.splice(p.from, count, ...nb);
        state.preview = null; state.selected = new Set(nb.map((b) => b.id));
        render(); changeSoon.flush();
        emit("accept", p);
      },
      rejectPreview() { const p = state.preview; state.preview = null; render(); emit("reject", p); },
      askAi(i) { emit("ai", { from: i, to: i }); },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; },
      select(i) { const b = state.blocks[i]; if (b) select(b.id); },
      count: () => state.blocks.length,
      destroy() { changeSoon.flush(); root.innerHTML = ""; root.classList.remove("bk"); },
    };
    render();
    return api;
  };
})(window.PR);
