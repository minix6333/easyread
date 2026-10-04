/* 筆記編輯器：寫的是 Markdown＋$TeX$，收起後就是排好的樣子（PR.mdBlocks）。這裡管「寫的時候」的方便：
   - 輸入框上面一排小按鈕：粗體、斜體、放大（標題）、公式、清單、待辦、圖片——不用記語法，選起來按就好；
   - 快捷鍵：⌘B 粗體、⌘I 斜體、⌘E 變成公式（⌘⇧E 獨立一行的公式）、⌘⇧. 放大、⌘⇧, 縮小、⌘⇧8 清單；
     清單裡按 Enter 自動接下一項；復原／重做用原生的 ⌘Z、⌘⇧Z（改字都走 insertText，復原記錄不會斷）；
   - 貼上或拖進圖片：存到這份文件的 clips/，在游標處插入 ![](clips/…)；
   - 公式預覽：游標在 $…$ 裡面時，輸入框下面即時顯示排好的公式。
   用法：PR.mdEd(textarea 的 HTML, { bar }) 包成 .md-ed；便利貼和筆記卡片、本頁筆記、整篇筆記都用它。 */
(function (PR) {
  "use strict";
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const MOD = MAC ? "⌘" : "Ctrl+";
  const key = (k) => PR.t("（{k}）", { k: MOD + k });
  const BTNS = [
    ["bold", "bold", () => PR.t("粗體") + key("B")],
    ["italic", "italic", () => PR.t("斜體") + key("I")],
    ["big", "bigger", () => PR.t("放大成標題，再按更大") + key("⇧.")],
    ["math", "sigma", () => PR.t("變成公式") + key("E")],
    ["list", "log", () => PR.t("清單") + key("⇧8")],
    ["todo", "list", () => PR.t("待辦")],
    ["image", "image", () => PR.t("插入圖片（也可以直接貼上）")],
  ];
  PR.mdBar = function () {
    const server = PR.store && PR.store.mode === "server";
    return '<div class="md-bar">' + BTNS.filter(([k]) => k !== "image" || server).map(([k, icon, title]) =>
      '<button type="button" data-md="' + k + '" title="' + PR.esc(title()) + '">' + PR.icon(icon, "sm") + "</button>").join("") + "</div>";
  };
  /* 把一個 <textarea …> 包成編輯器：上面工具列（bar 為 false 時不放，例如提問），下面公式預覽 */
  PR.mdEd = function (textareaHtml, opts) {
    return '<div class="md-ed">' + (opts && opts.bar === false ? "" : PR.mdBar()) + textareaHtml + '<div class="md-prev" hidden></div></div>';
  };

  /* ---------- 改字：一律走 insertText，原生的復原（⌘Z）才接得上 ---------- */
  function insert(ta, text) {
    ta.focus();
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input", { bubbles: true })); }
  }
  /* 選起來的字前後包上記號；已經包著就拆掉。沒選字就放一個佔位的字並選起來 */
  function wrap(ta, left, right, hint) {
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value, sel = v.slice(s, e);
    if (s >= left.length && v.slice(s - left.length, s) === left && v.slice(e, e + right.length) === right) {
      ta.setSelectionRange(s - left.length, e + right.length);
      insert(ta, sel);
      ta.setSelectionRange(s - left.length, e - left.length);
      return;
    }
    const inner = sel || hint;
    insert(ta, left + inner + right);
    ta.setSelectionRange(s + left.length, s + left.length + inner.length);
  }
  /* 改游標所在（或選到）的每一行的開頭 */
  function lines(ta, fn) {
    const v = ta.value;
    const s = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let e = v.indexOf("\n", Math.max(ta.selectionEnd, s));
    if (e < 0) e = v.length;
    const out = v.slice(s, e).split("\n").map(fn).join("\n");
    ta.setSelectionRange(s, e);
    insert(ta, out);
    ta.setSelectionRange(s + out.length, s + out.length);
  }
  const ITEM = /^(\s*)(?:[-*•]|\d+[.、)])\s+(?:\[[ xX]\]\s+)?/;
  const OPS = {
    bold: (ta) => wrap(ta, "**", "**", PR.t("粗體")),
    italic: (ta) => wrap(ta, "*", "*", PR.t("斜體")),
    math: (ta) => wrap(ta, "$", "$", "x"),
    mathblock: (ta) => wrap(ta, "$$\n", "\n$$", "x"),
    // 放大：一般 → 大（##）→ 特大（#）→ 一般；縮小反過來
    big: (ta) => lines(ta, (l) => (/^##\s/.test(l) ? "# " + l.replace(/^##\s+/, "") : /^#\s/.test(l) ? l.replace(/^#\s+/, "") : "## " + l.replace(/^#+\s+/, ""))),
    small: (ta) => lines(ta, (l) => (/^#\s/.test(l) ? "## " + l.replace(/^#\s+/, "") : l.replace(/^#+\s+/, ""))),
    list: (ta) => lines(ta, (l) => (ITEM.test(l) ? l.replace(ITEM, "$1") : "- " + l)),
    todo: (ta) => lines(ta, (l) => (/^\s*[-*•]\s+\[[ xX]\]\s+/.test(l) ? l.replace(ITEM, "$1") : "- [ ] " + l.replace(ITEM, "$1"))),
    image: (ta) => {
      const f = document.createElement("input");
      f.type = "file"; f.accept = "image/png,image/jpeg,image/gif,image/webp"; f.multiple = true;
      f.onchange = () => addImages(ta, f.files);
      f.click();
    },
  };
  PR.mdOp = (ta, op) => { if (ta && OPS[op]) { OPS[op](ta); preview(ta); } };

  /* ---------- 圖片：存到 clips/，在游標處插入 ---------- */
  async function addImages(ta, files) {
    const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type));
    if (!list.length) return;
    if (!(PR.store && PR.store.mode === "server")) return PR.toast(PR.t("離線版不能加圖片"));
    for (const f of list) {
      try {
        const r = await fetch("/api/p/" + PR.pid + "/clip", { method: "POST", headers: { "Content-Type": f.type || "image/png", "X-Token": PR.token || "" }, body: f });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        if (!ta.isConnected) return;
        const v = ta.value, at = ta.selectionStart;
        insert(ta, (at > 0 && v[at - 1] !== "\n" ? "\n" : "") + "![](" + d.src + ")\n");
      } catch (e) { PR.toast(PR.t("圖片沒加上：{msg}", { msg: PR.esc(e.message) })); }
    }
  }
  const isNote = (el) => !!(el && el.matches && el.matches(".md-ed textarea"));
  document.addEventListener("paste", (e) => {
    if (!isNote(e.target)) return;
    const files = Array.from((e.clipboardData && e.clipboardData.items) || []).filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addImages(e.target, files);
  });
  document.addEventListener("dragover", (e) => { if (isNote(e.target) && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!isNote(e.target) || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addImages(e.target, e.dataTransfer.files);
  });

  /* ---------- 公式預覽：游標在 $…$ 或 $$…$$ 裡面 ---------- */
  function formulaAt(v, pos) {
    const re = /\$\$([\s\S]+?)\$\$|\$((?:\\\$|[^$\n])+?)\$/g;
    let m;
    while ((m = re.exec(v))) {
      if (pos >= m.index && pos <= m.index + m[0].length) return { tex: (m[1] != null ? m[1] : m[2]).trim(), display: m[1] != null };
      if (m.index > pos) break;
    }
    return null;
  }
  function preview(ta) {
    const ed = ta.closest(".md-ed"), box = ed && ed.querySelector(".md-prev");
    if (!box) return;
    const f = ta.selectionStart === ta.selectionEnd || ta.value.slice(ta.selectionStart, ta.selectionEnd).length < 400 ? formulaAt(ta.value, ta.selectionStart) : null;
    const was = box.hidden;
    if (f && f.tex) { box.innerHTML = PR.tex(f.tex, true); box.hidden = false; } else box.hidden = true;
    if (was !== box.hidden) PR.emit("md-preview", ta);  // 高度變了：便利貼要重新對位置
  }
  ["input", "keyup", "click", "focusin"].forEach((ev) => document.addEventListener(ev, (e) => { if (isNote(e.target)) preview(e.target); }));

  /* ---------- 工具列、快捷鍵 ---------- */
  document.addEventListener("mousedown", (e) => { if (e.target.closest && e.target.closest(".md-bar")) e.preventDefault(); });  // 點按鈕時別讓輸入框失焦
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".md-bar [data-md]");
    if (!b) return;
    const ta = b.closest(".md-ed").querySelector("textarea");
    PR.mdOp(ta, e.shiftKey && b.dataset.md === "math" ? "mathblock" : b.dataset.md);
  });
  document.addEventListener("keydown", (e) => {
    const ta = e.target;
    if (!isNote(ta) || e.defaultPrevented || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const op = !e.shiftKey ? { b: "bold", i: "italic", e: "math" }[k] : { e: "mathblock", m: "mathblock", ".": "big", ">": "big", ",": "small", "<": "small", "8": "list", "*": "list" }[k];
      if (op) { e.preventDefault(); e.stopPropagation(); PR.mdOp(ta, op); }
      return;
    }
    // 清單裡按 Enter：接下一項；空的那一項再按一次就結束清單
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      const v = ta.value, at = ta.selectionStart;
      const s = v.lastIndexOf("\n", at - 1) + 1;
      const line = v.slice(s, at), m = line.match(/^(\s*)([-*•]|(\d+)([.、)]))\s+(\[[ xX]\]\s+)?/);
      if (!m) return;
      e.preventDefault();
      if (line.length === m[0].length) { ta.setSelectionRange(s, at); insert(ta, ""); return; }
      insert(ta, "\n" + m[1] + (m[3] ? +m[3] + 1 + m[4] : m[2]) + " " + (m[5] ? "[ ] " : ""));
    }
  });

  /* ---------- 筆記裡的圖片：點一下放大看 ---------- */
  document.addEventListener("click", (e) => {
    const img = e.target.closest && e.target.closest("img.md-img, .card .clip");
    const box = PR.$("#lightbox");
    if (box && (e.target === box || e.target.closest("#lightbox"))) { box.remove(); return; }
    if (!img || !img.matches("img.md-img")) return;
    e.stopPropagation(); e.preventDefault();
    const lb = PR.el("div", { id: "lightbox" }, '<img src="' + PR.esc(img.currentSrc || img.src) + '" alt="">');
    document.body.appendChild(lb);
  }, true);
  document.addEventListener("keydown", (e) => { const box = e.key === "Escape" && PR.$("#lightbox"); if (box) { e.stopImmediatePropagation(); box.remove(); } }, true);
})(window.PR);
