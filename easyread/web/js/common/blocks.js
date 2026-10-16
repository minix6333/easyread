/* 區塊式筆記編輯器（像 Craft）：一段一個區塊，滑過去左邊有「＋」和把手——把手可以拖著換順序，點一下（或在區塊上按右鍵）開區塊選單
   （轉成別種、複製、剪下、複製一份、上下搬、刪）；打「/」叫出插入選單；Enter 新區塊、Backspace 併回上一塊、方向鍵在區塊間走；
   Tab 縮排清單；⌘B／⌘I／⌘E／⌘K 加標記。選區塊：Esc、點把手、⇧ 點、按著滑鼠拖過好幾塊、⇧↑↓；選著時 ⌘C／⌘X／⌘V／⌘D／⌫、⌥↑↓ 搬。
   畫的時候只動有變的那幾塊（render 是對著 id 補差的），點排好的字游標就落在那個字上（srcOffset 把看得到的字對回原文）。
   儲存的還是 Markdown（和以前的筆記、雲端同步、AI 的提示詞都相容）：每個區塊就是 Markdown 的一段，
   平常顯示排好的樣子（PR.md／PR.mdBlocks）。點進去那一塊：文字類的（內文、標題、清單、引用、說明框）還是排好的樣子，
   直接在上面改（所見即所得，common/richtext.js；存回去的還是同一套 Markdown）——不用打 ** $ 這些記號；
   程式碼、公式、表格是輸入框（寫原始碼，公式下面即時排出來）。
   不用打語法也能排版：⌘B／⌘I…、⌘⌥1–3 標題、⌘⇧7／⌘⇧8／⌘⇧9 編號／項目／待辦、⌘/ 轉成別種；
   開頭打「# 」「- 」「1. 」「> 」「[] 」，或全形的「＃ 」「－ 」「1、」「①」「》」「【】 」都會變成對應的區塊（注音輸入法打得出來）；
   「/」「／」或空的一塊打「、」叫出插入選單。
   區塊種類：內文、標題（三級）、清單（圓點／編號／待辦）、引用、說明框（> [!note|tip|warn|toggle] 標題）、
   出處卡（> [!ref 筆記id] 原話——指回文件裡某一條筆記，見 host.refs）、程式碼、公式、分隔線、圖片、表格、流程圖和示意圖（當程式碼編）。
   用法：const ed = PR.blockEditor(容器, { value, onChange(md), placeholder, compact, upload(file)→src, refs:{get(id), go(id)}, ai(sel) })
   ed.getValue() / setValue(md) / focus(at) / insert(md) / selection() / preview(from, to, md) / acceptPreview() / rejectPreview() / destroy()
   給外面的面板：ed.outline() / reveal(id) / stats() / current() / convert(k) / inline(mark) / indent(d) / insertBlock(k) / on("state", fn)；
   opts.moveOut(md) 有給的話選單多一項「移成新筆記」；opts.noAi 拿掉 AI 的項目。
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
  /* 表格的 Markdown ⇄ 一格一格（純函式）：| 甲 | 乙 |，第二行是 | --- | --- |（對齊的 :--- 記著） */
  /* 一列拆成幾格：$公式$、\x60程式碼\x60 裡的 | 不是分隔（條件機率 $p(y|x)$）——和排版那邊（markup.js 先把公式、程式碼拿出來再拆）一樣 */
  function splitRow(line) {
    let s = String(line || "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const out = [];
    let cur = "", math = false, code = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }  // 跳脫的字（\| \$ …）原樣留著
      if (c === "\x60" && !math) code = !code;
      else if (c === "$" && !code && s[i + 1] !== "$" && s[i - 1] !== "$") math = !math;
      if (c === "|" && !math && !code) { out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  /* 一格的 Markdown 放回表格：公式、程式碼外面的 | 都跳脫（連著的 || 兩個都要）；裡面的不動 */
  function escCell(c) {
    const s = String(c || "").replace(/\n+/g, " ");
    let out = "", math = false, code = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\" && i + 1 < s.length) { out += ch + s[i + 1]; i++; continue; }
      if (ch === "\x60" && !math) code = !code;
      else if (ch === "$" && !code && s[i + 1] !== "$" && s[i - 1] !== "$") math = !math;
      out += ch === "|" && !math && !code ? "\\|" : ch;
    }
    return out;
  }
  function tableGrid(md) {
    const lines = String(md || "").split("\n").filter((l) => l.trim());
    if (!lines.length) return { rows: [["", "", ""], ["", "", ""]], align: ["", "", ""] };
    const sep = lines[1] && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[1]);
    const rows = [splitRow(lines[0])].concat(lines.slice(sep ? 2 : 1).map(splitRow));
    const w = Math.max(1, ...rows.map((r) => r.length));
    const align = sep ? splitRow(lines[1]).map((c) => (/^:-+:$/.test(c) ? "c" : /-+:$/.test(c) ? "r" : /^:-+/.test(c) ? "l" : "")) : [];
    return { rows: rows.map((r) => r.concat(Array(w - r.length).fill("")).slice(0, w)), align: Array.from({ length: w }, (_, k) => align[k] || "") };
  }
  function gridTable(rows, align) {
    const w = Math.max(1, ...rows.map((r) => r.length));
    const cell = escCell;
    const rule = Array.from({ length: w }, (_, k) => ({ l: ":---", r: "---:", c: ":---:" })[(align || [])[k]] || "---");
    return ["| " + Array.from({ length: w }, (_, k) => cell(rows[0][k])).join(" | ") + " |", "| " + rule.join(" | ") + " |"]
      .concat(rows.slice(1).map((r) => "| " + Array.from({ length: w }, (_, k) => cell(r[k])).join(" | ") + " |")).join("\n");
  }
  PR.blocksTableGrid = tableGrid;
  PR.blocksGridTable = gridTable;
  PR.blocksParse = parse;
  PR.blocksSerialize = serialize;
  PR.blocksOne = one;

  /* 排好的樣子裡「看得到的字」對回 Markdown 原文的位置（純函式，tests/test_blocks.cjs）——點哪裡游標就到哪裡用的。
     vis：那個位置之前看得到的字，公式和圖片各算一個佔位字元（U+FFFC）；src：這一塊的 Markdown。
     原文多出來的是記號（**、\x60、連結的網址…），跳過；公式整段 $…$ 對一個佔位字元。對不完就回 null（游標放最後）。 */
  const OBJ = "\uFFFC";
  const SYN = /[*_~=+\x60\[\]()<>#|\\$!-]/;  // i18n-ok regex
  function srcOffset(src, vis, next) {
    const ws = (c) => c === " " || c === "\n" || c === "\t" || c === "\u00a0";
    let i = 0, j = 0;
    while (j < vis.length) {
      const v = vis[j];
      if (i >= src.length) { if (ws(v)) { j++; continue; } return null; }
      const s = src[i];
      if (v === OBJ) {
        const m = /^[\s\S]*?(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|!\[[^\]]*\]\([^)]*\))/.exec(src.slice(i));
        if (!m) return null;
        i += m[0].length; j++;
        continue;
      }
      if (s === v || (ws(s) && ws(v))) { i++; j++; continue; }
      if (ws(v) && !SYN.test(s)) { j++; continue; }                        // 排版多出來的空白
      if (s === "\\" && src[i + 1] === v) { i += 2; j++; continue; }       // 跳脫字元
      if (s === "]" && src[i + 1] === "(") { const c = src.indexOf(")", i); if (c > 0) { i = c + 1; continue; } }  // 連結的網址整段跳過
      i++;                                                                 // 記號
    }
    // 游標後面緊接著看得到的是 next：中間隔著的收尾記號（**、連結的 ](網址)）要跨過去，游標才落在那個字前面
    let k = i;
    while (k < src.length && src[k] !== next) {
      if (src[k] === "]" && src[k + 1] === "(") { const c = src.indexOf(")", k); if (c > 0) { k = c + 1; continue; } }
      if (!SYN.test(src[k]) || next === OBJ) break;
      k++;
    }
    if (next === OBJ) return i;
    return next ? (src[k] === next ? k : i) : (k >= src.length ? k : i);
  }
  PR.blocksSrcOffset = srcOffset;

  /* ---------- 區塊選單（「/」或左邊的「＋」叫出來） ---------- */
  const has = (name) => !!(PR.hasIcon && PR.hasIcon(name));
  const ico = (name, alt) => (PR.icon ? PR.icon(has(name) ? name : alt || name, "sm") : "");
  const MENU = () => [
    { k: "p", icon: ["pilcrow", "type"], g: "text", label: t("內文"), hint: t("一般的段落"), kw: "text p body" },
    { k: "h1", icon: ["h1", "bigger"], g: "text", label: t("大標題"), hint: "#", kw: "h1 heading title" },
    { k: "h2", icon: ["h2", "bigger"], g: "text", label: t("副標題"), hint: "##", kw: "h2 subtitle" },
    { k: "h3", icon: ["h3", "bigger"], g: "text", label: t("標題"), hint: "###", kw: "h3 heading" },
    { k: "link", icon: ["link", "link"], g: "text", label: t("連到文件或筆記"), hint: "@",
      kw: "link mention paper note page 連結 提到 文件 筆記" },  // i18n-ok（斜線選單裡打中文也找得到）
    { k: "bullet", icon: ["bullets", "log"], g: "list", label: t("項目清單"), hint: "-", kw: "list bullet ul" },
    { k: "number", icon: ["numbers", "list"], g: "list", label: t("編號清單"), hint: "1.", kw: "number ol" },
    { k: "todo", icon: ["todo", "check"], g: "list", label: t("待辦"), hint: "[]", kw: "todo task check" },
    { k: "toggle", icon: ["caret", "chevron"], g: "list", label: t("收合"), hint: t("點標題展開"), kw: "toggle fold" },
    { k: "quote", icon: ["quote", "quote"], g: "block", label: t("引用"), hint: ">", kw: "quote" },
    { k: "note", icon: ["callout", "info"], g: "block", label: t("說明框"), hint: t("重點、提醒"), kw: "callout note" },
    { k: "tip", icon: ["bulb", "bulb"], g: "block", label: t("訣竅框"), hint: t("做法、技巧"), kw: "callout tip" },
    { k: "warn", icon: ["alert", "alert"], g: "block", label: t("警示框"), hint: t("要小心的地方"), kw: "warn callout" },
    { k: "divider", icon: ["divider", "more"], g: "block", label: t("分隔線"), hint: "---", kw: "divider hr line" },
    { k: "code", icon: ["codeblock", "template"], g: "media", label: t("程式碼"), hint: "\x60\x60\x60", kw: "code" },
    { k: "math", icon: ["formula", "sigma"], g: "media", label: t("公式"), hint: "$$", kw: "math tex latex" },
    { k: "table", icon: ["table", "panel"], g: "media", label: t("表格"), hint: t("三欄的表"), kw: "table" },
    { k: "image", icon: ["image", "image"], g: "media", label: t("圖片"), hint: t("選檔或貼上"), kw: "image picture" },
    { k: "flow", icon: ["flow", "region"], g: "media", label: t("流程圖"), hint: "Mermaid", kw: "flow mermaid diagram" },
    { k: "ai", icon: ["sparkle", "sparkle"], g: "ai", label: t("AI 寫"), hint: t("描述要寫什麼"), kw: "ai write" },
  ];
  const GROUPS = () => ({ text: t("文字"), list: t("清單"), block: t("區塊"), media: t("媒體"), ai: "AI" });
  PR.blockKinds = MENU;
  PR.blockGroups = GROUPS;
  const INLINE = (b) => b && (b.type === "p" || b.type === "heading" || b.type === "list");  // 一塊就是一行字的那幾種
  /* 直接在排好的樣子上改的那幾種。引用、說明框裡有清單、$$ 公式、程式碼、表格、標題這些一整塊的東西時，改原文（排好的那一格只認行內的樣式，
     這些會被當成字面上的符號存回去，點進去再出來就壞了） */
  const BLOCKY = /(^|\n)[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|\$\$|\x60\x60\x60|\||#{1,6}[ \t]|>)/;
  const RICH = (b) => b && (b.type === "p" || b.type === "heading" || b.type === "list" || ((b.type === "quote" || b.type === "callout") && !BLOCKY.test(b.text || "")));
  const kindOf = (b) => (!b ? "" : b.type === "heading" ? "h" + b.level : b.type === "list" ? b.kind : b.type === "callout" ? b.kind : b.type === "code" && /^(flow|flowchart|mermaid|graph)$/.test(b.lang || "") ? "flow" : b.type);
  const FIELD_SIZING = typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content");  // 輸入框自己長高，不用每打一個字量一次

  /* ---------- 編輯器 ---------- */
  PR.blockEditor = function (host, opts) {
    opts = opts || {};
    const root = typeof host === "string" ? document.querySelector(host) : host;
    const useRich = !!(PR.rich && document.execCommand) && opts.rich !== false;  // 沒載 richtext.js（或明說不要）：退回輸入框
    const state = { blocks: parse(opts.value || ""), editing: null, selected: new Set(), anchor: null, head: null, preview: null, menu: null, drag: null, history: [], future: [], compact: !!opts.compact, saved: opts.value || "" };  // saved：外面最後知道的內容（交出去的、外面放進來的）
    const listeners = {};
    if (!state.blocks.length) state.blocks = [{ id: bid(), type: "p", text: "" }];  // 空的也要有一塊可以點進去
    root.classList.add("bk");
    if (state.compact) root.classList.add("compact");
    root.innerHTML = '<div class="bk-list"></div>';
    const list = root.firstElementChild;
    /* 小的編輯器（筆記面板的本頁、總結，卡片、便利貼）：寫的時候底下一排，不用打語法——標題、項目、編號、待辦、公式、表格、圖片。
       筆記面板的在寫的時候才出現（.writing）；卡片、便利貼只有在寫的時候才有編輯器，一直出現（strip: "always"） */
    let writingTimer = 0;
    const writing = (on) => {  // 底下那排只在寫的時候出現；從一塊點到另一塊中間會先收起再開始編，晚一點才收，免得它閃一下、下面的東西跳一下
      clearTimeout(writingTimer);
      if (on) root.classList.add("writing");
      else writingTimer = setTimeout(() => { if (!state.editing) root.classList.remove("writing"); }, 300);
    };
    if (opts.strip === "always") root.classList.add("strip-always");
    if (opts.strip != null ? opts.strip : state.compact) {
      const SB = [["h3", "h3", "bigger", t("標題")], ["bullet", "bullets", "log", t("項目清單")], ["number", "numbers", "list", t("編號清單")], ["todo", "todo", "check", t("待辦")],
        ["math", "formula", "sigma", t("公式")], ["table", "table", "panel", t("表格")]].concat(opts.upload ? [["image", "image", "image", t("圖片")]] : []);
      const strip = document.createElement("div");
      strip.className = "bk-strip";
      strip.innerHTML = SB.map(([k, a, b2, label]) => '<button type="button" data-sb="' + k + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + ico(a, b2) + "</button>").join("");
      root.append(strip);
      strip.addEventListener("mousedown", (e) => e.preventDefault());  // 別讓正在寫的那一塊失焦
      strip.addEventListener("click", (e) => {
        const b = e.target.closest("[data-sb]");
        if (!b) return;
        const k = b.dataset.sb;
        if (pop) closePop(true);  // 公式小框開著：先把打好的 TeX 收進去（不然換種類、插一塊時就不見了）
        if (!state.editing && !state.selected.size) { const last = state.blocks[state.blocks.length - 1]; if (last) startEdit(last.id, "end"); }
        if (k === "math" || k === "table" || k === "image") api.insertBlock(k);
        else api.convert(api.current().kind === k ? "p" : k);
      });
    }
    // opts.immediate（卡片、便利貼裡的小編輯器）：每改一下就告訴外面——那邊按 Esc 是同一個按鍵事件裡就去讀值存檔，等不了
    const changeSoon = opts.immediate ? Object.assign(() => emit("change", getValue()), { flush() {} }) : debounce(() => emit("change", getValue()), 400);
    function emit(ev, data) { if (ev === "change") state.saved = data; (listeners[ev] || []).forEach((fn) => fn(data)); if (ev === "change" && opts.onChange) opts.onChange(data); }
    function debounce(fn, ms) { let h; return Object.assign((...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }, { flush: () => { clearTimeout(h); fn(); } }); }
    const getValue = () => serialize(state.blocks);
    const idx = (id) => state.blocks.findIndex((b) => b.id === id);
    const blockEl = (id) => list.querySelector('.bk-b[data-id="' + id + '"]');
    const taOf = (id) => { const el = blockEl(id); return el ? el.querySelector(".bk-in") : null; };
    /* 正在編的那一格：輸入框（程式碼、公式、表格）或排好的樣子（其餘）。位置：輸入框是 Markdown 的字數，排好的是看得到的格數 */
    function fieldOf(id) {
      const el = taOf(id);
      if (!el) return null;
      if (el.tagName === "TEXTAREA") {
        return { el, rich: false, value: () => el.value, text: () => el.value, len: () => el.value.length,
          caret: () => ({ start: el.selectionStart, end: el.selectionEnd }), setCaret: (a, z) => el.setSelectionRange(a, z == null ? a : z),
          before: () => el.value.slice(0, el.selectionStart), after: () => el.value.slice(el.selectionEnd),
          firstLine: () => caretLine(el) === 0, lastLine: () => caretLine(el) === lineCount(el) - 1 };
      }
      const R = PR.rich;
      const f = { el, rich: true, value: () => R.md(el), text: () => R.text(el), len: () => R.length(el),
        caret: () => R.caret(el) || { start: R.length(el), end: R.length(el) }, setCaret: (a, z) => R.setCaret(el, a, z),
        before: () => R.slice(el, 0, f.caret().start), after: () => R.slice(el, f.caret().end),
        firstLine: () => R.onFirstLine(el), lastLine: () => R.onLastLine(el) };
      return f;
    }
    const lenOf = (b, md) => (useRich && RICH(b) ? PR.rich.lenOf(md || "") : (md || "").length);  // 一段 Markdown 在這一種區塊裡有幾格
    const joinMd = (b, a, z) => (useRich && RICH(b) ? PR.rich.join(a || "", z || "") : (a || "") + (z || ""));
    let stateQueued = false;
    function stateSoon() {  // 選了哪幾塊、正在編哪一塊變了：告訴外面（格式面板、目錄要跟著亮）
      if (stateQueued) return;
      stateQueued = true;
      Promise.resolve().then(() => { stateQueued = false; emit("state", api.current()); });
    }

    /* 選字工具列（像 Craft）：正在編的那一塊裡選了字，上面浮出一排：問 AI、粗、斜、底線、刪除線、程式碼、螢光、公式、連結 */
    const tools = document.createElement("div");
    tools.className = "bk-tools";
    const TOOLS = [["ai", "sparkle", PR.t("問 AI 改這段（⌘↩）")], ["**", "bold", PR.t("粗體（⌘B）")], ["*", "italic", PR.t("斜體（⌘I）")], ["++", "underline", PR.t("底線（⌘U）")],
      ["~~", "strike", PR.t("刪除線（⌘⇧-）")], ["\x60", "code", PR.t("程式碼（⌘⇧C）")], ["==", "marker", PR.t("螢光（⌘⇧B）")], ["$", "sigma", PR.t("公式（⌘⇧E）")], ["link", "link", PR.t("連結（⌘K）")]];
    tools.innerHTML = TOOLS.map(([k, ic, tip]) => '<button type="button" data-t="' + k + '" title="' + (PR.kbd ? PR.kbd(tip) : tip) + '">' + (PR.icon ? PR.icon(ic, "sm") : k) + "</button>").join("");
    root.append(tools);
    tools.addEventListener("mousedown", (e) => e.preventDefault());  // 別把輸入框的焦點搶走
    tools.addEventListener("click", (e) => {
      const b = e.target.closest("[data-t]");
      if (!b || !state.editing) return;
      const k = b.dataset.t;
      if (k === "ai") { const i = idx(state.editing); pullText(state.editing); stopEdit(); api.askAi(i); return; }
      api.inline(k);
    });
    /* 輸入框裡某個位置在畫面上的哪裡（工具列要浮在選起來的字上面，不是整塊的最上面）：用一個看不見、排版一樣的鏡子量 */
    let mirror = null;
    function caretXY(ta, pos) {
      if (!mirror) { mirror = document.createElement("div"); mirror.className = "bk-mirror"; root.append(mirror); }
      const cs = getComputedStyle(ta);
      mirror.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;top:0;left:0;" +
        "width:" + ta.clientWidth + "px;font:" + cs.font + ";letter-spacing:" + cs.letterSpacing + ";padding:" + cs.padding + ";line-height:" + cs.lineHeight + ";box-sizing:border-box";
      mirror.textContent = ta.value.slice(0, pos);
      const mark = document.createElement("span");
      mark.textContent = "\u200b";
      mirror.append(mark);
      const xy = { x: mark.offsetLeft, y: mark.offsetTop, h: mark.offsetHeight || parseFloat(cs.lineHeight) || 20 };
      mirror.textContent = "";
      return xy;
    }
    /* 卡片、便利貼的編輯器每次重畫卡片就換一個新的；舊的元素不在頁面上了，下一次有事件就自己把掛在 document 上的監聽拿掉 */
    function gone() {
      if (!opts.autoDestroy || root.isConnected) return false;
      changeSoon.flush();
      for (const [ev, fn] of [["selectionchange", placeTools], ["mousemove", onSweep], ["mouseup", endSweep], ["mousedown", onDocDown], ["keydown", onDocKey], ["copy", onDocCopy], ["cut", onDocCopy], ["paste", onDocPaste]]) document.removeEventListener(ev, fn);
      return true;
    }
    function placeTools() {
      if (gone()) return;
      const ta = document.activeElement;
      if (ta && ta.classList && ta.classList.contains("bk-rich") && root.contains(ta)) {  // 排好的那一格：照選取的範圍放；亮起游標所在的樣式
        const sel = getSelection(), on = sel.rangeCount && !sel.isCollapsed && ta.contains(sel.anchorNode) && ta.contains(sel.focusNode);
        tools.classList.toggle("open", !!on);
        if (!on) return;
        const act = PR.rich.active(ta), K = { "**": "b", "*": "i", "++": "u", "~~": "s", "\x60": "code", "==": "hl", link: "link" };
        tools.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", act.includes(K[x.dataset.t])));
        const rr = root.getBoundingClientRect(), sr = sel.getRangeAt(0).getBoundingClientRect();
        tools.style.top = Math.max(-44, sr.top - rr.top - 42) + "px";
        tools.style.left = Math.max(0, Math.min(sr.left - rr.left + sr.width / 2 - tools.offsetWidth / 2, root.clientWidth - tools.offsetWidth - 4)) + "px";
        return;
      }
      const on = ta && ta.classList && ta.classList.contains("bk-in") && root.contains(ta) && ta.selectionStart !== ta.selectionEnd;
      tools.classList.toggle("open", !!on);
      if (!on) return;
      const el = ta.closest(".bk-b");
      let top = el.offsetTop - 40, left = el.offsetLeft + ta.offsetLeft;
      try {
        const a = caretXY(ta, ta.selectionStart);
        const rr = root.getBoundingClientRect(), tr = ta.getBoundingClientRect();
        top = tr.top - rr.top + a.y - 42;
        left = tr.left - rr.left + a.x - 20;
      } catch (e) { /* 量不到就放在這一塊上面 */ }
      tools.style.top = Math.max(-44, top) + "px";
      tools.style.left = Math.max(0, Math.min(left, root.clientWidth - tools.offsetWidth - 4)) + "px";
    }
    document.addEventListener("selectionchange", placeTools);

    /* ---------- 畫 ---------- */
    function numberOf(i) {
      let n = 1;
      for (let k = i - 1; k >= 0 && state.blocks[k].type === "list" && (state.blocks[k].indent || 0) >= (state.blocks[i].indent || 0); k--) {
        if ((state.blocks[k].indent || 0) !== (state.blocks[i].indent || 0)) continue;
        if (state.blocks[k].kind !== "number") break;  // 同一層換成別種清單：重新數
        n++;
      }
      return n;
    }
    const inline = (s) => PR.md ? PR.md(s, { cite: false, xref: false }) : esc(s);
    const blocksHtml = (s) => PR.mdBlocks ? PR.mdBlocks(s) : "<p>" + esc(s) + "</p>";
    const HEAD_PH = () => ({ 1: t("大標題"), 2: t("副標題"), 3: t("標題") });
    function markHtml(b, i) {
      if (b.kind === "number") return '<span class="bk-mark n">' + numberOf(i) + ".</span>";
      if (b.kind === "todo") return '<button type="button" class="bk-mark todo' + (b.checked ? " on" : "") + '" data-bk="toggle-todo" tabindex="-1" aria-label="' + t("待辦") + '"></button>';
      return '<span class="bk-mark b"></span>';
    }
    const calloutIcon = (b) => (b.kind === "toggle" ? '<button type="button" class="bk-chev" data-bk="toggle-open" tabindex="-1" aria-label="' + t("展開") + '">' + ico("chevron") + "</button>"
      : '<span class="bk-ci">' + ico(b.kind === "warn" ? "alert" : b.kind === "ai" ? "sparkle" : b.kind === "tip" ? "bulb" : "info") + "</span>");
    function viewHtml(b, i) {
      const text = b.text || "";
      switch (b.type) {
        case "heading": return '<div class="bk-t bk-h' + b.level + '">' + (text ? inline(text) : '<span class="bk-ph">' + HEAD_PH()[b.level] + "</span>") + "</div>";
        case "list": return markHtml(b, i) + '<div class="bk-t' + (b.checked ? " done" : "") + '">' + (text ? inline(text) : '<span class="bk-ph">' + (b.kind === "todo" ? t("待辦") : t("清單項目")) + "</span>") + "</div>";
        case "quote": return '<div class="bk-t bk-quote">' + (text.trim() ? blocksHtml(text) : '<span class="bk-ph">' + t("引用") + "</span>") + "</div>";
        case "callout": {
          const lines = text.split("\n"), title = lines[0], body = lines.slice(1).join("\n");
          if (b.kind === "ref") return refHtml(b, title, body);
          const open = b.kind !== "toggle" || b.open;
          return '<div class="bk-callout k-' + b.kind + (open ? " open" : "") + '"><div class="bk-ch">' + calloutIcon(b) +
            '<div class="bk-ct">' + (title ? inline(title) : '<span class="bk-ph">' + t("標題") + "</span>") + "</div></div>" + (body && open ? '<div class="bk-cb">' + blocksHtml(body) + "</div>" : "") + "</div>";
        }
        case "code": {
          if (/^(flow|flowchart|mermaid|graph|viz|pic|picture|image|img)$/.test(b.lang || "")) return '<div class="bk-fig">' + blocksHtml(one(b)) + "</div>";  // 圖（流程圖、示意卡、網路上的圖）：畫出來，不顯示原始碼
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
      return '<div class="bk-callout k-ref' + (b.open ? " open" : "") + (ref ? "" : " lost") + '"><div class="bk-ch"><button type="button" class="bk-chev" data-bk="toggle-open" tabindex="-1" aria-label="' + t("展開") + '">' + ico("chevron") + "</button>" +
        '<div class="bk-ct">' + (title ? inline(title) : (ref && ref.title ? inline(ref.title) : '<span class="bk-ph">' + t("筆記") + "</span>")) + "</div>" + page +
        (opts.refs && opts.refs.go ? '<button type="button" class="bk-go" data-bk="go" tabindex="-1" title="' + t("跳到文件裡的這個位置") + '">' + ico("link") + "</button>" : "") + "</div>" +
        (b.open ? '<div class="bk-cb">' + (ref ? (live.trim() ? blocksHtml(live) : '<p class="bk-lost">' + t("（這條只有畫線，沒有寫字）") + "</p>") : '<p class="bk-lost">' + t("（這條筆記已經不在了）") + "</p>") + "</div>" : "") + "</div>";
    }
    /* 正在編的那一塊：外框和排好時一樣（清單的記號、說明框的底還在），只有字換成輸入框——點進去版面才不會跳 */
    function phOf(b, i) {
      if (b.type === "p") return i === 0 && state.blocks.length === 1 ? (opts.placeholder || t("寫點什麼，或按「/」選區塊…")) : t("按「/」選區塊");
      if (b.type === "heading") return HEAD_PH()[b.level];
      if (b.type === "list") return b.kind === "todo" ? t("待辦") : t("清單項目");
      if (b.type === "quote") return t("引用");
      if (b.type === "callout") return t("標題");
      return "";
    }
    function editHtml(b, i) {
      const ph = phOf(b, i);
      const ta = useRich && RICH(b)
        ? '<div class="bk-in bk-rich' + (b.type === "list" && b.checked ? " done" : "") + '" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true"' + (ph ? ' data-ph="' + esc(ph) + '"' : "") + ">" + PR.rich.html(b.text || "") + "</div>"
        : '<textarea class="bk-in" rows="1" spellcheck="false"' + (b.type === "p" && ph ? ' placeholder="' + esc(ph) + '"' : "") + ">" + esc(b.text || "") + "</textarea>";
      if (b.type === "list") return markHtml(b, i) + ta;
      if (b.type === "code") return '<div class="bk-code ed"><input class="bk-lang-in" value="' + esc(b.lang || "") + '" placeholder="' + t("語言") + '" spellcheck="false">' + ta + "</div>";
      if (b.type === "callout" && b.kind !== "ref") return '<div class="bk-callout ed k-' + b.kind + ' open"><div class="bk-ch">' + calloutIcon(b).replace(' data-bk="toggle-open"', "") + ta + "</div></div>";
      if (b.type === "callout") return '<span class="bk-kind">' + t("出處") + "</span>" + ta;
      // 表格：一格一格直接改（每一格也是排好的樣子）；Tab／Enter 走格子，旁邊的「＋」加一列、一欄，右鍵插入／刪除
      if (b.type === "table" && useRich) return gridHtml(b);
      // 公式：上面打 TeX、下面即時排出來（打錯一眼就看得到，不用離開這一塊才知道）
      if (b.type === "math") return '<div class="bk-math ed">' + ta + '<div class="bk-live">' + ((b.text || "").trim() ? blocksHtml("$$\n" + b.text + "\n$$") : "") + "</div></div>";
      return ta;
    }
    function gridHtml(b) {
      const g = tableGrid(b.text);
      const al = (k) => ({ l: "left", r: "right", c: "center" })[g.align[k]] || "";
      const cell = (tag, c, r, k) => "<" + tag + (al(k) ? ' style="text-align:' + al(k) + '"' : "") + '><div class="bk-cell bk-rich" contenteditable="true" spellcheck="false" data-r="' + r + '" data-c="' + k + '">' + PR.rich.html(c) + "</div></" + tag + ">";
      return '<div class="bk-grid"><div class="bk-gscroll"><table class="bk-gt"><thead><tr>' + g.rows[0].map((c, k) => cell("th", c, 0, k)).join("") + "</tr></thead><tbody>" +
        g.rows.slice(1).map((row, r) => "<tr>" + row.map((c, k) => cell("td", c, r + 1, k)).join("") + "</tr>").join("") + "</tbody></table></div>" +
        '<button type="button" class="bk-gadd col" data-bk="grid-col" tabindex="-1" title="' + esc(t("加一欄")) + '">' + ico("plus") + "</button>" +
        '<button type="button" class="bk-gadd row" data-bk="grid-row" tabindex="-1" title="' + esc(t("加一列")) + '">' + ico("plus") + "</button></div>";
    }
    /* 表格現在的樣子 → Markdown（打字、加減列欄之後） */
    function gridMd(el, b) {
      const tr = el.querySelectorAll(".bk-gt tr");
      const rows = Array.from(tr).map((r) => Array.from(r.querySelectorAll(".bk-cell")).map((c) => PR.rich.md(c)));
      return gridTable(rows.length ? rows : [[""]], tableGrid(b.text).align);
    }
    function gridFocus(el, r, c, atEnd) {
      const rows = el.querySelectorAll(".bk-gt tr");
      const row = rows[Math.max(0, Math.min(rows.length - 1, r))];
      if (!row) return;
      const cells = row.querySelectorAll(".bk-cell"), cell = cells[Math.max(0, Math.min(cells.length - 1, c))];
      if (!cell) return;
      cell.focus({ preventScroll: false });
      const n = PR.rich.length(cell);
      PR.rich.setCaret(cell, atEnd === false ? 0 : n);
    }
    /* 改表格的形狀：在第 r 列之後加一列、第 c 欄之後加一欄、刪掉某一列／欄。改完重畫，游標放到該去的那一格 */
    function gridShape(id, fn, focus) {
      const i = idx(id), el = blockEl(id); if (i < 0 || !el) return;
      const b = state.blocks[i];
      b.text = gridMd(el, b);
      snapshot();
      const g = tableGrid(b.text);
      fn(g);
      if (!g.rows.length || !g.rows[0].length) { state.blocks[i] = { id, type: "p", text: "" }; repaint(id); focusEdit(id, "start"); changeSoon(); return; }
      b.text = gridTable(g.rows, g.align);
      repaint(id);
      gridFocus(blockEl(id), focus[0], focus[1]);
      changeSoon();
    }
    const cellPos = (cell) => [+cell.dataset.r, +cell.dataset.c];
    function cellKey(e) {
      const cell = e.target.closest && e.target.closest(".bk-cell");
      if (!cell || e.isComposing || e.keyCode === 229) return;
      const el = cell.closest(".bk-b"), id = el.dataset.id, i = idx(id), b = state.blocks[i];
      if (!b) return;
      const [r, c] = cellPos(cell), rows = el.querySelectorAll(".bk-gt tr").length, cols = el.querySelectorAll(".bk-gt tr")[0].querySelectorAll(".bk-cell").length;
      const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
      if (e.key === "Escape") { e.preventDefault(); stopEdit(); select(id); return; }
      if (mod && !e.shiftKey && key === "z") { e.preventDefault(); undo(); return; }
      if (mod && (key === "y" || (e.shiftKey && key === "z"))) { e.preventDefault(); redo(); return; }
      if (mod && !e.altKey) {
        const inl = !e.shiftKey ? { b: "b", i: "i", u: "u" }[key] : { c: "code", "-": "s", _: "s", b: "hl" }[key];
        if (inl) { e.preventDefault(); typingSnapshot(id); if (PR.rich.toggle(cell, inl)) cellInput(cell); return; }
        if (e.key === "Enter") { e.preventDefault(); pullText(id); state.editing = null; insertAfter(i, { type: "p", text: "" }, true); return; }  // ⌘↩：跳出表格，下面接一段
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) { if (c > 0) gridFocus(el, r, c - 1); else if (r > 0) gridFocus(el, r - 1, cols - 1); return; }
        if (c < cols - 1) gridFocus(el, r, c + 1);
        else if (r < rows - 1) gridFocus(el, r + 1, 0);
        else gridShape(id, (g) => g.rows.push(Array(cols).fill("")), [r + 1, 0]);  // 最後一格再 Tab：多一列
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (r < rows - 1) gridFocus(el, r + 1, c);
        else gridShape(id, (g) => g.rows.push(Array(cols).fill("")), [r + 1, c]);
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); return; }  // 格子裡不換行（Markdown 的表格一格只有一行）
      const caretAt = PR.rich.caret(cell) || { start: 0, end: 0 }, n = PR.rich.length(cell);
      if (e.key === "ArrowUp" && !e.shiftKey && r > 0) { e.preventDefault(); gridFocus(el, r - 1, c); return; }
      if (e.key === "ArrowDown" && !e.shiftKey && r < rows - 1) { e.preventDefault(); gridFocus(el, r + 1, c); return; }
      if (e.key === "ArrowUp" && !e.shiftKey && r === 0 && i > 0) { e.preventDefault(); stopEdit(); moveTo(i - 1, "end", -1); return; }
      if (e.key === "ArrowDown" && !e.shiftKey && r === rows - 1 && i < state.blocks.length - 1) { e.preventDefault(); stopEdit(); moveTo(i + 1, "start", 1); return; }
      if (e.key === "ArrowLeft" && !e.shiftKey && caretAt.start === 0 && caretAt.end === 0 && (c > 0 || r > 0)) { e.preventDefault(); if (c > 0) gridFocus(el, r, c - 1); else gridFocus(el, r - 1, cols - 1); return; }
      if (e.key === "ArrowRight" && !e.shiftKey && caretAt.start === n && caretAt.end === n && (c < cols - 1 || r < rows - 1)) { e.preventDefault(); if (c < cols - 1) gridFocus(el, r, c + 1, false); else gridFocus(el, r + 1, 0, false); return; }
    }
    function cellInput(cell) {
      const el = cell.closest(".bk-b"), id = el && el.dataset.id, i = idx(id), b = state.blocks[i];
      if (!b) return;
      if (cell.innerHTML === "<br>") cell.innerHTML = "";
      typingSnapshot(id);  // 表格裡打字也記得復原點（以前 ⌘Z 一次退掉整串）
      dirty.add(id);
      b.text = gridMd(el, b);
      changeSoon();
    }
    function cellMenu(cell, at) {
      if (!PR.menu) return;
      const el = cell.closest(".bk-b"), id = el.dataset.id, [r, c] = cellPos(cell);
      const cols = el.querySelectorAll(".bk-gt tr")[0].querySelectorAll(".bk-cell").length, rows = el.querySelectorAll(".bk-gt tr").length;
      PR.menu(at, [
        { label: t("在上面插入一列"), icon: has("up") ? "up" : "arrowUp", disabled: r === 0, fn: () => gridShape(id, (g) => g.rows.splice(r, 0, Array(cols).fill("")), [r, c]) },
        { label: t("在下面插入一列"), icon: has("down") ? "down" : "arrowUp", fn: () => gridShape(id, (g) => g.rows.splice(r + 1, 0, Array(cols).fill("")), [r + 1, c]) },
        { label: t("在左邊插入一欄"), icon: "plus", fn: () => gridShape(id, (g) => { g.rows.forEach((row) => row.splice(c, 0, "")); g.align.splice(c, 0, ""); }, [r, c]) },
        { label: t("在右邊插入一欄"), icon: "plus", fn: () => gridShape(id, (g) => { g.rows.forEach((row) => row.splice(c + 1, 0, "")); g.align.splice(c + 1, 0, ""); }, [r, c + 1]) },
        "-",
        { label: t("刪掉這一列"), icon: "trash", danger: true, disabled: r === 0 && rows === 1, fn: () => gridShape(id, (g) => g.rows.splice(r, 1), [Math.max(0, r - 1), c]) },
        { label: t("刪掉這一欄"), icon: "trash", danger: true, fn: () => gridShape(id, (g) => { g.rows.forEach((row) => row.splice(c, 1)); g.align.splice(c, 1); }, [r, Math.max(0, c - 1)]) },
      ]);
    }
    /* 一塊畫出來長怎樣取決於這些；沒變就整個元素留著不動（公式、流程圖不用重畫，正在打字的輸入框不會被換掉） */
    const refSig = (b) => { if (b.type !== "callout" || b.kind !== "ref" || !opts.refs || !opts.refs.get) return ""; const r = opts.refs.get(b.args.split(/\s+/)[0]); return r ? [r.title, r.body, r.page].join("\u0002") : "lost"; };
    function sigOf(b, i) {
      const ed = state.editing === b.id;
      return [b.type, b.kind || "", b.level || 0, b.indent || 0, b.checked ? 1 : 0, b.open ? 1 : 0, b.args || "", b.type === "list" && b.kind === "number" ? numberOf(i) : "",
        i === 0 && state.blocks.length === 1 ? "solo" : "", ed ? "E" : "V" + (b.lang || "") + "\u0002" + (b.text || ""), refSig(b)].join("\u0001");
    }
    /* 類別裡跟前後鄰居有關的那幾個（b0、lf／ll、sj-up／sj-dn）是這裡算的，樣式表不用「相鄰」「第幾個」選擇器——理由見 blocks.css 開頭 */
    function clsOf(b, i) {
      const prev = state.blocks[i - 1], next = state.blocks[i + 1], sel = state.selected.has(b.id);
      return "bk-b t-" + b.type + (i === 0 ? " b0" : "") +
        (b.type === "list" ? " l-" + b.kind + " in-" + (b.indent || 0) + (!prev || prev.type !== "list" ? " lf" : "") + (!next || next.type !== "list" ? " ll" : "") : "") +
        (b.type === "heading" ? " hl-" + b.level : "") + (b.type === "callout" ? " c-" + b.kind : "") + (state.editing === b.id ? " editing" : "") +
        (sel ? " sel" + (prev && state.selected.has(prev.id) ? " sj-up" : "") + (next && state.selected.has(next.id) ? " sj-dn" : "") : "");
    }
    const GUT = '<div class="bk-gut">' + (state.compact ? "" : '<button type="button" class="bk-add" data-bk="add" tabindex="-1" title="' + t("在下面加一塊（按住 ⌥ 加在上面）") + '">' + ico("plus") + "</button>") +
      '<div class="bk-handle" draggable="true" data-menu-align="left" title="' + t("拖動換順序；點一下開選單") + '">' + ico("grip", "more") + "</div></div>";
    function paint(el, b, i) {
      const ed = state.editing === b.id;
      el.className = clsOf(b, i);
      el.dataset.id = b.id;
      el.innerHTML = GUT + (ed ? editHtml(b, i) : viewHtml(b, i));
      el._sig = sigOf(b, i);
      if (ed) { const ta = el.querySelector("textarea.bk-in"); if (ta) autosize(ta); }
    }
    function render() {
      const want = new Set(state.blocks.map((b) => b.id));
      const old = new Map();
      for (const el of Array.from(list.children)) {
        if (el.classList.contains("bk-b") && want.has(el.dataset.id)) old.set(el.dataset.id, el); else el.remove();  // 不在了的區塊、預覽、尾巴：拿掉（後兩個每次重放）
      }
      let ref = list.firstChild;
      state.blocks.forEach((b, i) => {
        let el = old.get(b.id);
        if (!el) { el = document.createElement("div"); paint(el, b, i); }
        else if (el._sig !== sigOf(b, i)) paint(el, b, i);
        else { const c = clsOf(b, i); if (el.className !== c) el.className = c; }
        if (el === ref) ref = ref.nextSibling; else list.insertBefore(el, ref);
      });
      if (state.preview) {
        const pv = document.createElement("div");
        pv.innerHTML = previewHtml();
        const at = state.blocks[state.preview.from];
        list.insertBefore(pv.firstElementChild, at ? blockEl(at.id) : null);
      }
      const tail = document.createElement("div");
      tail.className = "bk-tail"; tail.dataset.bk = "tail";
      list.append(tail);
      emit("render");
      stateSoon();
    }
    function previewHtml() {
      const p = state.preview;
      return '<div class="bk-preview"><div class="bk-pv-head">' + ico("sparkle") + "<b>" + esc(p.label || t("AI 的建議")) + "</b>" + (p.streaming ? '<span class="spin"></span>' : "") + '<span class="grow"></span>' +
        (p.streaming ? '<button class="btn sm" data-bk="pv-stop">' + t("停止") + "</button>" : '<button class="btn sm accent" data-bk="pv-accept">' + t("採用") + '</button><button class="btn sm" data-bk="pv-reject">' + t("捨棄") + "</button>") + "</div>" +
        '<div class="bk-pv-body">' + (p.md ? blocksHtml(p.md) : '<p class="bk-ph">' + t("正在想…") + "</p>") + "</div></div>";
    }
    function autosize(ta) { if (FIELD_SIZING) return; ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
    /* 只重畫一塊（種類、內容改了） */
    function repaint(id) {
      const el = blockEl(id), i = idx(id);
      if (!el || i < 0) return render();
      paint(el, state.blocks[i], i);
      for (const j of [i - 1, i + 1]) {  // 前後那兩塊的類別跟這一塊是什麼有關（清單的頭尾）
        const nb = state.blocks[j], ne = nb && blockEl(nb.id);
        if (ne) { const c = clsOf(nb, j); if (ne.className !== c) ne.className = c; }
      }
      stateSoon();
    }

    /* ---------- 歷史（跨區塊的復原）----------
       結構上的操作（分段、合併、搬、刪、換種類）做之前各記一次；打字是一陣一陣記（停了一秒再打、或換到別塊，算新的一陣）。 */
    function snapshot() {
      const md = getValue();
      if (state.history[state.history.length - 1] === md) return;
      state.history.push(md);
      if (state.history.length > 120) state.history.shift();
      state.future = [];
    }
    let typedAt = 0, typedIn = null;
    function typingSnapshot(id) {
      const now = Date.now();
      if (typedIn !== id || now - typedAt > 1000) snapshot();
      typedAt = now; typedIn = id;
    }
    function undo() {
      if (state.editing) pullText(state.editing);
      if (!state.history.length) return false;
      const cur = getValue();
      let md = state.history.pop();
      if (md === cur && state.history.length) md = state.history.pop();  // 最上面那筆就是現在的樣子（剛記完還沒改）：再退一筆
      if (md === cur) return false;
      state.future.push(cur);
      load(md, true);
      typedIn = null;
      return true;
    }
    function redo() {
      if (!state.future.length) return false;
      if (state.editing) pullText(state.editing);
      state.history.push(getValue());
      load(state.future.pop(), true);
      typedIn = null;
      return true;
    }
    function load(md, keepFocus) {
      const focusAt = state.editing ? idx(state.editing) : -1;
      state.saved = md;
      state.blocks = parse(md);
      if (!state.blocks.length) state.blocks = [{ id: bid(), type: "p", text: "" }];
      state.editing = keepFocus && focusAt >= 0 && state.blocks[Math.min(focusAt, state.blocks.length - 1)] ? state.blocks[Math.min(focusAt, state.blocks.length - 1)].id : null;
      if (state.editing && state.blocks[idx(state.editing)].type === "divider") state.editing = null;
      state.selected.clear(); state.anchor = state.head = null;
      render();
      if (state.editing) focusEdit(state.editing, "end");
      changeSoon();
    }

    /* ---------- 進出編輯 ---------- */
    function startEdit(id, where) {
      if (state.editing === id) { if (where != null) focusEdit(id, where); return; }
      const was = state.editing;
      if (was) { pullText(was); dirty.delete(was); }
      dirty.delete(id);  // 這一格等一下從存著的 Markdown 重畫：還沒動過
      closeMention();
      state.editing = id;
      writing(true);
      const hadSel = state.selected.size > 0;
      state.selected.clear(); state.anchor = state.head = null;
      closeMenu();
      if (hadSel) render(); else { if (was) repaint(was); repaint(id); }
      focusEdit(id, where);
    }
    function focusEdit(id, where) {
      const gel = blockEl(id);
      if (gel && gel.querySelector(".bk-grid")) {  // 表格：點的那一格（沒有就第一格／最後一格）
        if (where && where.cell) gridFocus(gel, where.cell[0], where.cell[1]);
        else if (where === "end") { const rows = gel.querySelectorAll(".bk-gt tr"); gridFocus(gel, rows.length - 1, 99); }
        else gridFocus(gel, 0, 0, false);
        return;
      }
      const f = fieldOf(id);
      if (!f) return;
      f.el.focus({ preventScroll: false });
      const n = f.len();
      if (where === "start") f.setCaret(0, 0);
      else if (where === "end" || where == null) f.setCaret(n, n);
      else if (typeof where === "number") { const k = Math.max(0, Math.min(n, where)); f.setCaret(k, k); }
      else if (where && where.x != null && f.rich) placeAtX(f, where.x, where.line === "last" ? "last" : "first");  // ↑↓ 走過來：落在差不多的水平位置
      else if (where && where.line === "last") { const k = f.rich ? n : Math.min(n, f.el.value.lastIndexOf("\n") + 1 + (where.col || 0)); f.setCaret(k, k); }
      else if (where && where.col != null) { const k = Math.max(0, Math.min(n, where.col)); f.setCaret(k, k); }
      else if (where && where.from != null) f.setCaret(Math.max(0, Math.min(n, where.from)), Math.max(0, Math.min(n, where.to)));
    }
    /* 排好的那一格：游標放在第一行（或最後一行）裡、水平位置最接近 x 的地方 */
    function placeAtX(f, x, edge) {
      const r = f.el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(f.el).lineHeight) || 24;
      const y = edge === "last" ? r.bottom - Math.min(lh / 2, r.height / 2) : r.top + Math.min(lh / 2, r.height / 2);
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(Math.max(r.left + 1, Math.min(r.right - 1, x)), y) : null;
      if (range && f.el.contains(range.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      else { const n = f.len(); f.setCaret(edge === "last" ? n : 0); }
    }
    function stopEdit() {
      if (!state.editing) return;
      if (pop) closePop(true);
      const id = state.editing;
      pullText(id);
      dirty.delete(id);
      state.editing = null;
      writing(false);
      closeMenu();
      closeMention();
      tools.classList.remove("open");
      repaint(id);
      changeSoon.flush();
      // 打字時外面改了內容：停下來才換上。但那之後自己又打了字，就留自己的（剛剛已經存了），不然剛打的字會被蓋掉、不見
      if (state.pendingValue != null) { const md = state.pendingValue, base = state.pendingBase; state.pendingValue = state.pendingBase = null; if (md !== getValue() && getValue() === base) load(md, false); }
      emit("blur");
    }
    /* 把輸入框裡的字收回區塊 */
    /* 這次編輯真的動過的塊（打字、改樣式、插公式、貼上…都會經過 onInput／cellInput）。沒動過的塊不從畫面收回來：
       排好的樣子轉回 Markdown 不見得一字不差，只是點進去再出來就改寫，會把讀者的筆記悄悄改掉 */
    const dirty = new Set();
    function pullText(id) {
      const el = blockEl(id), f = fieldOf(id);
      const i = idx(id);
      if (el && i >= 0 && el.querySelector(".bk-grid")) { if (dirty.has(id)) state.blocks[i].text = gridMd(el, state.blocks[i]); return; }  // 表格：一格一格收回來
      if (!f || i < 0) return;
      if (f.rich && !dirty.has(id)) return;
      const b = state.blocks[i];
      b.text = f.rich ? f.value().replace(/\n+$/, "") : f.value();  // 排好的那一格：最後多按的換行不存
      const langIn = el.querySelector(".bk-lang-in");
      if (langIn) b.lang = langIn.value.trim().toLowerCase();
    }
    /* 認 Markdown 的開頭記號：- 、1. 、# 、> 、[] 、--- 、\x60\x60\x60 、$$ */
    /* 開頭打了記號字：換成那一種區塊。全形的也認（注音輸入法打不出 # - 1. 這些）：
       ＃ 標題、－ ＊ • ・ 項目、1、 ① １． 編號、[] 【】「」＋空白 待辦、》＞ 引用、——— 分隔線、｀｀｀ 程式碼、＄＄ ￥￥ 公式 */
    const PREFIX = [
      [/^(#{1,3}|＃{1,3})[ \u3000]/, (m, b) => (b.type === "list" ? null : { type: "heading", level: m[1].length })],
      [/^(?:[-*]|[－＊•・])[ \u3000]\[([ xX])\][ \u3000]/, (m, b) => (b.type === "p" ? { type: "list", kind: "todo", checked: /x/i.test(m[1]), indent: 0 } : null)],
      [/^(?:\[ ?\]|【\s?】|「\s?」)[ \u3000]/, (m, b) => (b.type === "p" ? { type: "list", kind: "todo", checked: false, indent: 0 } : null)],
      [/^(?:[-*+]|[－＊•・])[ \u3000]/, (m, b) => (b.type === "p" ? { type: "list", kind: "bullet", indent: 0 } : null)],
      [/^(?:1[.)]|１[．.)）])[ \u3000]|^(?:1、|１、|①)/, (m, b) => (b.type === "p" ? { type: "list", kind: "number", indent: 0 } : null)],
      [/^(?:>|＞|》)[ \u3000]/, (m, b) => (b.type === "p" ? { type: "quote" } : null)],
    ];
    function convertByPrefix(id) {
      const i = idx(id); if (i < 0) return false;
      const b = state.blocks[i], f = fieldOf(id);
      if (!f || b.type !== "p" && b.type !== "heading" && b.type !== "list") return false;
      if (f.rich) {
        const txt = f.text();
        let nb = null;
        if (b.type === "p" && /^(---|\*\*\*|———|－－－|＿＿＿)$/.test(txt)) nb = { type: "divider", text: "" };
        else if (b.type === "p" && /^(\x60\x60\x60|｀｀｀)([\w+-]*)$/.test(txt)) nb = { type: "code", lang: (/^(?:\x60\x60\x60|｀｀｀)([\w+-]*)$/.exec(txt) || [])[1] || "", text: "" };
        else if (b.type === "p" && /^(\$\$|＄＄|￥￥)$/.test(txt)) nb = { type: "math", text: "" };
        else {
          const cAt = f.caret();
          for (const [re, mk] of PREFIX) {
            const m = re.exec(txt);
            if (!m) continue;
            if (!cAt || cAt.start !== m[0].length) continue;  // 只有剛打完開頭記號（游標就在它後面）才換；改「1、研究背景」後面的字不會突然變成清單
            const spec = mk(m, b);
            if (!spec) continue;
            nb = Object.assign(spec, { text: PR.rich.dropMd(f.value(), m[0].length) });
            break;
          }
        }
        if (!nb) return false;
        snapshot();
        state.blocks[i] = Object.assign({ id }, nb);
        if (nb.type === "divider") { state.editing = null; insertAfter(i, { type: "p", text: "" }, true); return true; }
        repaint(id); focusEdit(id, nb.type === "code" || nb.type === "math" ? "end" : "start"); changeSoon();
        return true;
      }
      const v = f.el.value;
      let m, nb = null;
      if ((m = /^(#{1,3})\s$/.exec(v) || /^(#{1,3})\s(.*)$/.exec(v)) && b.type !== "list") nb = { type: "heading", level: m[1].length, text: m[2] || "" };
      else if ((m = /^(?:-|\*)\s\[([ x])\]\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "todo", checked: m[1] === "x", indent: 0, text: m[2] };
      else if ((m = /^\[\]\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "todo", checked: false, indent: 0, text: m[1] };
      else if ((m = /^(?:-|\*)\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "bullet", indent: 0, text: m[1] };
      else if ((m = /^1[.)]\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "list", kind: "number", indent: 0, text: m[1] };
      else if ((m = /^>\s(.*)$/.exec(v)) && b.type === "p") nb = { type: "quote", text: m[1] };
      else if (/^(---|\*\*\*)$/.test(v) && b.type === "p") nb = { type: "divider", text: "" };
      else if ((m = /^\x60\x60\x60([\w+-]*)$/.exec(v)) && b.type === "p") nb = { type: "code", lang: m[1], text: "" };
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
      if (edit) { state.editing = b.id; state.selected.clear(); state.anchor = state.head = null; }
      render();
      if (edit) focusEdit(b.id, "start");
      changeSoon();
      return b;
    }
    const TYPES = () => ({ p: { type: "p" }, h1: { type: "heading", level: 1 }, h2: { type: "heading", level: 2 }, h3: { type: "heading", level: 3 },
      bullet: { type: "list", kind: "bullet" }, number: { type: "list", kind: "number" }, todo: { type: "list", kind: "todo", checked: false },
      quote: { type: "quote" }, note: { type: "callout", kind: "note" }, tip: { type: "callout", kind: "tip" }, warn: { type: "callout", kind: "warn" }, toggle: { type: "callout", kind: "toggle", open: true },
      code: { type: "code" }, math: { type: "math" }, divider: { type: "divider" }, flow: { type: "code", lang: "flow" }, table: { type: "table" } });
    const FLOW_TPL = "flowchart LR\n  A[開始] --> B[下一步]";  // i18n-ok 範本內容
    const TABLE_TPL = "| 欄位 | 欄位 | 欄位 |\n| --- | --- | --- |\n|  |  |  |";  // i18n-ok 範本內容
    /* 把一塊換成另一種（不重畫，回新的那一塊）。字留著；清單之間互換時縮排留著 */
    function retype(i, k) {
      const b = state.blocks[i], spec = TYPES()[k];
      if (!spec) return null;
      const text = b.type === "divider" ? "" : (b.text || "");
      const nb = Object.assign({ id: b.id, text }, spec);
      if (nb.type === "list") nb.indent = b.type === "list" ? (b.indent || 0) : 0;
      if (nb.type === "code") nb.lang = k === "flow" ? "flow" : (b.type === "code" && !/^(flow|flowchart|mermaid|graph)$/.test(b.lang || "") ? b.lang || "" : "");
      if (k === "flow" && !text.trim()) nb.text = FLOW_TPL;
      if (k === "table" && !TABLE.test(text.split("\n")[0] || "")) nb.text = text.trim() ? "| " + text.split("\n").join(" | ") + " |\n| --- |" : TABLE_TPL;
      if (k === "divider") nb.text = "";
      if (nb.type === "heading") nb.text = text.replace(/\n+/g, " ");
      state.blocks[i] = nb;
      return nb;
    }
    function setType(id, k) {
      const i = idx(id); if (i < 0) return;
      if (state.editing === id) pullText(id);
      snapshot();
      if (!retype(i, k)) return;
      if (k === "divider") { state.editing = null; render(); insertAfter(i, { type: "p", text: "" }, true); return; }
      state.editing = id;
      state.selected.clear(); state.anchor = state.head = null;
      render(); focusEdit(id, "end"); changeSoon();
    }
    /* 選起來的每一塊都換成 k（選單、格式面板用）；只選一塊、或正在編，就是那一塊 */
    function convert(k) {
      if (state.editing) return setType(state.editing, k);
      const r = selectedRange(); if (!r) return;
      snapshot();
      for (let i = r.from; i <= r.to; i++) if (state.blocks[i].type !== "image" || k === "p") retype(i, k);
      render(); changeSoon();
    }

    /* ---------- 鍵盤 ---------- */
    const MARK_OF = { "**": "b", "*": "i", "++": "u", "~~": "s", "\x60": "code", "==": "hl" };
    function onKey(e) {
      const ta = e.target.closest(".bk-in");
      if (!ta || e.isComposing || e.keyCode === 229) return;  // 注音、拼音選字中：鍵盤是輸入法的
      const el = ta.closest(".bk-b"), id = el.dataset.id, i = idx(id), b = state.blocks[i], f = fieldOf(id);
      if (!b || !f) return;
      const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase(), code = e.code || "";
      if (state.menu) { if (menuKey(e)) return; }
      if (state.mention) { if (mentionKey(e)) return; }
      if (e.key === "Escape") { e.preventDefault(); stopEdit(); select(id); return; }
      if (mod && !e.shiftKey && !e.altKey && key === "z") { if (state.history.length) { e.preventDefault(); undo(); } else if (f.rich) e.preventDefault(); return; }
      if (mod && !e.altKey && (key === "y" || (e.shiftKey && key === "z"))) { if (state.future.length) { e.preventDefault(); redo(); } else if (f.rich) e.preventDefault(); return; }
      const c = f.caret(), n = f.len();
      // ⌘A：先選這一塊的字；已經全選了（或是空的）再按一次，選全部的區塊（Craft 也是這樣）
      if (mod && !e.shiftKey && !e.altKey && key === "a" && c.start === 0 && c.end === n) { e.preventDefault(); stopEdit(); selectRange(0, state.blocks.length - 1); return; }
      // ⌘D：這一塊複製一份在下面
      if (mod && !e.shiftKey && !e.altKey && key === "d") { e.preventDefault(); pullText(id); snapshot(); const copy = Object.assign({}, b, { id: bid() }); state.blocks.splice(i + 1, 0, copy); render(); changeSoon(); return; }
      // Craft 的快捷鍵：⌘B 粗、⌘I 斜、⌘U 底線、⌘⇧C 程式碼、⌘⇧- 刪除線、⌘⇧B 螢光、⌘⇧E 公式、⌘K 連結、⌘↩ 問 AI、⌘⇧↩ 插入選單
      if (mod && !e.altKey) {
        const inl = !e.shiftKey ? { b: "**", i: "*", u: "++" }[key] : { c: "\x60", "-": "~~", _: "~~", b: "==", e: "$" }[key];
        if (inl) { e.preventDefault(); api.inline(inl); return; }
        if (!e.shiftKey && key === "k") { e.preventDefault(); api.inline("link"); return; }
        if (e.shiftKey && e.key === "Enter") { e.preventDefault(); openMenu(id, ""); return; }
        if (!e.shiftKey && e.key === "Enter") { e.preventDefault(); pullText(id); stopEdit(); api.askAi(i); return; }
        if (!e.shiftKey && (key === "/" || code === "Slash")) { e.preventDefault(); openMenu(id, "", true); return; }  // ⌘/：轉成別種（Notion）
        // ⌘⇧7 編號、⌘⇧8 項目、⌘⇧9 待辦（Google 文件、Apple 備忘錄那一套）
        const shiftList = e.shiftKey && { Digit7: "number", Digit8: "bullet", Digit9: "todo" }[code];
        if (shiftList) { e.preventDefault(); pullText(id); setType(id, kindOf(b) === shiftList ? "p" : shiftList); return; }
      }
      // Ctrl+1–6 文字樣式（大標題、副標題、標題、強調、內文、說明）；⌘⌥1–3 標題（Notion）；⌘⌥6–0 清單（待辦、收合、項目、編號、取消）；⌘⌥T 開關收合
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault(); pullText(id);
        const k = { 1: "h1", 2: "h2", 3: "h3", 4: "strong", 5: "p", 6: "p" }[e.key];
        setType(id, k === "strong" ? "p" : k);
        if (k === "strong") { const f2 = fieldOf(id); if (f2 && f2.len()) { f2.setCaret(0, f2.len()); if (f2.rich) { if (!PR.rich.active(f2.el).includes("b")) markRich(f2, "b"); } else if (!/^\*\*.*\*\*$/.test(f2.el.value)) wrap(f2.el, "**"); } }
        return;
      }
      if (mod && e.altKey && /^Digit[123]$/.test(code)) { e.preventDefault(); pullText(id); const k = "h" + code.slice(-1); setType(id, kindOf(b) === k ? "p" : k); return; }
      if (mod && e.altKey && /^Digit[06789]$/.test(code)) { e.preventDefault(); pullText(id); setType(id, { 6: "todo", 7: "toggle", 8: "bullet", 9: "number", 0: "p" }[code.slice(-1)]); return; }
      if (mod && e.altKey && key === "t" && b.type === "callout" && b.kind === "toggle") { e.preventDefault(); pullText(id); b.open = !b.open; changeSoon(); return; }
      // ⌘⌥↑↓ 搬這一塊；加 ⇧ 搬到最上面／最下面
      if (mod && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const up = e.key === "ArrowUp";
        const j = e.shiftKey ? (up ? 0 : state.blocks.length) : (up ? i - 1 : i + 2);
        if (j < 0 || j > state.blocks.length || j === i || j === i + 1) { e.preventDefault(); return; }
        e.preventDefault(); const at = c.start; pullText(id);
        moveBlocks(i, i, j); state.selected.clear(); state.anchor = state.head = null; state.editing = id; render(); focusEdit(id, at);
        const moved = blockEl(id); if (moved && moved.scrollIntoView) moved.scrollIntoView({ block: "nearest" });
        return;
      }
      // 排好的樣子裡 ⇧Enter：同一塊裡換行（引用、說明框裡的 Enter 也是），不讓瀏覽器自己插 <div>
      const emptyEnd = c.start === n && (f.rich ? PR.rich.endsWithEmptyLine(f.el) : /\n$/.test(f.text())) && !!f.text().trim();  // 游標在最後、最後一行是空的
      const softBreak = f.rich && e.key === "Enter" && !mod && (e.shiftKey || ((b.type === "quote" || b.type === "callout") && !emptyEnd));
      if (softBreak) { e.preventDefault(); typingSnapshot(id); document.execCommand("insertLineBreak"); onInput({ target: f.el }); return; }
      if (e.key === "Enter" && !e.shiftKey && !mod && b.type !== "code" && b.type !== "math" && b.type !== "table" && !(b.type === "callout" && b.kind !== "ref") && b.type !== "quote") {
        e.preventDefault();
        pullText(id);
        const before = f.before(), after = f.after();
        const plainB = f.rich ? PR.rich.plainOf(before) : before, plainA = f.rich ? PR.rich.plainOf(after) : after;
        if (b.type === "list" && !f.text().trim()) { snapshot(); if (b.indent) b.indent--; else state.blocks[i] = { id, type: "p", text: "" }; repaint(id); focusEdit(id); changeSoon(); return; }
        snapshot();
        if (!plainB.trim() && plainA.trim() && b.type !== "list") {  // 游標在最前面：上面多一塊空的，這一塊（連它的種類）往下移
          const nb = { id: bid(), type: "p", text: "" };
          state.blocks.splice(i, 0, nb);
          render(); focusEdit(id, "start"); changeSoon();
          return;
        }
        b.text = before.replace(/\s+$/, "");
        const nb = b.type === "list" ? { type: "list", kind: b.kind, indent: b.indent || 0, text: after.replace(/^\s+/, ""), checked: false } : { type: "p", text: after.replace(/^\s+/, "") };
        state.editing = null;
        insertAfter(i, nb, true);
        const fresh = blockEl(nb.id); if (fresh && fresh.scrollIntoView) fresh.scrollIntoView({ block: "nearest" });
        return;
      }
      // 引用、說明框、程式碼裡：最後是空行時再按 Enter，跳出去到下面新的一塊（不然出不來）
      if (e.key === "Enter" && !e.shiftKey && !mod && (b.type === "quote" || b.type === "callout" || b.type === "code") && emptyEnd) {
        e.preventDefault(); snapshot();
        if (f.rich) { pullText(id); b.text = b.text.replace(/\n+$/, ""); }
        else { f.el.value = f.el.value.replace(/\n+$/, ""); pullText(id); }
        state.editing = null;
        insertAfter(i, { type: "p", text: "" }, true);
        return;
      }
      // 剛把 -> 換成 →：緊接著按 Backspace 變回 ->
      if (e.key === "Backspace" && !mod && !e.altKey && f.rich && PR.rich.unsmart(f.el)) { e.preventDefault(); typingSnapshot(id); onInput({ target: f.el }); return; }
      if (e.key === "Backspace" && c.start === 0 && c.end === 0) {
        if (b.type === "list" && b.indent) { e.preventDefault(); snapshot(); pullText(id); b.indent--; repaint(id); focusEdit(id, "start"); changeSoon(); return; }  // 縮排的清單項：先退一層
        if (b.type === "list" || b.type === "heading" || b.type === "quote" || (b.type === "callout" && b.kind !== "ref")) {  // 先變回內文
          e.preventDefault(); snapshot(); pullText(id);
          state.blocks[i] = { id, type: "p", text: b.text };
          repaint(id); focusEdit(id, "start"); changeSoon();
          return;
        }
        if (i > 0 && (b.type === "p" || b.type === "image" || b.type === "table" || ((b.type === "code" || b.type === "math") && !f.text()))) {  // 併到上一塊
          const prev = state.blocks[i - 1];
          e.preventDefault(); snapshot(); pullText(id);
          if (!INLINE(prev) || b.type !== "p") {
            if (!b.text.trim()) { state.blocks.splice(i, 1); state.editing = null; if (INLINE(prev) || prev.type === "quote") { state.editing = prev.id; render(); focusEdit(prev.id, "end"); } else { render(); select(prev.id); } }
            else { stopEdit(); select(prev.id); }
            changeSoon(); return;
          }
          const col = lenOf(prev, prev.text);
          prev.text = joinMd(prev, prev.text, b.text);
          state.blocks.splice(i, 1);
          state.editing = prev.id;
          render(); focusEdit(prev.id, col); changeSoon();
          return;
        }
        if (i === 0 && b.type !== "p" && !f.text()) { e.preventDefault(); snapshot(); state.blocks[i] = { id, type: "p", text: "" }; repaint(id); focusEdit(id, "start"); changeSoon(); return; }
      }
      // Delete 在最後面：把下一塊併上來
      if (e.key === "Delete" && c.start === n && c.end === n && INLINE(b) && i < state.blocks.length - 1) {
        const next = state.blocks[i + 1];
        if (INLINE(next)) { e.preventDefault(); snapshot(); pullText(id); const col = lenOf(b, b.text); b.text = joinMd(b, b.text, next.text); state.blocks.splice(i + 1, 1); render(); focusEdit(id, col); changeSoon(); return; }
        if (next.type === "divider") { e.preventDefault(); snapshot(); state.blocks.splice(i + 1, 1); render(); changeSoon(); return; }
      }
      if (e.key === "Tab" && !mod && b.type === "list") { e.preventDefault(); snapshot(); const at = c.start; b.indent = Math.max(0, Math.min(4, (b.indent || 0) + (e.shiftKey ? -1 : 1))); pullText(id); repaint(id); focusEdit(id, at); changeSoon(); return; }
      if (e.key === "Tab" && !mod && (b.type === "code" || b.type === "math")) { e.preventDefault(); document.execCommand("insertText", false, "  "); return; }
      if (e.key === "Tab" && !mod && f.rich) { e.preventDefault(); return; }  // 別讓焦點跑到別的地方去
      // ⇧↑／⇧↓ 走到這一塊的頭尾還繼續按：變成選區塊，往上／下多選一塊
      if (e.shiftKey && !mod && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const up = e.key === "ArrowUp";
        if ((up && c.start === 0 && c.end <= n && f.firstLine()) || (!up && c.end === n)) {
          const j = up ? i - 1 : i + 1;
          if (j >= 0 && j < state.blocks.length) { e.preventDefault(); stopEdit(); selectRange(i, j); }
        }
        return;
      }
      const caretX = () => { const sel = getSelection(); if (!sel.rangeCount) return null; const r = sel.getRangeAt(0).getClientRects(); return r.length ? r[0].left : null; };
      if (e.key === "ArrowUp" && !e.shiftKey && !mod && !e.altKey && f.firstLine() && i > 0) {
        e.preventDefault();
        const x = f.rich ? caretX() : null, col = f.rich ? null : c.start;
        stopEdit(); moveTo(i - 1, { line: "last", col, x }, -1); return;
      }
      // 第一塊的第一行再往上、或在最前面按 Backspace：告訴外面（筆記頁會把游標送回標題）
      if (i === 0 && listeners.edge && ((e.key === "ArrowUp" && !e.shiftKey && !mod && !e.altKey && f.firstLine()) || (e.key === "Backspace" && c.start === 0 && c.end === 0 && b.type === "p"))) { e.preventDefault(); emit("edge", "top"); return; }
      if (e.key === "ArrowDown" && !e.shiftKey && !mod && !e.altKey && f.lastLine() && i < state.blocks.length - 1) {
        e.preventDefault();
        const x = f.rich ? caretX() : null, col = f.rich ? null : c.start - (f.el.value.lastIndexOf("\n") + 1);
        stopEdit(); moveTo(i + 1, f.rich ? { x } : col, 1); return;
      }
      // ← 在最前面、→ 在最後面：走到上一塊／下一塊
      if (e.key === "ArrowLeft" && !e.shiftKey && !mod && !e.altKey && c.start === 0 && c.end === 0 && i > 0) { e.preventDefault(); stopEdit(); moveTo(i - 1, "end", -1); return; }
      if (e.key === "ArrowRight" && !e.shiftKey && !mod && !e.altKey && c.start === n && c.end === n && i < state.blocks.length - 1) { e.preventDefault(); stopEdit(); moveTo(i + 1, "start", 1); return; }
    }
    function moveTo(i, where, dir) {
      const b = state.blocks[i];
      if (!b) return;
      if (b.type === "divider" || b.type === "image") { select(b.id); return; }  // 沒有字可以編的：選起來（再按方向鍵繼續走）
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
    function onBeforeInput(e) {  // 選字（注音、拼音）中間不記：那時候框裡是還沒選好的字。開始選字的那一下記（compositionstart）
      const ta = e.target.closest && e.target.closest(".bk-in");
      if (!ta || (e.isComposing && e.type !== "compositionstart")) return;
      const el = ta.closest(".bk-b");
      if (el) typingSnapshot(el.dataset.id);
    }
    function onInput(e) {
      const cell = e.target.closest && e.target.closest(".bk-cell");
      if (cell) {  // 表格的一格
        if (e.isComposing) return;
        if ((e.inputType === "insertText" || e.type === "compositionend") && /[*~+=\x60$]$/.test(e.data || "")) PR.rich.autoformat(cell);
        cellInput(cell);
        placeTools();
        return;
      }
      const ta = e.target.closest && e.target.closest(".bk-in");
      if (!ta) { const li = e.target.closest && e.target.closest(".bk-lang-in"); if (li) { pullText(li.closest(".bk-b").dataset.id); changeSoon(); } return; }
      const id = ta.closest(".bk-b").dataset.id, i = idx(id), b = state.blocks[i];
      if (!b) return;
      dirty.add(id);
      if (ta.tagName === "TEXTAREA") {
        autosize(ta);
        // 「/」在區塊開頭（或整塊是空的）：叫出區塊選單
        if (/^\/[^\s/]*$/.test(ta.value) && INLINE(b)) { openMenu(id, ta.value.slice(1)); }
        else if (state.menu) closeMenu();
        if (convertByPrefix(id)) return;
        b.text = ta.value;
        if (b.type === "math") liveMath(ta);
        changeSoon();
        return;
      }
      if (e.isComposing) return;  // 注音、拼音還在選字：選好（compositionend）再收
      if (ta.innerHTML === "<br>") ta.innerHTML = "";  // 刪光了：瀏覽器留一個 <br>，佔位的灰字才出得來
      // 打完一對記號（**字**、\x60字\x60、$式$…）：變成那個樣子
      if ((e.inputType === "insertText" || e.type === "compositionend") && /[*~+=\x60$]$/.test(e.data || "")) PR.rich.autoformat(ta);
      if (e.inputType === "insertText" && /[=>\-]$/.test(e.data || "")) PR.rich.smart(ta);  // -> 變 →、<= 變 ≤…
      else if (e.inputType || e.type === "compositionend") PR.rich.smart.forget();  // 換了之後又打了別的：Backspace 就是一般的刪字
      // 「/」「／」在開頭、或空的一塊打「、」：叫出區塊選單（後面打的字拿來篩）
      const txt = PR.rich.text(ta);
      if (INLINE(b) && (/^[\/／][^\s/／]*$/.test(txt) || /^、[^\s、]*$/.test(txt))) openMenu(id, txt.slice(1));
      else if (state.menu) closeMenu();
      if (state.mention || /[@＠]/.test(txt)) mentionCheck(id, txt);
      if (convertByPrefix(id)) return;
      b.text = PR.rich.md(ta);
      changeSoon();
      placeTools();
    }
    /* 排好的那一格加／拿掉一種樣式，再把字收回區塊 */
    function markRich(f, k) {
      typingSnapshot(f.el.closest(".bk-b").dataset.id);
      if (!PR.rich.toggle(f.el, k)) return false;
      onInput({ target: f.el });
      return true;
    }
    let liveQueued = false;
    function liveMath(ta) {  // 公式的即時預覽：一格畫面最多重排一次
      if (liveQueued) return;
      liveQueued = true;
      requestAnimationFrame(() => {
        liveQueued = false;
        const box = ta.isConnected && ta.parentElement.querySelector(".bk-live");
        if (box) box.innerHTML = ta.value.trim() ? blocksHtml("$$\n" + ta.value + "\n$$") : "";
      });
    }

    /* ---------- 「/」的區塊選單 ---------- */
    function openMenu(id, q, turn) {
      const el = blockEl(id);
      if (!el) return;
      let m = root.querySelector(".bk-menu");
      if (!m) { m = document.createElement("div"); m.className = "bk-menu"; root.append(m); }
      const items = MENU().filter((it) => (!q || (it.label + " " + it.kw).toLowerCase().includes(q.toLowerCase())) && (it.k !== "image" || opts.upload) && (it.k !== "ai" || !opts.noAi) && (it.k !== "link" || (!turn && PR.mentions)));
      if (!items.length) { closeMenu(); return; }
      state.menu = { id, items, at: 0, turn: !!turn };
      const groups = GROUPS();
      let last = "";
      m.innerHTML = items.map((it, k) => {
        const head = !q && it.g !== last ? '<div class="bk-mg">' + esc(groups[it.g] || "") + "</div>" : "";
        last = it.g;
        return head + '<button type="button" class="bk-mi' + (k === 0 ? " on" : "") + '" data-k="' + it.k + '"><span class="bk-mic">' + ico(it.icon[0], it.icon[1]) + "</span><b>" + esc(it.label) + "</b>" + (it.hint ? "<small>" + esc(it.hint) + "</small>" : "") + "</button>";
      }).join("");
      const r = el.getBoundingClientRect(), rr = root.getBoundingClientRect();
      const below = innerHeight - r.bottom, h = Math.min(340, m.scrollHeight || 340);
      m.classList.toggle("up", below < h + 16 && r.top > below);
      m.style.top = (m.classList.contains("up") ? r.top - rr.top - h - 6 : r.bottom - rr.top + 4) + "px";
      m.style.left = Math.max(8, r.left - rr.left + 28) + "px";
      m.scrollTop = 0;
      m.classList.add("open");
    }
    function closeMenu() { state.menu = null; const m = root.querySelector(".bk-menu"); if (m) m.classList.remove("open"); }
    function menuKey(e) {
      const mn = state.menu, m = root.querySelector(".bk-menu");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        mn.at = (mn.at + (e.key === "ArrowDown" ? 1 : mn.items.length - 1)) % mn.items.length;
        m.querySelectorAll(".bk-mi").forEach((x, k) => { x.classList.toggle("on", k === mn.at); if (k === mn.at && x.scrollIntoView) x.scrollIntoView({ block: "nearest" }); });
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMenu(mn.items[mn.at].k); return true; }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); return true; }
      return false;
    }
    function pickMenu(k) {
      const mn = state.menu; if (!mn) return;
      const id = mn.id, i = idx(id);
      closeMenu();
      const f = fieldOf(id);
      const cleared = !!(f && !mn.turn && (f.rich ? /^[\/／、][^\s/／、]*$/.test(f.text()) : /^\/[^\s/]*$/.test(f.el.value)));
      if (cleared) { if (f.rich) f.el.innerHTML = ""; else f.el.value = ""; state.blocks[i].text = ""; }  // 把打的「/xx」清掉
      if (k === "image") { pickImage(id); return; }
      if (k === "ai") { pullText(id); state.blocks[i].text = ""; stopEdit(); api.askAi(i); return; }
      if (k === "link") { if (f && f.rich) { f.el.focus(); if (cleared) f.setCaret(0, 0); document.execCommand("insertText", false, "@"); onInput({ target: f.el }); } return; }  // 在游標那裡打一個 @：叫出下面的「提到」
      setType(id, k);
    }

    /* ---------- 「@」提到：連到文獻庫的一篇文件（閱讀頁還有這一篇的第幾頁）、另一份筆記 ----------
       找的東西在 common/mention.js（PR.mentions.find）。@ 前面要是行首、空白或標點（打 email 的 a@b 不會跳出來）；
       後面打的字拿來篩；↑↓ 選、Enter／Tab 放進去、Esc 收起（字留著）。放進去的是連結，存成 [Karan 2026](/read/…) */
    let mentionSeq = 0;
    function mentionCheck(id, txt) {
      const f = fieldOf(id);
      if (!PR.mentions || !f || !f.rich) return closeMention();
      const c = f.caret();
      if (!c || c.start !== c.end) return closeMention();
      const m = /(?:^|[\s\u3000，。、；：！？（「『(\[])[@＠]([^\s@＠]{0,30})$/.exec((txt != null ? txt : PR.rich.text(f.el)).slice(0, c.start));
      if (!m) return closeMention();
      openMention(id, c.start - m[1].length - 1, m[1]);
    }
    async function openMention(id, from, q) {
      const seq = ++mentionSeq;
      let items = [];
      try { items = await PR.mentions.find(q); } catch (e) { items = []; }
      if (seq !== mentionSeq || state.editing !== id) return;  // 打得比找得快：只畫最後一次
      let m = root.querySelector(".bk-mention");
      if (!m) { m = document.createElement("div"); m.className = "bk-mention"; m.setAttribute("role", "listbox"); root.append(m); }
      if (!items.length) { closeMention(); return; }
      state.mention = { id, from, q, items, at: 0 };
      m.innerHTML = items.map((it, k) => '<button type="button" class="bk-mi' + (k === 0 ? " on" : "") + '" data-mk="' + k + '"><span class="bk-mic">' + ico(it.icon, "link") + "</span><b>" + esc(it.label) + "</b>" + (it.sub ? "<small>" + esc(it.sub) + "</small>" : "") + "</button>").join("");
      const sel = getSelection(), rr = root.getBoundingClientRect();
      let r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      if (!r || (!r.top && !r.height)) { const el = blockEl(id); r = el ? el.getBoundingClientRect() : rr; }
      const h = Math.min(320, m.scrollHeight || 320), below = innerHeight - r.bottom, up = below < h + 16 && r.top > below;
      m.classList.toggle("up", up);
      m.style.top = (up ? r.top - rr.top - h - 6 : r.bottom - rr.top + 6) + "px";
      m.style.left = Math.max(4, Math.min(r.left - rr.left - 10, rr.width - Math.min(320, rr.width) - 4)) + "px";
      m.scrollTop = 0;
      m.classList.add("open");
    }
    function closeMention() {
      mentionSeq++;
      if (!state.mention) return;
      state.mention = null;
      const m = root.querySelector(".bk-mention");
      if (m) m.classList.remove("open");
    }
    function mentionKey(e) {
      const mn = state.mention, m = root.querySelector(".bk-mention");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        mn.at = (mn.at + (e.key === "ArrowDown" ? 1 : mn.items.length - 1)) % mn.items.length;
        m.querySelectorAll(".bk-mi").forEach((x, k) => { x.classList.toggle("on", k === mn.at); if (k === mn.at && x.scrollIntoView) x.scrollIntoView({ block: "nearest" }); });
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mn.at); return true; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMention(); return true; }
      if (/^(ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(e.key)) closeMention();  // 游標走開了
      return false;
    }
    function pickMention(k) {
      const mn = state.mention; if (!mn) return;
      const it = mn.items[k];
      closeMention();
      const f = fieldOf(mn.id);
      if (!it || !f || !f.rich) return;
      const c = f.caret(), to = c ? c.start : mn.from + mn.q.length + 1;
      if (!/^[@＠][^\s@＠]*$/.test(PR.rich.text(f.el).slice(mn.from, to))) return;  // 游標已經不在「@找的字」後面（點到別處了）：不換，免得吃掉一段字
      typingSnapshot(mn.id);
      f.el.focus();
      f.setCaret(mn.from, to);
      if (PR.rich.insertLink(f.el, it.text, it.url)) onInput({ target: f.el });
    }
    async function pickImage(id) {
      if (!opts.upload) return;
      const f = document.createElement("input");
      f.type = "file"; f.accept = "image/png,image/jpeg,image/gif,image/webp";
      f.onchange = async () => { const file = f.files && f.files[0]; if (!file) return; await putImage(id, file); };
      f.click();
    }
    async function putImage(id, file) {
      let i = idx(id); if (i < 0) return;
      try {
        const src = await opts.upload(file);
        if (!src) return;
        i = idx(id); if (i < 0) i = state.blocks.length - 1;
        snapshot();
        const b = state.blocks[i];
        if (state.editing === id) pullText(id);
        if (!(b.text || "").trim() && b.type === "p") { state.blocks[i] = { id, type: "image", text: "![](" + src + ")" }; state.editing = null; render(); insertAfter(i, { type: "p", text: "" }, true); }
        else { if (state.editing) stopEdit(); insertAfter(i, { type: "image", text: "![](" + src + ")" }, false); insertAfter(i + 1, { type: "p", text: "" }, true); }
        changeSoon();
      } catch (err) { if (PR.toast) PR.toast(esc(err.message)); }
    }

    /* ---------- 選取 ---------- */
    function select(id, add) {
      if (state.editing) stopEdit();
      if (!add) state.selected.clear();
      if (add && state.selected.has(id) && state.selected.size > 1) state.selected.delete(id); else state.selected.add(id);
      state.anchor = state.head = id;
      render();
    }
    /* 從第 a 塊選到第 b 塊（a 是起點，⇧ 方向鍵從 b 那一頭繼續伸縮） */
    function selectRange(a, b) {
      a = Math.max(0, Math.min(state.blocks.length - 1, a)); b = Math.max(0, Math.min(state.blocks.length - 1, b));
      const ids = state.blocks.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
      const same = ids.length === state.selected.size && ids.every((x) => state.selected.has(x));
      state.anchor = state.blocks[a].id; state.head = state.blocks[b].id;
      if (same && !state.editing) return;
      if (state.editing) stopEdit();
      state.selected = new Set(ids);
      render();
    }
    function selectedRange() {
      const is = state.blocks.map((b, i) => (state.selected.has(b.id) ? i : -1)).filter((i) => i >= 0);
      if (!is.length) return null;
      return { from: Math.min(...is), to: Math.max(...is) };
    }
    function selectedBlocks() { return state.blocks.filter((b) => state.selected.has(b.id)); }
    function deleteSelected() {
      const r = selectedRange(); if (!r) return;
      snapshot();
      state.blocks = state.blocks.filter((b) => !state.selected.has(b.id));
      if (!state.blocks.length) state.blocks = [{ id: bid(), type: "p", text: "" }];
      state.selected.clear(); state.anchor = state.head = null;
      const next = state.blocks[Math.min(r.from, state.blocks.length - 1)];
      if (next && next.type !== "divider" && next.type !== "image") { state.editing = next.id; render(); focusEdit(next.id, "start"); }
      else if (next) select(next.id);
      else render();
      changeSoon();
    }
    function duplicateSelected() {
      const r = selectedRange(); if (!r) return;
      snapshot();
      const copy = state.blocks.slice(r.from, r.to + 1).map((b) => Object.assign({}, b, { id: bid() }));
      state.blocks.splice(r.to + 1, 0, ...copy);
      state.selected = new Set(copy.map((b) => b.id)); state.anchor = copy[0].id; state.head = copy[copy.length - 1].id;
      render(); changeSoon();
    }
    function moveBlocks(from, to, before) {  // 把 from..to 這一段搬到 before 這塊前面（before 是 index，可能是 length）
      const r = selectedRange() && state.selected.has(state.blocks[from].id) ? selectedRange() : { from, to };
      if (before >= r.from && before <= r.to + 1) return;
      snapshot();
      const chunk = state.blocks.splice(r.from, r.to - r.from + 1);
      const at = before > r.to ? before - chunk.length : before;
      state.blocks.splice(at, 0, ...chunk);
      state.selected = new Set(chunk.map((b) => b.id)); state.anchor = chunk[0].id; state.head = chunk[chunk.length - 1].id;
      render(); changeSoon();
    }
    function moveSelected(where) {  // "up" | "down" | "top" | "bottom"
      const r = selectedRange(); if (!r) return;
      const before = where === "up" ? r.from - 1 : where === "down" ? r.to + 2 : where === "top" ? 0 : state.blocks.length;
      if (before < 0 || before > state.blocks.length) return;
      moveBlocks(r.from, r.to, before);
      const el = blockEl(state.blocks[selectedRange().from].id); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function selectedMarkdown() { const r = selectedRange(); return r ? serialize(state.blocks.slice(r.from, r.to + 1)) : ""; }
    function copySelected(cut) {
      const md = selectedMarkdown(); if (!md) return;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(md).then(() => { if (PR.toast && !cut) PR.toast(t("已複製"), null, 1200); }).catch(() => {});
      if (cut) deleteSelected();
    }
    function insertBlocks(at, nb) {  // 在第 at 塊後面放進幾塊，選起來
      if (!nb.length) return;
      state.blocks.splice(at + 1, 0, ...nb);
      state.selected = new Set(nb.map((b) => b.id)); state.anchor = nb[0].id; state.head = nb[nb.length - 1].id;
      state.editing = null;
      render(); changeSoon();
    }
    /* 區塊的選單（點把手、或在區塊上按右鍵）：轉成別種、複製、搬、刪——Craft「操作」那一排 */
    function blockMenu(at) {
      if (!PR.menu) return;
      const r = selectedRange(); if (!r) return;
      const b = state.blocks[r.from], single = r.from === r.to;
      const kinds = [["p", "pilcrow", "type", t("內文")], ["h1", "h1", "bigger", t("大標題")], ["h2", "h2", "bigger", t("副標題")], ["h3", "h3", "bigger", t("標題")], ["bullet", "bullets", "log", t("項目清單")],
        ["number", "numbers", "list", t("編號清單")], ["todo", "todo", "check", t("待辦")], ["toggle", "caret", "chevron", t("收合")], ["quote", "quote", "quote", t("引用")], ["note", "callout", "info", t("說明框")], ["code", "codeblock", "template", t("程式碼")]];
      const cur = single ? kindOf(b) : "";
      const canType = state.blocks.slice(r.from, r.to + 1).some((x) => x.type !== "image" && x.type !== "divider");
      PR.menu(at, [
        canType ? { row: kinds.map(([k, a, alt, label]) => ({ icon: has(a) ? a : alt, title: label, on: cur === k, fn: () => convert(k) })) } : null,
        canType ? "-" : null,
        opts.noAi ? null : { label: t("問 AI 改這裡"), icon: "sparkle", kbd: "⌘↩", fn: () => emit("ai", r) },
        { label: t("複製"), icon: "copy", kbd: "⌘C", fn: () => copySelected(false) },
        { label: t("剪下"), icon: has("cut") ? "cut" : "copy", kbd: "⌘X", fn: () => copySelected(true) },
        { label: t("複製一份"), icon: has("duplicate") ? "duplicate" : "copy", kbd: "⌘D", fn: duplicateSelected },
        "-",
        { label: t("上移"), icon: has("up") ? "up" : "arrowUp", kbd: "⌥⌘↑", disabled: r.from === 0, fn: () => moveSelected("up") },
        { label: t("下移"), icon: has("down") ? "down" : "arrowUp", kbd: "⌥⌘↓", disabled: r.to >= state.blocks.length - 1, fn: () => moveSelected("down") },
        { label: t("移到最上面"), icon: has("top") ? "top" : "arrowUp", kbd: "⌥⇧⌘↑", disabled: r.from === 0, fn: () => moveSelected("top") },
        { label: t("移到最下面"), icon: has("bottom") ? "bottom" : "arrowUp", kbd: "⌥⇧⌘↓", disabled: r.to >= state.blocks.length - 1, fn: () => moveSelected("bottom") },
        opts.moveOut ? { label: t("移成新筆記"), icon: has("newdoc") ? "newdoc" : "note", fn: () => { const md = selectedMarkdown(); Promise.resolve(opts.moveOut(md)).then((ok) => { if (ok !== false) deleteSelected(); }); } } : null,
        "-",
        { label: t("刪除"), icon: "trash", kbd: "⌫", danger: true, fn: deleteSelected },
      ]);
    }

    /* 排好的表格上點到第幾列、第幾欄（表頭是第 0 列） */
    function tableCellAt(target) {
      const td = target && target.closest && target.closest("td, th");
      const tr = td && td.parentElement, table = tr && tr.closest("table");
      if (!td || !table) return null;
      return [Array.from(table.querySelectorAll("tr")).indexOf(tr), Array.from(tr.children).indexOf(td)];
    }
    /* ---------- 點哪裡游標就到哪裡 ---------- */
    const BLOCKY = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|UL|OL|PRE|TABLE|TR)$/;
    /* 排好的樣子裡，某個位置之前看得到的字（公式、圖片當成一個佔位字元；把手、清單記號、佔位的灰字不算） */
    function visibleBefore(scope, node, offset) {
      let out = "", done = false;
      (function walk(n) {
        if (done) return;
        if (n.nodeType === 3) { if (n === node) { out += n.nodeValue.slice(0, offset); done = true; } else out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        if (n.matches(".bk-gut, .bk-mark, .bk-ph, .bk-lang, .bk-page, .bk-ci, button, svg")) { if (n.contains(node)) done = true; return; }
        if (n.matches(".katex-display, .katex, img")) { if (n.contains(node) || n === node) done = true; else out += OBJ; return; }
        if (n.tagName === "BR") { out += "\n"; return; }
        if (BLOCKY.test(n.tagName) && n !== scope && out && !out.endsWith("\n") && n.closest(".bk-cb, .bk-quote, .bk-t") !== n.closest(".bk-b")) out += "\n";  // 說明框的標題和內文、引用的幾段：中間是一個換行
        const kids = n.childNodes;
        for (let k = 0; k < kids.length; k++) {
          if (n === node && k === offset) { done = true; return; }
          walk(kids[k]);
          if (done) return;
        }
        if (n === node) done = true;
      })(scope);
      return out;
    }
    /* 那個位置後面第一個看得到的字（沒有就是空字串） */
    function visibleNext(scope, node, offset) {
      let hit = false, out = "";
      (function walk(n) {
        if (out) return;
        if (n.nodeType === 3) {
          if (n === node) { hit = true; out = n.nodeValue.slice(offset, offset + 1); }
          else if (hit) out = n.nodeValue.slice(0, 1);
          return;
        }
        if (n.nodeType !== 1) return;
        if (n.matches(".bk-gut, .bk-mark, .bk-ph, .bk-lang, .bk-page, .bk-ci, button, svg")) { if (n.contains(node)) hit = true; return; }
        if (n.matches(".katex-display, .katex, img")) { if (n.contains(node) || n === node || hit) { hit = true; out = OBJ; } return; }
        const kids = n.childNodes;
        for (let k = 0; k < kids.length; k++) {
          if (n === node && k === offset) hit = true;
          walk(kids[k]);
          if (out) return;
        }
        if (n === node) hit = true;
      })(scope);
      return out;
    }
    function offsetAt(el, node, offset) {
      const b = state.blocks[idx(el.dataset.id)];
      if (!b || b.type === "math" || b.type === "divider" || b.type === "image") return null;
      if (!el.contains(node)) return null;
      try {
        if (useRich && RICH(b)) return Math.min(visibleBefore(el, node, offset).length, lenOf(b, b.text));  // 排好的那一格：看得到的第幾格就是第幾格
        return srcOffset(b.text || "", visibleBefore(el, node, offset), visibleNext(el, node, offset));
      } catch (e) { return null; }
    }
    function pointOffset(el, x, y) {
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      if (!range) return null;
      return offsetAt(el, range.startContainer, range.startOffset);
    }

    /* ---------- 事件 ---------- */
    root.addEventListener("keydown", onKey);
    root.addEventListener("keydown", cellKey);
    root.addEventListener("beforeinput", onBeforeInput);
    root.addEventListener("compositionstart", onBeforeInput);
    root.addEventListener("input", onInput);
    root.addEventListener("compositionend", (e) => { if (e.target.closest && e.target.closest(".bk-rich")) setTimeout(() => onInput({ target: e.target, type: "compositionend", data: e.data, isComposing: false }), 0); });
    root.addEventListener("focusout", (e) => {
      if (!e.target.closest || !e.target.closest(".bk-in, .bk-lang-in, .bk-cell")) return;
      setTimeout(() => {
        const a = document.activeElement;
        if (a && root.contains(a) && a.closest(".bk-b.editing, .bk-menu, .bk-pop")) return;  // 公式、連結的小編輯框也算在這一塊裡
        if (state.menu && a && a.closest && a.closest(".bk-menu")) return;
        if (PR.menuOpen && PR.menuOpen()) return;  // 開著選單（按了右鍵）：先別收
        stopEdit();
      }, 0);
    });
    /* 按著滑鼠拖過好幾塊：選那幾塊（像 Craft）。在同一塊裡拖還是選字 */
    let sweep = null, swept = false;
    let press = null;  // 滑鼠按下去的那一刻點在哪一塊的哪個字：等放開（click）時，正在編的那一塊可能已經收起來、版面動過了
    const indexAtY = (y) => {
      const els = list.querySelectorAll(".bk-b");
      let best = -1, dist = Infinity;
      for (let k = 0; k < els.length; k++) {
        const r = els[k].getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) return k;
        const d = y < r.top ? r.top - y : y - r.bottom;
        if (d < dist) { dist = d; best = k; }
      }
      return best;
    };
    function onSweep(e) {
      if (gone() || !sweep) return;
      if (!(e.buttons & 1)) { endSweep(); return; }
      const j = indexAtY(e.clientY);
      if (j < 0) return;
      if (!sweep.on) {
        if (sweep.from < 0) { if (Math.abs(e.clientY - sweep.y) < 6 && Math.abs(e.clientX - sweep.x) < 6) return; sweep.from = indexAtY(sweep.y); }
        else {
          if (j === sweep.from) return;
          const r = list.querySelectorAll(".bk-b")[j].getBoundingClientRect();
          if (e.clientY < r.top + Math.min(8, r.height / 3) || e.clientY > r.bottom - Math.min(8, r.height / 3)) return;  // 要真的拖進另一塊裡面才算（選字時稍微拖出去一點不算）
        }
        if (sweep.from < 0) { sweep = null; return; }
        sweep.on = true;
        root.classList.add("bk-sweeping");
        const s = window.getSelection && getSelection(); if (s) s.removeAllRanges();
      }
      e.preventDefault();
      selectRange(sweep.from, j);
    }
    function endSweep() {
      if (sweep && sweep.on) { root.classList.remove("bk-sweeping"); swept = true; setTimeout(() => { swept = false; }, 0); }
      sweep = null;
    }
    document.addEventListener("mousemove", onSweep);
    document.addEventListener("mouseup", endSweep);
    root.addEventListener("mousedown", (e) => {
      const mi = e.target.closest(".bk-mi");
      if (mi && mi.dataset.mk != null) { e.preventDefault(); pickMention(+mi.dataset.mk); return; }
      if (state.mention) closeMention();  // 點到別的地方（游標換位置了）：「@」清單收起來
      if (mi) { e.preventDefault(); pickMenu(mi.dataset.k); return; }
      if (e.target.closest(".bk-b.editing .bk-mark.todo, .bk-add, .bk-gadd")) { e.preventDefault(); return; }  // 別把輸入框的焦點搶走
      const h = e.target.closest(".bk-handle");
      if (h) {  // 把手：按下去就選這一塊（⇧ 連選、⌘ 加選）；放開沒拖動才開選單（click 那邊）
        const id = h.closest(".bk-b").dataset.id;
        if (e.shiftKey && state.selected.size) { const r = selectedRange(), i = idx(id), a = state.anchor ? idx(state.anchor) : r.from; selectRange(a >= 0 ? a : r.from, i); }
        else if (e.metaKey || e.ctrlKey) select(id, true);
        else if (!state.selected.has(id)) select(id);
        else if (state.editing) stopEdit();
        return;
      }
      press = null;
      if (e.button !== 0 || e.target.closest(".bk-gut, .bk-menu, .bk-tools, .bk-preview, button, a, input")) return;
      const el = e.target.closest(".bk-b");
      sweep = { from: el ? idx(el.dataset.id) : -1, x: e.clientX, y: e.clientY, on: false };
      if (el && state.editing !== el.dataset.id && !e.shiftKey) press = { id: el.dataset.id, x: e.clientX, y: e.clientY, at: pointOffset(el, e.clientX, e.clientY), obj: !!e.target.closest("img, .katex-display, .bk-fig"), ct: !!e.target.closest(".bk-ct"), cell: tableCellAt(e.target) };
    });
    /* 點了編輯器外面：選著的區塊放掉（不然之後在別處按 Backspace、方向鍵會動到它們）。筆記 AI、格式面板（.bk-keep）要用選取，不算外面 */
    function onDocDown(e) {
      if (gone() || !state.selected.size || state.editing || root.contains(e.target)) return;
      if (e.target.closest && e.target.closest("#ctxmenu, .nai, .bk-keep, .dialog-backdrop")) return;
      state.selected.clear(); state.anchor = state.head = null;
      render();
    }
    document.addEventListener("mousedown", onDocDown);
    root.addEventListener("contextmenu", (e) => {
      const cell = e.target.closest(".bk-cell");
      if (cell && getSelection().isCollapsed) { e.preventDefault(); cellMenu(cell, { x: e.clientX, y: e.clientY }); return; }  // 表格的一格：插入／刪除列、欄
      const el = e.target.closest(".bk-b");
      if (!el || !PR.menu || e.target.closest(".bk-preview, a")) return;
      const ta = e.target.closest(".bk-in");
      if (ta && (ta.tagName === "TEXTAREA" ? ta.selectionStart !== ta.selectionEnd : !getSelection().isCollapsed)) return;  // 選著字按右鍵：留給系統（複製、查詢）
      e.preventDefault();
      const id = el.dataset.id;
      if (!state.selected.has(id) || state.editing) select(id);
      blockMenu({ x: e.clientX, y: e.clientY });
    });
    root.addEventListener("click", (e) => {
      if (swept) return;
      const act = e.target.closest("[data-bk]");
      if (act) {
        const k = act.dataset.bk, el = act.closest(".bk-b"), id = el && el.dataset.id, i = id ? idx(id) : -1, b = i >= 0 ? state.blocks[i] : null;
        if (k === "toggle-todo" && b) {
          e.preventDefault(); snapshot(); b.checked = !b.checked; changeSoon();
          if (state.editing === id) { act.classList.toggle("on", b.checked); const rich = el.querySelector(".bk-rich"); if (rich) rich.classList.toggle("done", !!b.checked); el._sig = sigOf(b, i); } else repaint(id);  // 正在編：只換那顆勾，輸入框不動
          return;
        }
        if (k === "toggle-open" && b) { e.preventDefault(); b.open = !b.open; repaint(id); return; }
        if ((k === "grid-row" || k === "grid-col") && b && el) {  // 表格旁邊的「＋」：最後加一列／一欄
          e.preventDefault();
          const rows = el.querySelectorAll(".bk-gt tr").length, cols = el.querySelectorAll(".bk-gt tr")[0].querySelectorAll(".bk-cell").length;
          if (k === "grid-row") gridShape(id, (g) => g.rows.push(Array(cols).fill("")), [rows, 0]);
          else gridShape(id, (g) => { g.rows.forEach((r) => r.push("")); g.align.push(""); }, [0, cols]);
          return;
        }
        if (k === "go" && b && opts.refs && opts.refs.go) { e.preventDefault(); opts.refs.go(b.args.split(/\s+/)[0]); return; }
        if (k === "add" && b) {  // 左邊的「＋」：下面（⌥：上面）多一塊空的，順便開區塊選單
          e.preventDefault(); if (state.editing) stopEdit(); snapshot();
          const nb = insertAfter(e.altKey ? i - 1 : i, { type: "p", text: "" }, true);
          openMenu(nb.id, "");
          return;
        }
        if (k === "tail") { const last = state.blocks[state.blocks.length - 1]; if (last && last.type === "p" && !last.text) startEdit(last.id, "end"); else insertAfter(state.blocks.length - 1, { type: "p", text: "" }, true); return; }
        if (k === "pv-accept") { api.acceptPreview(); return; }
        if (k === "pv-reject") { api.rejectPreview(); return; }
        if (k === "pv-stop") { if (state.preview && state.preview.stop) state.preview.stop(); return; }
      }
      const h = e.target.closest(".bk-handle");
      if (h) { if (!e.shiftKey && !e.metaKey && !e.ctrlKey && state.selected.size) blockMenu(h); return; }
      if (e.target.closest("a, button, input, textarea, .bk-gut, .bk-preview, .bk-menu, .bk-tools")) return;
      const hit = press && Math.abs(e.clientX - press.x) < 5 && Math.abs(e.clientY - press.y) < 5 ? press : null;  // 沒拖動：以按下去那一刻為準
      press = null;
      const el = (hit && blockEl(hit.id)) || e.target.closest(".bk-b");
      // 在排好的字上拖著選了一段：同一塊裡 → 進編輯、選那一段（上面浮出格式工具列）
      const sel = window.getSelection && getSelection();
      if (sel && !sel.isCollapsed && el && el.contains(sel.anchorNode) && el.contains(sel.focusNode) && state.editing !== el.dataset.id) {
        const a = offsetAt(el, sel.anchorNode, sel.anchorOffset), z = offsetAt(el, sel.focusNode, sel.focusOffset);
        if (a != null && z != null && a !== z) { startEdit(el.dataset.id, { from: Math.min(a, z), to: Math.max(a, z) }); return; }
      }
      if (!el) {
        if (e.target === list || e.target === root) { const last = state.blocks[state.blocks.length - 1]; if (last && last.type === "p" && !last.text) startEdit(last.id); else insertAfter(state.blocks.length - 1, { type: "p", text: "" }, true); }
        return;
      }
      const b = state.blocks[idx(el.dataset.id)];
      if (!b) return;
      if (e.shiftKey && (state.selected.size || state.editing)) {  // ⇧ 點另一塊：從現在這塊連選到那一塊
        const a = state.anchor ? idx(state.anchor) : state.editing ? idx(state.editing) : -1;
        if (a >= 0) { selectRange(a, idx(b.id)); return; }
      }
      if (b.type === "divider") { select(b.id); return; }
      if (state.editing === el.dataset.id) return;
      // 圖片、獨立的公式、畫出來的圖：點一下是選起來（好刪、好搬），點兩下才改原始碼
      if ((hit ? hit.obj : !!e.target.closest("img, .katex-display, .bk-fig")) && e.detail < 2) { select(b.id); return; }
      if (b.type === "callout" && b.kind === "ref" && !(hit ? hit.ct : e.target.closest(".bk-ct"))) { return; }
      if (b.type === "table" && useRich) { startEdit(el.dataset.id, { cell: (hit ? hit.cell : tableCellAt(e.target)) || [0, 0] }); return; }  // 表格：點哪一格就編哪一格
      const at = hit ? hit.at : pointOffset(el, e.clientX, e.clientY);
      startEdit(el.dataset.id, at == null ? "end" : at);
    });
    /* 選著區塊（沒在打字）時的鍵盤：整份文件只有一個編輯器收（焦點在別的輸入框就不管） */
    const owns = (e) => state.selected.size && !state.editing && root.isConnected && !(e.target.closest && e.target.closest("input, textarea, select, [contenteditable], .dialog-backdrop.open"));
    function onDocKey(e) {
      if (gone() || !owns(e) || (PR.menuOpen && PR.menuOpen())) return;
      const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase(), r = selectedRange();
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSelected(); }
      else if (e.key === "Escape") { state.selected.clear(); state.anchor = state.head = null; render(); }
      else if (e.key === "Enter" && mod) { e.preventDefault(); emit("ai", r); }
      else if (e.key === "Enter") { e.preventDefault(); const b = state.blocks[r.from]; if (b.type !== "divider") startEdit(b.id, "end"); }
      else if (e.key === " ") { e.preventDefault(); snapshot(); insertAfter(e.shiftKey ? r.from - 1 : r.to, { type: "p", text: "" }, true); }  // Craft：空白鍵在下面插一塊、⇧空白在上面
      else if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && key === "y") { e.preventDefault(); redo(); }
      else if (mod && key === "d") { e.preventDefault(); duplicateSelected(); }
      else if (mod && key === "a") { e.preventDefault(); selectRange(0, state.blocks.length - 1); }
      else if (e.key === "Tab") {
        e.preventDefault(); snapshot();
        selectedBlocks().forEach((b) => { if (b.type === "list") b.indent = Math.max(0, Math.min(4, (b.indent || 0) + (e.shiftKey ? -1 : 1))); });
        render(); changeSoon();
      }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const up = e.key === "ArrowUp";
        e.preventDefault();
        if (e.altKey || (mod && e.altKey)) { moveSelected(e.shiftKey ? (up ? "top" : "bottom") : (up ? "up" : "down")); return; }
        if (e.shiftKey) {  // ⇧ 方向鍵：從起點往外伸、往回縮
          const a = state.anchor ? idx(state.anchor) : r.from, h = state.head ? idx(state.head) : r.to;
          selectRange(a < 0 ? r.from : a, Math.max(0, Math.min(state.blocks.length - 1, (h < 0 ? r.to : h) + (up ? -1 : 1))));
        } else {
          const i = up ? Math.max(0, r.from - 1) : Math.min(state.blocks.length - 1, r.to + 1);
          select(state.blocks[i].id);
        }
        const el = blockEl(state.head || state.blocks[r.from].id); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      }
      else if (!mod && !e.altKey && e.key.length === 1 && r.from === r.to && INLINE(state.blocks[r.from])) { startEdit(state.blocks[r.from].id, "end"); }  // 直接打字：接在這一塊後面寫
    }
    function onDocCopy(e) {
      if (gone() || !owns(e)) return;
      const md = selectedMarkdown(); if (!md || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", md);
      e.preventDefault();
      if (e.type === "cut") deleteSelected();
    }
    function onDocPaste(e) {
      if (gone() || !owns(e) || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.items || []).filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
      const r = selectedRange();
      if (files.length && opts.upload) { e.preventDefault(); putImage(state.blocks[r.to].id, files[0]); return; }
      const text = e.clipboardData.getData("text/plain");
      if (!text.trim()) return;
      e.preventDefault(); snapshot();
      insertBlocks(r.to, parse(text));
    }
    document.addEventListener("keydown", onDocKey);
    document.addEventListener("copy", onDocCopy);
    document.addEventListener("cut", onDocCopy);
    document.addEventListener("paste", onDocPaste);
    // 拖把手換順序：插入線跟著滑鼠走
    list.addEventListener("dragstart", (e) => {
      const h = e.target.closest(".bk-handle"); if (!h) return;
      const id = h.closest(".bk-b").dataset.id;
      if (!state.selected.has(id)) select(id);
      if (PR.closeMenu) PR.closeMenu();
      state.drag = { id };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", selectedMarkdown()); } catch (err) { /* 有些環境不給設 */ }
      list.querySelectorAll(".bk-b.sel").forEach((x) => x.classList.add("dragging"));
    });
    /* 別處拖過來的一段 Markdown（閱讀頁選的字：引文＋出處，見 reader/excerpt.js）：插入線一樣跟著滑鼠走，放在哪一塊旁邊就插在哪裡 */
    const EXCERPT = "application/x-foli-excerpt";
    const bringsExcerpt = (e) => !state.drag && !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(EXCERPT);
    const clearDrop = () => list.querySelectorAll(".bk-b.drop-before, .bk-b.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    list.addEventListener("dragleave", (e) => { if (!state.drag && !list.contains(e.relatedTarget)) clearDrop(); });
    list.addEventListener("dragover", (e) => {
      if (!state.drag && !bringsExcerpt(e)) return;
      e.preventDefault();
      if (!state.drag) e.dataTransfer.dropEffect = "copy";
      const k = indexAtY(e.clientY), els = list.querySelectorAll(".bk-b"), el = els[k];
      list.querySelectorAll(".bk-b.drop-before, .bk-b.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
    });
    list.addEventListener("drop", (e) => {
      if (!state.drag) {
        const md = bringsExcerpt(e) ? e.dataTransfer.getData(EXCERPT) : "";
        if (!md) return;
        e.preventDefault();
        const t = list.querySelector(".bk-b.drop-before, .bk-b.drop-after");
        const at = t ? idx(t.dataset.id) - (t.classList.contains("drop-before") ? 1 : 0) : state.blocks.length - 1;
        clearDrop();
        if (state.editing) pullText(state.editing);
        snapshot();
        const nb = parse(md);
        nb.forEach((b, k) => state.blocks.splice(at + 1 + k, 0, b));
        render(); changeSoon.flush();
        nb.forEach((b) => { const el = blockEl(b.id); if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); } });  // 亮一下：放進來的是這幾塊
        return;
      }
      e.preventDefault();
      const target = list.querySelector(".bk-b.drop-before, .bk-b.drop-after");
      const from = idx(state.drag.id);
      state.drag = null;
      list.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((x) => { if (x !== target) x.classList.remove("dragging", "drop-before", "drop-after"); });
      if (!target) { render(); return; }
      const ti = idx(target.dataset.id), before = target.classList.contains("drop-before") ? ti : ti + 1;
      target.classList.remove("dragging", "drop-before", "drop-after");
      const r = selectedRange() || { from, to: from };
      moveBlocks(r.from, r.to, before);
      render();
    });
    list.addEventListener("dragend", () => { state.drag = null; list.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((x) => x.classList.remove("dragging", "drop-before", "drop-after")); });
    // 貼上：圖片 → 上傳成一塊；網址貼在選起來的字上 → 變連結；一次貼好幾段 → 拆成區塊。
    // 排好的那一格：別處複製來的格式（網頁、Word、Google 文件的粗體、標題、清單、表格）照樣留下來（richtext.js 的 fromHtml）；
    // 純文字先整理（PDF 的斷行、斷字、中文字之間的空白，• 開頭的變清單，Tab 分開的變表格）；從這個編輯器自己複製的直接用它的 Markdown
    const MD_TYPE = "application/x-foli-md";
    root.addEventListener("copy", (e) => onRichCopy(e, false));
    root.addEventListener("cut", (e) => onRichCopy(e, true));
    function onRichCopy(e, cut) {
      const el = e.target.closest && e.target.closest(".bk-rich");
      if (!el || !e.clipboardData) return;
      const c = PR.rich.caret(el);
      if (!c || c.start === c.end) return;
      const md = PR.rich.slice(el, c.start, c.end);
      e.clipboardData.setData("text/plain", md.replace(/\\([*\x60$~+=\[\]#>\-])/g, "$1"));
      e.clipboardData.setData(MD_TYPE, md);
      const box = document.createElement("div"); box.innerHTML = PR.rich.html(md); e.clipboardData.setData("text/html", box.innerHTML);
      e.preventDefault();
      if (cut) { typingSnapshot(el.closest(".bk-b").dataset.id); document.execCommand("delete"); onInput({ target: el }); }
    }
    root.addEventListener("paste", (e) => {
      const cell = e.target.closest && e.target.closest(".bk-cell");
      if (cell && e.clipboardData) {  // 表格的一格：一般的字就地放；試算表複製來的（Tab、換行分開）從這一格開始往右下填
        e.preventDefault();
        const text = (e.clipboardData.getData("text/plain") || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
        if (!text) return;
        const id = cell.closest(".bk-b").dataset.id;
        typingSnapshot(id);
        if (!/[\t\n]/.test(text)) { document.execCommand("insertText", false, text); cellInput(cell); return; }
        const [r0, c0] = cellPos(cell), data = text.split("\n").map((l) => l.split("\t"));
        gridShape(id, (g) => {
          for (let r = 0; r < data.length; r++) {
            while (g.rows.length <= r0 + r) g.rows.push(Array(g.rows[0].length).fill(""));
            for (let c = 0; c < data[r].length; c++) {
              while (g.rows[0].length <= c0 + c) { g.rows.forEach((row) => row.push("")); g.align.push(""); }
              g.rows[r0 + r][c0 + c] = PR.rich.emit([{ t: data[r][c].trim(), m: [] }]);
            }
          }
        }, [r0 + data.length - 1, c0 + data[data.length - 1].length - 1]);
        return;
      }
      const ta = e.target.closest && e.target.closest(".bk-in");
      if (!ta || !e.clipboardData) return;
      const id = ta.closest(".bk-b").dataset.id, i = idx(id), b = state.blocks[i], f = fieldOf(id);
      const files = Array.from(e.clipboardData.items || []).filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
      if (files.length && opts.upload) { e.preventDefault(); pullText(id); putImage(id, files[0]); return; }
      const text = (e.clipboardData.getData("text/plain") || "").replace(/\r\n?/g, "\n");
      if (!b || !f) return;
      if (!f.rich) {
        if (!text) return;
        if (INLINE(b) && ta.selectionStart !== ta.selectionEnd && /^https?:\/\/\S+$/.test(text.trim())) { e.preventDefault(); wrap(ta, "[", "](" + text.trim() + ")"); return; }
        if (!INLINE(b) || !/\n/.test(text.trim())) return;
        const nb = parse(text);
        if (nb.length < 2) return;
        e.preventDefault();
        splitPaste(id, i, b, f, nb);
        return;
      }
      e.preventDefault();
      typingSnapshot(id);
      const c = f.caret();
      if (c.start !== c.end && /^https?:\/\/\S+$/.test(text.trim())) { if (PR.rich.link(ta, text.trim())) onInput({ target: ta }); return; }  // 網址貼在選起來的字上：變連結
      const own = e.clipboardData.getData(MD_TYPE), html = e.clipboardData.getData("text/html");
      const md = own || (html && !/^\s*$/.test(html) ? PR.rich.fromHtml(html) : "") || PR.rich.cleanPaste(text);
      if (!md.trim()) return;
      const nb = parse(md);
      if (nb.length === 1 && nb[0].type === "p" || !INLINE(b) && b.type !== "quote" && b.type !== "callout") {  // 一段字：就地放進去（保留樣式）
        const one = nb.length === 1 && nb[0].type === "p" ? nb[0].text : md.replace(/\n{2,}/g, "\n");
        document.execCommand("insertHTML", false, PR.rich.html(one));
        PR.rich.tidy(ta);
        onInput({ target: ta });
        return;
      }
      if (!INLINE(b)) { document.execCommand("insertHTML", false, PR.rich.html(md.replace(/\n{2,}/g, "\n"))); onInput({ target: ta }); return; }
      splitPaste(id, i, b, f, nb);
    });
    /* 好幾段貼進一塊的中間：游標前面的字接第一段、後面的字接最後一段 */
    function splitPaste(id, i, b, f, nb) {
      snapshot();
      const before = f.before(), after = f.after();
      const plainBefore = f.rich ? PR.rich.plainOf(before) : before;
      let first = 0;
      if (plainBefore.trim()) { b.text = nb[0].type === "p" ? joinMd(b, before, nb[0].text) : before; if (nb[0].type === "p") first = 1; }
      else { state.blocks[i] = Object.assign({}, nb[0], { id }); first = 1; }
      const rest = nb.slice(first);
      state.blocks.splice(i + 1, 0, ...rest);
      const at = i + rest.length;
      let last = state.blocks[at], col = 0;
      if (INLINE(last)) { col = lenOf(last, last.text); last.text = joinMd(last, last.text, after); }
      else if ((f.rich ? PR.rich.plainOf(after) : after).trim()) { last = { id: bid(), type: "p", text: after }; state.blocks.splice(at + 1, 0, last); }
      else { last = { id: bid(), type: "p", text: "" }; state.blocks.splice(at + 1, 0, last); }
      state.editing = last.id;
      render(); focusEdit(last.id, col); changeSoon();
    }

    /* ---------- 公式、連結的小編輯框（排好的那一格裡） ---------- */
    let pop = null;
    function closePop(commit) { if (pop) { const p = pop; pop = null; p.done(commit); p.el.remove(); } }
    function popAt(anchorRect, html) {
      const el = document.createElement("div");
      el.className = "bk-pop";
      el.innerHTML = html;
      root.append(el);
      const rr = root.getBoundingClientRect();
      el.style.top = (anchorRect.bottom - rr.top + 6) + "px";
      el.style.left = Math.max(0, Math.min(anchorRect.left - rr.left, root.clientWidth - el.offsetWidth - 4)) + "px";
      return el;
    }
    /* 公式：上面打 TeX、下面即時排；Enter 收、Esc 不改；清空就是拿掉 */
    function texPop(f, atom) {
      closePop(false);
      const id = f.el.closest(".bk-b").dataset.id;
      const el = popAt(atom.getBoundingClientRect(), '<input class="bk-pop-in" spellcheck="false" placeholder="' + esc(t("TeX，例如 \\frac{a}{b}")) + '" value="' + esc(atom.dataset.tex || "") + '"><div class="bk-pop-live"></div>');
      const input = el.querySelector("input"), live = el.querySelector(".bk-pop-live");
      const draw = () => { live.innerHTML = input.value.trim() ? PR.rich.texHtml(input.value) : ""; };
      draw();
      input.addEventListener("input", draw);
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); closePop(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(false); }
      });
      input.addEventListener("blur", () => setTimeout(() => { if (pop && pop.el === el) closePop(true); }, 0));
      pop = { el, done(commit) {
        const blk = blockEl(id);
        if (!blk || !blk.contains(atom)) return;
        typingSnapshot(id);
        let next = atom;
        if (commit) {
          const v = input.value.trim();
          if (v) next = PR.rich.setTex(atom, v); else { next = null; atom.remove(); }
        } else if (!atom.dataset.tex) { next = null; atom.remove(); }  // 新放的、還沒寫：拿掉
        onInput({ target: f.el });
        f.el.focus();
        const r = document.createRange();
        if (next && next.parentNode) { r.setStartAfter(next); r.collapse(true); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      } };
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    /* 連結：選的字變成連結；游標在連結裡就是改網址、或拿掉 */
    function linkPop(f) {
      closePop(false);
      const id = f.el.closest(".bk-b").dataset.id, saved = f.caret(), a = PR.rich.linkAt(f.el);
      if (!a && saved.start === saved.end) { if (PR.toast) PR.toast(t("先選起要變成連結的字")); return; }
      const sel = getSelection(), rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : f.el.getBoundingClientRect();
      const el = popAt(rect, '<input class="bk-pop-in" spellcheck="false" placeholder="' + esc(t("貼上網址（https://…）")) + '" value="' + esc(a ? a.dataset.href || "" : "") + '">' +
        (a ? '<button type="button" class="bk-pop-x" data-unlink>' + esc(t("拿掉連結")) + "</button>" : ""));
      const input = el.querySelector("input");
      const apply = (url) => { f.el.focus(); f.setCaret(saved.start, saved.end); typingSnapshot(id); if (PR.rich.link(f.el, url)) onInput({ target: f.el }); };
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); const url = input.value.trim(); closePop(false); if (url) apply(/^(https?:\/\/|\/(read|note)\/)/.test(url) ? url : "https://" + url); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(false); f.el.focus(); f.setCaret(saved.start, saved.end); }
      });
      el.addEventListener("mousedown", (e) => { if (e.target.closest("[data-unlink]")) { e.preventDefault(); closePop(false); apply(""); } });
      input.addEventListener("blur", () => setTimeout(() => { if (pop && pop.el === el) closePop(false); }, 0));
      pop = { el, done() {} };
      setTimeout(() => input.focus(), 0);
    }
    /* 排好的那一格裡點公式：開小編輯框 */
    root.addEventListener("click", (e) => {
      const atom = e.target.closest && e.target.closest(".bk-rich .rt-tex");
      if (!atom) return;
      const f = fieldOf(atom.closest(".bk-b").dataset.id);
      if (f) { e.preventDefault(); e.stopPropagation(); texPop(f, atom); }
    }, true);

    /* ---------- 對外 ---------- */
    const plain = (s) => (PR.plain ? PR.plain(s) : String(s || "").replace(/[*_\x60~=$#>\[\]]/g, ""));
    const api = {
      getValue() { if (state.editing) pullText(state.editing); return getValue(); },
      setValue(md) {
        if (state.editing) pullText(state.editing);
        const cur = getValue();
        if (md === cur) { state.pendingValue = null; return; }
        // 外面拿來的是自己上一次交出去的內容（存檔還在去抖、還沒跟上後來打的字）：不是外面改了，不理它——不然剛打的字會被舊的蓋回去
        if (state.saved != null && md === state.saved) return;
        if (state.editing) { state.pendingValue = md; state.pendingBase = cur; return; }  // 正在打字：等停下來再換（見 stopEdit）
        load(md, false);
      },
      root,
      rebind(fn) { opts.onChange = fn; },
      focus(at) { const b = at === "start" ? state.blocks[0] : state.blocks[state.blocks.length - 1]; if (b) { if (b.type === "divider" || b.type === "image") insertAfter(at === "start" ? -1 : state.blocks.length - 1, { type: "p", text: "" }, true); else startEdit(b.id, at === "start" ? "start" : "end"); } },
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
        if (!r && state.editing) { pullText(state.editing); const i = idx(state.editing); r = { from: i, to: i }; }
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
        state.anchor = nb.length ? nb[0].id : null; state.head = nb.length ? nb[nb.length - 1].id : null;
        render(); changeSoon.flush();
        emit("accept", p);
      },
      rejectPreview() { const p = state.preview; state.preview = null; render(); emit("reject", p); },
      askAi(i) { emit("ai", { from: i, to: i }); },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; },
      select(i) { const b = state.blocks[i]; if (b) select(b.id); },
      selectAll() { if (state.blocks.length) selectRange(0, state.blocks.length - 1); },
      count: () => state.blocks.length,
      /* ---- 給外面的面板用（目錄、格式、插入、資訊） ---- */
      outline() { return state.blocks.map((b, i) => (b.type === "heading" ? { id: b.id, i, level: b.level, text: plain(state.editing === b.id && fieldOf(b.id) ? fieldOf(b.id).value() : b.text) } : null)).filter(Boolean); },
      reveal(id) {
        const el = blockEl(id); if (!el) return;
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1200);
      },
      blockAt(y) { const k = indexAtY(y); return k >= 0 && state.blocks[k] ? state.blocks[k].id : null; },
      elOf: (id) => blockEl(id),
      stats() {
        const md = api.getValue();
        const text = md.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60|\$\$[\s\S]*?\$\$/g, " ").replace(/!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_~=\x60|\-\[\]]/g, " ");
        const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
        const latin = (text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, " ").match(/[A-Za-z0-9\u00c0-\u024f]+(?:['\u2019.-][A-Za-z0-9]+)*/g) || []).length;
        const todos = state.blocks.filter((b) => b.type === "list" && b.kind === "todo");
        return { blocks: state.blocks.length, words: cjk + latin, chars: text.replace(/\s/g, "").length, todo: todos.length, done: todos.filter((b) => b.checked).length, headings: state.blocks.filter((b) => b.type === "heading").length };
      },
      current() {  // 現在動的是哪幾塊、什麼種類（格式面板要亮哪一顆）
        const r = selectedRange();
        const ids = state.editing ? [state.editing] : r ? state.blocks.slice(r.from, r.to + 1).map((b) => b.id) : [];
        const bs = ids.map((id) => state.blocks[idx(id)]).filter(Boolean);
        const kinds = Array.from(new Set(bs.map(kindOf)));
        return { editing: state.editing, ids, kind: kinds.length === 1 ? kinds[0] : "", indent: bs.length ? Math.min(...bs.map((b) => b.indent || 0)) : 0, list: bs.length > 0 && bs.every((b) => b.type === "list"), count: bs.length };
      },
      convert(k) { convert(k); },
      inline(mark) {  // 粗體、斜體…：正在編的那一塊裡選起來的字（排好的那一格直接改樣子；輸入框包上記號）
        const cell = document.activeElement && document.activeElement.closest && document.activeElement.closest(".bk-b.editing .bk-cell");
        if (cell && root.contains(cell)) { const k = MARK_OF[mark]; if (!k) return false; typingSnapshot(state.editing); if (PR.rich.toggle(cell, k)) cellInput(cell); return true; }  // 表格的一格
        const f = state.editing && fieldOf(state.editing);
        if (!f) return false;
        if (!f.rich) { if (mark === "link") wrap(f.el, "[", "](url)"); else wrap(f.el, mark); return true; }
        if (mark === "link") { linkPop(f); return true; }
        if (mark === "$") { const sel = getSelection(); const empty = !sel.rangeCount || sel.isCollapsed; typingSnapshot(state.editing); const atom = PR.rich.insertTex(f.el); onInput({ target: f.el }); if (atom && empty) texPop(f, atom); return true; }
        return markRich(f, MARK_OF[mark] || mark);
      },
      activeMarks() { const f = state.editing && fieldOf(state.editing); return f && f.rich ? PR.rich.active(f.el) : []; },
      indent(d) {
        const bs = state.editing ? [state.blocks[idx(state.editing)]] : selectedBlocks();
        if (!bs.some((b) => b && b.type === "list")) return;
        if (state.editing) pullText(state.editing);
        snapshot();
        bs.forEach((b) => { if (b && b.type === "list") b.indent = Math.max(0, Math.min(4, (b.indent || 0) + d)); });
        const at = state.editing && fieldOf(state.editing) ? fieldOf(state.editing).caret().start : null;
        if (state.editing) { repaint(state.editing); focusEdit(state.editing, at); } else render();
        changeSoon();
      },
      insertBlock(k) {  // 在現在這一塊（或選起來的最後一塊、或最後面）下面加一塊 k
        let i = state.editing ? idx(state.editing) : selectedRange() ? selectedRange().to : state.blocks.length - 1;
        const cur = state.blocks[i];
        if (state.editing) pullText(state.editing);
        snapshot();
        if (k === "image") { const id = cur && cur.type === "p" && !(cur.text || "").trim() ? cur.id : insertAfter(i, { type: "p", text: "" }, false).id; pickImage(id); return; }
        if (k === "ai") { if (state.editing) stopEdit(); const nb = cur && cur.type === "p" && !(cur.text || "").trim() ? cur : insertAfter(i, { type: "p", text: "" }, false); api.askAi(idx(nb.id)); return; }
        if (cur && cur.type === "p" && !(cur.text || "").trim()) { setType(cur.id, k); return; }  // 現在這塊是空的：直接換成它
        state.editing = null; state.selected.clear();
        const nb = insertAfter(i, { type: "p", text: "" }, false);
        setType(nb.id, k);
        const el = blockEl(nb.id); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      },
      menuFor(at) { blockMenu(at); },
      remove() { deleteSelected(); },
      duplicate() { duplicateSelected(); },
      move(where) { moveSelected(where); },
      undo, redo,
      canUndo: () => state.history.length > 0, canRedo: () => state.future.length > 0,
      destroy() {
        changeSoon.flush();
        document.removeEventListener("selectionchange", placeTools);
        document.removeEventListener("mousemove", onSweep);
        document.removeEventListener("mouseup", endSweep);
        document.removeEventListener("mousedown", onDocDown);
        document.removeEventListener("keydown", onDocKey);
        document.removeEventListener("copy", onDocCopy);
        document.removeEventListener("cut", onDocCopy);
        document.removeEventListener("paste", onDocPaste);
        root.innerHTML = ""; root.classList.remove("bk");
      },
    };
    render();
    return api;
  };
})(window.PR);
