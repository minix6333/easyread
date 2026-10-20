/* 筆記 AI 的共同核心：照讀者的話改筆記（閱讀頁筆記面板 reader/notes-ai.js、獨立筆記 note/app.js 都用；伺服器那邊是 notehelp.py 的 auto）。
   - 範圍：讀者選了幾塊（點把手、⇧ 點、拖過幾塊），或正在某一塊裡反白了幾個字。點進 AI 那一欄會讓編輯器失焦、選的東西就沒了，
     所以按下去那一刻先記下來（capture），選的那幾塊改成區塊選取，打字的時候看得到「要改的是這裡」。
     沒選就是整份筆記，AI 自己判斷要改哪幾塊、還是寫新的（例如「把整份排好」「第二個標題下面的清單改成表格」）。
   - 回覆：第一行「@@ do: 整理；轉成待辦」——用筆記裡的操作名稱說它理解成什麼；接著幾段 @@ replace A-B／insert after N／delete A-B／move A-B after N。
     parse 拆開，apply 套到每一塊的 Markdown 上，span 找出真的變了的那一段，交給編輯器當「AI 的建議」預覽（採用才換上，換掉的那幾塊先淡掉）。
   - 一邊流出來一邊看：第一段修改的內容直接流進預覽；收完後換成合起來的結果。模型沒照格式（沒有 @@）時：有選就當成換掉選的那幾塊，沒選就接在後面。
   純函式（parse、apply、span、splitBlocks）在 tests/test_note_ai.cjs 測。 */
(function (root) {
  "use strict";
  const HEAD = /^@@\s*(do|replace|insert|delete|move)\b\s*:?\s*(.*)$/i;
  const RANGE = /(\d+)(?:\s*[-–—~～至到]\s*(\d+))?/;
  const trimBlank = (s) => String(s || "").replace(/^\s*\n/, "").replace(/\n\s*$/, "").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");

  /* 拆開模型的回覆：{ do, hunks: [{op, a, b, after, md}], loose }（loose：第一個 @@ 指令之前的字——模型沒照格式時就是整個回覆） */
  function parse(text) {
    let s = String(text || "").replace(/\r\n?/g, "\n");
    const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);  // 整個包在 ``` 裡
    if (fenced) s = fenced[1];
    const out = { do: "", hunks: [], loose: "" };
    const loose = [];
    let cur = null;
    for (const line of s.split("\n")) {
      const m = HEAD.exec(line.trim());
      if (m) {
        const op = m[1].toLowerCase(), arg = m[2].replace(/[[\]【】]/g, "").trim();
        if (op === "do") { out.do = arg.replace(/[。.]$/, ""); cur = null; continue; }
        cur = hunk(op, arg);
        if (cur) out.hunks.push(cur);
        continue;
      }
      if (cur) { if (cur.lines) cur.lines.push(line); } else if (!out.hunks.length) loose.push(line);
    }
    for (const h of out.hunks) { if (h.lines) h.md = trimBlank(h.lines.join("\n")); delete h.lines; }
    out.loose = out.hunks.length ? "" : trimBlank(loose.join("\n").replace(/^\s*(?:以下是|這是|改好的版本|修改後)[^\n]*[:：]\s*\n/, ""));  // i18n-ok 比對模型的開場白
    return out;
  }
  function hunk(op, arg) {
    const r = RANGE.exec(arg);
    if (!r) return null;
    const a = +r[1], b = r[2] ? +r[2] : a;
    if (op === "replace") return { op, a: Math.min(a, b), b: Math.max(a, b), lines: [] };
    if (op === "delete") return { op, a: Math.min(a, b), b: Math.max(a, b) };
    if (op === "insert") { const m = /(\d+)/.exec(arg); return { op, after: +m[1], lines: [] }; }
    if (op === "move") {
      const to = /(?:after|後面|之後)\s*(\d+)|(\d+)\s*(?:後面|之後)/i.exec(arg.slice(r.index + r[0].length));  // i18n-ok 比對
      if (!to) return null;
      return { op, a: Math.min(a, b), b: Math.max(a, b), after: +(to[1] || to[2]) };
    }
    return null;
  }

  /* 把修改套到每一塊的 Markdown 上（編號從 1 起，對著送出那一刻的樣子）。重疊、超出範圍的修改不理。回傳一串 Markdown（一段可能有好幾塊） */
  function apply(blocks, hunks) {
    const n = blocks.length, rep = new Map(), ins = new Map(), del = new Set(), used = new Set();
    const inRange = (a, b) => a >= 1 && b <= n && a <= b;
    const free = (a, b) => { for (let i = a; i <= b; i++) if (used.has(i)) return false; return true; };
    const take = (a, b) => { for (let i = a; i <= b; i++) used.add(i); };
    const after = (k, md) => { if (!ins.has(k)) ins.set(k, []); ins.get(k).push(md); };
    for (const h of hunks || []) {
      if (h.op === "replace" && inRange(h.a, h.b) && free(h.a, h.b)) { take(h.a, h.b); rep.set(h.a, { b: h.b, md: h.md || "" }); }
      else if (h.op === "delete" && inRange(h.a, h.b) && free(h.a, h.b)) { take(h.a, h.b); for (let i = h.a; i <= h.b; i++) del.add(i); }
      else if (h.op === "insert" && h.after >= 0 && h.after <= n && (h.md || "").trim()) after(h.after, h.md);
      else if (h.op === "move" && inRange(h.a, h.b) && free(h.a, h.b) && h.after >= 0 && h.after <= n && (h.after < h.a - 1 || h.after > h.b)) {
        take(h.a, h.b);
        for (let i = h.a; i <= h.b; i++) del.add(i);
        after(h.after, blocks.slice(h.a - 1, h.b).join("\n\n"));
      }
    }
    const out = [], push = (md) => { if (String(md || "").trim()) out.push(md); };
    (ins.get(0) || []).forEach(push);
    for (let i = 1; i <= n; i++) {
      const r = rep.get(i);
      if (r) { push(r.md); for (let k = i; k <= r.b; k++) (ins.get(k) || []).forEach(push); i = r.b; continue; }
      if (!del.has(i)) push(blocks[i - 1]);
      (ins.get(i) || []).forEach(push);
    }
    return out;
  }

  /* 一串 Markdown → 一塊一塊（和編輯器的 blocksMd 同一種寫法，才比得出哪幾塊沒變） */
  function splitBlocks(PR, parts) {
    const md = (Array.isArray(parts) ? parts : [parts]).filter((x) => String(x || "").trim()).join("\n\n");
    return PR.blocksParse(md).map((b) => PR.blocksSerialize([b]));
  }

  /* 舊的、新的一塊一塊比：頭尾一樣的不算，回傳 { from, to, md }——換掉第 from 到 to 塊（to < from 是插在 from 前面）；完全沒變回 null */
  function span(old, next) {
    let p = 0;
    while (p < old.length && p < next.length && old[p] === next[p]) p++;
    let s = 0;
    while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
    const to = old.length - 1 - s, mid = next.slice(p, next.length - s);
    if (to < p && !mid.length) return null;
    return { from: p, to, md: mid.join("\n\n"), removed: Math.max(0, to - p + 1), added: mid.length };
  }

  const pure = { parse, apply, span, splitBlocks };
  if (typeof module !== "undefined" && module.exports) { module.exports = pure; return; }
  const PR = root.PR;
  if (!PR) return;
  const t = (s, v) => PR.t(s, v);

  /* 按下 AI 那一欄（還沒失焦）的那一刻：選了哪幾塊、正在編的那一塊、反白的字。回傳 { from, to, picked, cursor, n }（沒選 from 是 null） */
  function capture(ed) {
    if (!ed || ed.previewing()) return null;
    const sel = ed.selection(), pk = ed.picked && ed.picked();
    const cur = ed.current ? ed.current() : {};
    const sc = { from: null, to: null, picked: "", cursor: null, n: ed.count() };
    if (pk && pk.i >= 0) {
      sc.cursor = pk.i;
      if (pk.text) { sc.from = sc.to = pk.i; sc.picked = pk.text.slice(0, 600); }
    } else if (sel && cur.ids && cur.ids.length) { sc.from = sel.from; sc.to = sel.to; }
    if (sc.from != null) ed.selectSpan(sc.from, sc.to);  // 改成區塊選取：在輸入框打字時，要改的那幾塊一直亮著
    return sc;
  }
  /* 範圍的說明（AI 那一欄上的小標籤） */
  function scopeLabel(sc) {
    if (!sc || sc.from == null) return t("整份筆記");
    if (sc.picked) return t("選的字：「{q}」", { q: sc.picked.length > 18 ? sc.picked.slice(0, 17) + "…" : sc.picked });
    return sc.from === sc.to ? t("第 {a} 塊", { a: sc.from + 1 }) : t("第 {a}–{b} 塊", { a: sc.from + 1, b: sc.to + 1 });
  }

  /* 跑一次：o = { ed, url, body（模型、上網、頁碼…）, scope, ask, title（預覽的標題，例如「AI 整理的版本」）, token, onDone }。
     回傳 { ctrl, done }：ctrl.abort() 停；done 是 Promise */
  function run(o) {
    const ed = o.ed, blocks = ed.blocksMd(), sc = o.scope || {}, ctrl = new AbortController();
    const at = sc.from != null ? { from: sc.from, to: sc.to } : { from: blocks.length, to: blocks.length - 1 };
    let shownAt = null, out = "", model = "";
    const title = (p) => (p && p.do ? t("AI 的建議：{what}", { what: p.do.replace(/\s*[;；]\s*/g, "、") }) : o.title || t("AI 正在想…"));  // i18n-ok 標點
    ed.preview(at.from, at.to, "", { streaming: true, label: o.title || t("AI 正在想…"), stop: () => ctrl.abort() });
    const show = () => {  // 流的時候：最後一段修改的內容直接看
      const p = parse(out), h = p.hunks[p.hunks.length - 1];
      if (!h) { ed.updatePreview(p.loose, { streaming: true, label: title(p) }); return; }
      const where = h.op === "replace" || h.op === "delete" || h.op === "move" ? { from: h.a - 1, to: h.op === "move" ? h.a - 2 : h.b - 1 } : { from: h.after, to: h.after - 1 };
      const key = where.from + ":" + where.to;
      if (key !== shownAt && where.from >= 0 && where.from <= blocks.length) { shownAt = key; ed.preview(where.from, where.to, h.md || "", { streaming: true, label: title(p), stop: () => ctrl.abort(), note: h.op === "delete" ? t("刪掉這幾塊") : h.op === "move" ? t("搬動這幾塊") : "" }); }
      else ed.updatePreview(h.md || "", { streaming: true, label: title(p) });
    };
    const done = (async () => {
      const res = await fetch(o.url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": o.token || PR.token || "" },
        body: JSON.stringify(Object.assign({}, o.body || {}, { mode: "auto", blocks, ask: o.ask, scope: sc.from != null ? { from: sc.from, to: sc.to } : null, cursor: sc.cursor != null ? sc.cursor : null, picked: sc.picked || "" })) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.model) model = ev.model;
          if (ev.status && PR.webStatusText && PR.webStatusText(ev.status)) ed.updatePreview("", { streaming: true, label: PR.webStatusText(ev.status) + "…" });
          if (ev.t) { out += ev.t; show(); }
          if (ev.error) throw new Error(ev.error);
        }
      }
      // 收完：套上去、找出真的變了的那一段
      const p = parse(out);
      let next;
      if (p.hunks.length) next = apply(blocks, p.hunks);
      else if (p.loose.trim()) next = sc.from != null ? apply(blocks, [{ op: "replace", a: sc.from + 1, b: sc.to + 1, md: p.loose }]) : apply(blocks, [{ op: "insert", after: sc.cursor != null ? sc.cursor + 1 : blocks.length, md: p.loose }]);
      else { ed.rejectPreview(); PR.toast(t("AI 沒有回任何內容")); return null; }
      const now = ed.blocksMd();
      if (now.length !== blocks.length || now.some((x, k) => x !== blocks[k])) { ed.rejectPreview(); PR.toast(t("AI 改的時候筆記變了：再問一次")); return null; }
      const sp = span(blocks, splitBlocks(PR, next));
      if (!sp) { ed.rejectPreview(); PR.toast(t("AI 覺得不用改：{what}", { what: p.do || "—" }), null, 3500); return null; }
      const note = !sp.added ? t("刪掉這幾塊") : "";
      ed.preview(sp.from, sp.to, sp.md, { streaming: false, label: title(p) + (model ? " · " + model : ""), note });
      return sp;
    })().catch((e) => {
      ed.rejectPreview();
      if (e.name !== "AbortError") PR.toast(t("没能回答：{msg}", { msg: PR.esc(e.message) }), null, 6000);
      return null;
    });
    return { ctrl, done };
  }

  PR.noteAi = Object.assign({ capture, scopeLabel, run }, pure);
})(typeof window !== "undefined" ? window : globalThis);
