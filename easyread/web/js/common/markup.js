/* 行内标记：$TeX$ / \(TeX\)、**粗体**、*斜体*、`代码`、[n] 引用，以及“公式 (1) / 表 2 / 第 2.2 节 / 附录 A”这类交叉引用。
   译文、讨论、笔记都用同一套，用户编辑时看到的就是这套原始标记。
   筆記另外還認：# 標題（一到三個 # 字級不同）、~~刪除線~~、[文字](網址)、- [ ] 待辦，
   以及貼進筆記的圖片 ![](clips/…)（只認這份文件 clips/ 底下的圖，不會去載外面的網址）。 */
(function (PR) {
  "use strict";
  // 先识别代码和完整公式，避免分段、Markdown 和表格的 | 拆坏 TeX。
  const TOKENS = /(?<!\\)(`+)([\s\S]*?)\1|(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<![\\$])\$(?!\$)((?:\\\$|[^$])+?)(?<!\\)\$(?!\$)|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g;  // i18n-ok regex, not UI text
  const mathCache = new Map();

  function tokens(text, blocks) {
    let prefix = "\uE000";
    while (text.includes(prefix)) prefix += "\uE000";
    const values = [];
    const masked = text.replace(TOKENS, (raw, ticks, code, dollarBlock, dollarInline, bracketBlock, parenInline) => {
      const display = ticks ? ticks.length >= 3 && code.includes("\n") : dollarBlock != null || bracketBlock != null;
      const body = ticks ? (display ? code.replace(/^[\w+-]*\r?\n/, "") : code) : dollarBlock ?? dollarInline ?? bracketBlock ?? parenInline;
      const lang = ticks && display ? ((/^([\w+-]*)\r?\n/.exec(code) || [])[1] || "").toLowerCase() : "";
      values.push({ raw, text: body, code: !!ticks, display, lang });
      return prefix + (values.length - 1) + (blocks && display ? "B" : "I") + "\uE001";
    });
    return { text: masked, values, inline: new RegExp(prefix + "(\\d+)I\uE001", "g"), blocks: new RegExp(prefix + "(\\d+)B\uE001", "g") };
  }

  // 語言標成 flow（或 mermaid 的 flowchart）的程式碼區塊畫成圖，見 flow.js；別的圖種照程式碼顯示
  const FLOW_LANG = /^(flow|flowchart|mermaid|graph)$/, NOT_FLOW = /^\s*(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph)/;
  // 語言標成 viz 的是示意圖（一小段受限的 HTML，viz.js 過濾後畫成卡片）；模型偶爾會標成 html，開頭是 viz 外框的也算（\x22 是雙引號，寫成字面會干擾 i18n 檢查）
  const isViz = (t) => t.lang === "viz" || (t.lang === "html" && /^\s*<div class=\x22viz\x22/.test(t.text));
  function tokenHtml(t, block) {
    if (t.code && t.display && PR.vizHtml && isViz(t)) return '<div class="md-viz">' + PR.vizHtml(t.text) + "</div>";
    if (t.code && t.display && FLOW_LANG.test(t.lang || "") && !NOT_FLOW.test(t.text)) {
      return '<div class="md-flow" data-flow="' + PR.esc(t.text) + '">' + (PR.flowCached ? PR.flowCached(t.text) : "") + "</div>";  // 畫過的直接放進來（串流時整段會重排很多次）
    }
    if (t.code) return (t.display ? "<pre><code>" : "<code>") + PR.esc(t.text) + (t.display ? "</code></pre>" : "</code>");
    const html = PR.tex(t.display ? t.text.trim() : t.text, t.display);
    return block ? '<div class="eq">' + html + "</div>" : html;
  }

  function restore(s, saved, raw) {
    return s.replace(saved.inline, (m, i) => raw ? saved.values[i].raw : tokenHtml(saved.values[i], false));
  }

  PR.tex = function (tex, display) {
    const key = (display ? "D" : "I") + tex;
    if (mathCache.has(key)) return mathCache.get(key);
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e) {
      html = '<code title="' + PR.t("公式渲染失败") + '">' + PR.esc(tex) + "</code>";
    }
    mathCache.set(key, html);
    return html;
  };

  function citeLinks(s) {
    return s.replace(/\[(\d+(?:\s*[,，–-]\s*\d+)*)\]/g, (m, inner) => {
      const parts = inner.split(/(\s*[,，–-]\s*)/);
      const linked = parts.map((p) => (/^\d+$/.test(p) && PR.refById && PR.refById[p])
        ? '<a class="cite" data-ref="' + p + '">' + p + "</a>" : p).join("");
      return "[" + linked + "]";
    });
  }

  function xref(kind, key, label) {
    const ix = PR.xindex && PR.xindex[kind];
    if (!ix || !ix[key]) return label;
    return '<a class="xref" data-kind="' + kind + '" data-key="' + PR.esc(key) + '">' + label + "</a>";
  }

  function xrefLinks(s) {
    // 公式 (9) 和 (10)：把这一串里每个编号都链上
    // 簡體、繁體譯文都要認得：图／圖、节／節、附录／附錄、与／與
    s = s.replace(/公式\s*[（(]\d+[）)](?:\s*(?:和|与|與|及|、|或|,|，)\s*[（(]\d+[）)])*/g,
      (m) => m.replace(/[（(](\d+)[）)]/g, (mm, n) => xref("eq", n, mm)));
    s = s.replace(/公式\s*(\d+)(?![\d.）)])/g, (m, n) => xref("eq", n, m));
    s = s.replace(/表\s*(\d+)/g, (m, n) => xref("tab", n, m));
    s = s.replace(/[图圖]\s*(\d+)/g, (m, n) => xref("fig", n, m));
    s = s.replace(/第\s*(\d+(?:\.\d+)*)\s*[节節]/g, (m, n) => xref("sec", n, m));
    s = s.replace(/附[录錄]\s*([A-Z])(?![a-zA-Z])/g, (m, n) => xref("sec", n, m));
    // 英文原文里的
    s = s.replace(/\b(Equations?)\s+(\d+)(?:\s+(and)\s+(\d+))?/g, (m, w, a, and, b) =>
      w + " " + xref("eq", a, a) + (b ? " " + and + " " + xref("eq", b, b) : ""));
    s = s.replace(/\bTable\s+(\d+)/g, (m, n) => xref("tab", n, m));
    s = s.replace(/\bFigure\s+(\d+)/g, (m, n) => xref("fig", n, m));
    s = s.replace(/\bSection\s+(\d+(?:\.\d+)*)/g, (m, n) => xref("sec", n, m));
    s = s.replace(/\bAppendix\s+([A-Z])\b/g, (m, n) => xref("sec", n, m));
    return s;
  }

  /* AI 回答里偶尔会带出段落编号 [p4-5]、[eq7]，换成读者看得懂的“式 7”“第 4 页” */
  function blockLabel(s) {
    return s.replace(/\[([a-z]+\d*(?:-[\w-]+)?)\]/g, (m, id) => {
      const b = PR.blockById && PR.blockById[id];
      if (!b) return m;
      const label = b.type === "math" && b.tag ? PR.t("（式 {tag}）", { tag: b.tag }) : b.page ? PR.t("（第 {page} 页）", { page: b.page }) : "";
      if (!label) return m;
      // 知道是哪一段：做成可以點的，點了翻到那一頁、把那一段框出來（reader/main.js 接 a.pgref）
      const page = ((PR.state && PR.state.layout && PR.state.layout[id]) || {}).page || b.page;
      return page ? '<a class="pgref" data-page="' + page + '" data-anchor="' + id + '">' + label + "</a>" : label;
    });
  }
  /* AI 的回答、自己寫的筆記裡的「第 12 頁」「p. 12」「Page 12」：這份文件真的有那一頁，就變成可以點的（閱讀頁裡才有文件）。
     標籤、連結、程式碼裡面的不動（切開來只處理純文字的那幾段） */
  function pageRefs(s) {
    const pages = PR.state && PR.state.paper && PR.state.paper.meta && PR.state.paper.meta.pages;
    const n = pages ? pages.length : 0;
    if (!n || !/[頁页]|\bp(?:age|\.)/i.test(s)) return s;
    const link = (m, p) => (+p >= 1 && +p <= n ? '<a class="pgref" data-page="' + +p + '">' + m + "</a>" : m);
    return s.split(/(<a\b[\s\S]*?<\/a>|<code\b[\s\S]*?<\/code>|<[^>]+>)/).map((part, i) => (i % 2 ? part :
      part.replace(/第\s?(\d{1,4})\s?[頁页]/g, link).replace(/\b[Pp]age\s(\d{1,4})\b/g, link).replace(/\b[Pp]\.\s?(\d{1,4})\b/g, link))).join("");
  }

  function inline(text, opts) {
    let s = blockLabel(PR.esc(text).replace(/\\\$/g, "$"));
    // 貼進筆記的圖片：只認 clips/ 底下的檔名；方括號裡寫 50% 這種就是顯示寬度
    s = s.replace(/!\[([^\]\n]*)\]\((clips\/[\w.\-]+)\)/g, (m, alt, src) => {
      const url = PR.imageUrl ? PR.imageUrl(src) : src;
      const w = /^\d{1,3}%$/.test(alt.trim()) ? ' style="width:' + alt.trim() + '"' : "";
      return url ? '<img class="md-img" src="' + url + '" data-src="' + src + '" alt=""' + w + ' loading="lazy">' : "";
    });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 連到這個文獻庫裡的另一份文件、筆記（/read/<id>、/note/<id>，後面可以帶 #page=12 這種位置）：
    // 摘錄的「出處」就是這種。在外殼裡點了開成分頁、跳到那一頁（frame-bridge.js 接手），不開新視窗
    s = s.replace(/\[([^\]\n]+)\]\((\/(?:read|note)\/[\w\-]+(?:[?#][^\s)]*)?)\)/g, '<a href="$2" class="doclink">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    s = s.replace(/\+\+([^+\n]+)\+\+/g, "<u>$1</u>");                 // 底線（Craft 的 ⌘U）
    s = s.replace(/==([^=\n]+)==/g, '<mark class="md-hl">$1</mark>');  // 螢光（Craft 的 ==…== ／ ⌘⇧B）
    if (opts.cite !== false) s = citeLinks(s);
    if (opts.xref !== false) s = xrefLinks(s);
    return pageRefs(s).replace(/\n/g, "<br>");
  }

  /* 一行/一段文字 -> HTML */
  PR.md = function (text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text);
    const saved = tokens(text, false);
    return restore(inline(saved.text, opts), saved);
  };

  /* 行间公式先拆出来，再按空行分段；已有回答的 \[...\] 也能显示，不需要改记录。 */
  /* 回答還在流出來、圖的程式碼區塊還沒收尾：先放一個「正在畫圖」的佔位，不要把半截原始碼露出來 */
  function pendingFigure(text) {
    const fences = Array.from(text.matchAll(/^[ \t]*\x60\x60\x60([\w+-]*)[ \t]*$/gm));  // \x60 是反引號
    if (fences.length % 2 === 0) return null;
    const last = fences[fences.length - 1];
    return /^(viz|flow|flowchart|mermaid|graph)$/i.test(last[1]) ? last.index : null;
  }
  PR.mdBlocks = function (text, opts) {
    text = String(text || "").trim();
    const cut = pendingFigure(text);
    if (cut != null) {
      // 佔位只在回答還在流的時候放（呼叫的地方傳 { live: true }）。已經結束的回答——畫到一半被停止、模型忘了收尾——
      // 把區塊補上收尾照畫（畫不出來會顯示原始碼）；以前不分，這種回答會永遠停在「正在畫圖…」
      if (opts && opts.live) return PR.mdBlocks(text.slice(0, cut), opts) + '<div class="md-drawing"><span class="spin"></span>' + PR.t("正在畫圖…") + "</div>";
      const tail = /\n+([（(][^\n（）()]{1,16}[）)])\s*$/.exec(text.slice(cut));  // 最後那句「（已停止）」不是圖的一部分
      text = text.slice(0, tail ? cut + tail.index : text.length) + "\n\x60\x60\x60" + (tail ? "\n\n" + tail[1] : "");
    }
    const saved = tokens(text, true);
    const html = saved.text.split(saved.blocks).map((part, i) => i % 2 ? tokenHtml(saved.values[part], true) :
      part.split(/\n\s*\n/).map((p) => para(p, opts)).join("")).join("");
    return restore(html, saved);
  };

  function isTableDelimiter(line) {
    const trimmed = (line || "").trim();
    if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
    let parts = trimmed.split("|");
    if (trimmed.startsWith("|")) parts.shift();
    if (trimmed.endsWith("|")) parts.pop();
    if (parts.length === 0) return false;
    return parts.every((p) => /^\s*:?-+:?\s*$/.test(p));
  }

  function splitTableRow(line) {
    let s = (line || "").trim();
    const saved = tokens(s, false);
    s = saved.text;
    s = s.replace(/\\\|/g, "\uE002");
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((cell) => {
      let c = cell.trim();
      c = c.replace(/\uE002/g, "|");
      return restore(c, saved, true);
    });
  }

  function parseAlign(delimLine) {
    return splitTableRow(delimLine).map((col) => {
      const c = col.trim();
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
  }

  function tableHtml(headerLine, delimLine, dataLines, opts) {
    const align = parseAlign(delimLine);
    const getStyle = (i) => (align[i] ? ' style="text-align:' + align[i] + '"' : "");
    const headCells = splitTableRow(headerLine);
    const head = "<tr>" + headCells.map((c, i) => "<th" + getStyle(i) + ">" + PR.md(c, opts) + "</th>").join("") + "</tr>";
    const colCount = headCells.length;
    const rows = dataLines.map((rowLine) => {
      const cells = splitTableRow(rowLine);
      while (cells.length < colCount) cells.push("");
      return "<tr>" + cells.slice(0, colCount).map((c, i) => "<td" + getStyle(i) + ">" + PR.md(c, opts) + "</td>").join("") + "</tr>";
    }).join("");
    return '<div class="tbl-wrap"><table class="tbl"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
  }

  function para(p, opts) {
    p = p.trim();
    if (!p) return "";

    // 1. 表格（Markdown GFM 表格：表头 + 分隔行 + 数据行）
    const lines = p.split("\n");
    const dIdx = lines.findIndex((l, idx) => idx >= 1 && isTableDelimiter(l) && lines[idx - 1].includes("|"));
    if (dIdx >= 1) {
      const before = lines.slice(0, dIdx - 1);
      const headerLine = lines[dIdx - 1];
      const delimLine = lines[dIdx];
      let endIdx = dIdx + 1;
      while (endIdx < lines.length && lines[endIdx].includes("|") && lines[endIdx].trim()) {
        endIdx++;
      }
      const dataLines = lines.slice(dIdx + 1, endIdx);
      const after = lines.slice(endIdx);
      return (before.length ? para(before.join("\n"), opts) : "") +
        tableHtml(headerLine, delimLine, dataLines, opts) +
        (after.length ? para(after.join("\n"), opts) : "");
    }

    // 2. 引用块（> 开头）
    const qIdx = lines.findIndex((l) => /^\s*>/.test(l));
    if (qIdx >= 0) {
      let qEnd = qIdx;
      while (qEnd < lines.length && /^\s*>/.test(lines[qEnd])) qEnd++;
      const before = lines.slice(0, qIdx);
      const qText = lines.slice(qIdx, qEnd).map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
      const after = lines.slice(qEnd);
      return (before.length ? para(before.join("\n"), opts) : "") +
        "<blockquote>" + para(qText, opts) + "</blockquote>" +
        (after.length ? para(after.join("\n"), opts) : "");
    }

    // 3. 标题
    const hIdx = lines.findIndex((l) => /^#{1,6}\s+.+$/.test(l));
    if (hIdx >= 0) {
      const h = lines[hIdx].replace(/^#{1,6}\s+/, "");
      const level = Math.min(3, lines[hIdx].match(/^#+/)[0].length);  // 字級：# 最大，### 和內文一樣大只加粗
      return (hIdx ? para(lines.slice(0, hIdx).join("\n"), opts) : "") +
        '<p class="md-h" data-l="' + level + '">' + PR.md(h, opts) + "</p>" +
        (hIdx + 1 < lines.length ? para(lines.slice(hIdx + 1).join("\n"), opts) : "");
    }

    // 4. 列表：从某行起每行都以 “- ”“* ”或“1. ”开头（AI 的回答常用“引子：\n- …\n- …”）
    const isItem = (l) => /^\s*([-*•]|\d+[.、)])\s+/.test(l);
    const k = lines.findIndex(isItem);
    if (k >= 0 && lines.slice(k).every(isItem)) {
      const ordered = /^\s*\d/.test(lines[k]);
      const start = ordered ? lines[k].match(/^\s*(\d+)/)[1] : "";
      return (k ? "<p>" + PR.md(lines.slice(0, k).join("\n"), opts) + "</p>" : "") + (ordered ? '<ol' + (start === "1" ? "" : ' start="' + start + '"') + '>' : "<ul>") +
        lines.slice(k).map((l) => {
          const item = l.replace(/^\s*([-*•]|\d+[.、)])\s+/, "");
          const todo = item.match(/^\[([ xX])\]\s+/);  // - [ ] 待辦、- [x] 做完了
          return todo ? '<li class="todo' + (todo[1] === " " ? "" : " done") + '"><i></i>' + PR.md(item.slice(todo[0].length), opts) + "</li>" : "<li>" + PR.md(item, opts) + "</li>";
        }).join("") + (ordered ? "</ol>" : "</ul>");
    }

    return "<p>" + PR.md(p, opts) + "</p>";
  }

  /* 去掉标记的纯文字，给目录、列表摘要用 */
  PR.plain = (text) => {
    const saved = tokens(String(text || ""), false);
    return saved.text.replace(saved.inline, (m, i) => saved.values[i].text).replace(/!\[[^\]\n]*\]\(clips\/[\w.\-]+\)/g, "").replace(/\*\*|`/g, "");
  };
})(window.PR);
