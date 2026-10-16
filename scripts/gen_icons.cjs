// 開發用：從 lucide-static（ISC，node_modules 裡）挑一批圖示，產生 easyread/web/js/common/icons-extra.js。
//   node scripts/gen_icons.cjs
// 產生的檔案進版本庫，執行時不需要 lucide-static。要加圖示：在下面的清單加名字，重跑這支。
// UI：介面自己要用的（編輯器的把手、格式面板、筆記頁的工具列…），名字照我們的習慣取（左邊）對應 Lucide 的檔名（右邊）。
// PICK：給使用者挑的（資料夾、筆記的圖示），分幾組（組名是代號，顯示的字在 js/common/pick.js）；名字就是 Lucide 的檔名，存進 note.json／prefs 的也是這個。
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "../node_modules/lucide-static/icons");
const OUT = path.join(__dirname, "../easyread/web/js/common/icons-extra.js");

const UI = {
  grip: "grip-vertical", h1: "heading-1", h2: "heading-2", h3: "heading-3", bullets: "list", numbers: "list-ordered", todo: "list-todo",
  toggle: "chevrons-up-down", caret: "play", callout: "message-square-quote", table: "table", codeblock: "square-code", formula: "square-function", divider: "minus",
  flow: "workflow", up: "arrow-up", down: "arrow-down", top: "arrow-up-to-line", bottom: "arrow-down-to-line", cut: "scissors", duplicate: "copy-plus",
  newdoc: "file-plus-2", indent: "indent-increase", outdent: "indent-decrease", pilcrow: "pilcrow", highlighter: "highlighter", outline: "list-tree",
  exportfile: "file-down", movefolder: "folder-input", palette: "palette", rename: "text-cursor-input", wand: "wand-sparkles", smile: "smile",
  starfill: "star", heart: "heart", calendar: "calendar", hash: "hash", layout: "panels-top-left", wide: "move-horizontal", fonts: "type",
  focus: "square-dashed", box: "square", eye: "eye", filter: "list-filter", undo2: "undo-2", restore: "archive-restore", inbox: "inbox",
  folderopen: "folder-open", folderplus: "folder-plus", notes: "notebook-text", doc: "file-text", insert: "between-horizontal-start", textsize: "a-large-small",
  emphasis: "baseline", caption: "subscript", check2: "circle-check", circle: "circle", history: "history", words: "whole-word", map: "map-pin",
  globe: "globe", linkout: "external-link", websearch: "search-check",
  // 2.1.0-tw.13：閱讀頁的字換成圖示（原文／譯文／雙語、面板分頁、筆記面板、閱讀狀態、簡明回答…）
  langs: "languages", cols2: "columns-2", sticky: "sticky-note", unread: "circle-dashed", reading: "circle-dot", chats: "messages-square",
  layers: "layers", summary: "scroll-text", brief: "text", gauge: "gauge", origtext: "book-open-text", notepen: "notebook-pen",
};

const PICK = [
  ["study", ["graduation-cap", "book-open", "library", "notebook-pen", "pen-line", "pencil", "highlighter", "bookmark", "school", "presentation", "languages", "quote", "feather", "scroll", "newspaper", "file-text"]],
  ["research", ["flask-conical", "atom", "brain", "microscope", "dna", "test-tube", "telescope", "orbit", "sigma", "pi", "calculator", "chart-line", "chart-column", "chart-pie", "radar", "ruler"]],
  ["computer", ["code", "terminal", "cpu", "database", "server", "network", "git-branch", "binary", "bot", "bug", "boxes", "layers", "puzzle", "workflow", "cloud", "wifi"]],
  ["ideas", ["sparkles", "lightbulb", "target", "rocket", "zap", "flame", "star", "heart", "flag", "trophy", "crown", "gem", "compass", "key", "shield", "lock"]],
  ["life", ["home", "coffee", "music", "camera", "film", "image", "palette", "brush", "gamepad-2", "dice-5", "plane", "car", "bike", "shopping-bag", "wallet", "gift"]],
  ["work", ["briefcase", "building-2", "landmark", "users", "user", "message-circle", "mail", "calendar", "clock", "alarm-clock", "inbox", "archive", "tag", "paperclip", "link", "wrench"]],
  ["nature", ["sun", "moon", "leaf", "tree-pine", "flower-2", "mountain", "waves", "globe", "earth", "map", "cat", "dog", "bird", "fish", "smile", "ghost"]],
];

function inner(name) {
  const file = path.join(SRC, name + ".svg");
  if (!fs.existsSync(file)) throw new Error("lucide 沒有這個圖示：" + name);
  const svg = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const m = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(svg);
  return m[1].replace(/\s*\n\s*/g, "").replace(/\s+\/>/g, "/>").trim();
}

const icons = {};
for (const [ours, theirs] of Object.entries(UI)) icons[ours] = inner(theirs);
for (const [, names] of PICK) for (const n of names) icons["l-" + n] = inner(n);

const ver = JSON.parse(fs.readFileSync(path.join(__dirname, "../node_modules/lucide-static/package.json"), "utf8")).version;
const lines = Object.entries(icons).map(([k, v]) => "    " + JSON.stringify(k) + ": '" + v.replace(/'/g, "\\'") + "',");
const out = "/* 這個檔是 scripts/gen_icons.cjs 產生的，不要手改。圖示來自 Lucide " + ver + "（ISC 授權，全文在 web/vendor/lucide.LICENSE）。\n" +
  "   前半是介面自己用的（PR.icon(\"grip\")…），後半「l-」開頭的是給使用者挑的那一批（資料夾、筆記的圖示，PR.PICK_ICONS 分好組）。 */\n" +
  "(function (PR) {\n  \"use strict\";\n  PR.addIcons({\n" + lines.join("\n") + "\n  });\n" +
  "  PR.PICK_ICONS = " + JSON.stringify(PICK.map(([g, names]) => [g, names])) + ";\n})(window.PR);\n";
fs.writeFileSync(OUT, out);
fs.copyFileSync(path.join(__dirname, "../node_modules/lucide-static/LICENSE"), path.join(__dirname, "../easyread/web/vendor/lucide.LICENSE"));
console.log("icons-extra.js：" + Object.keys(icons).length + " 個圖示，" + Math.round(out.length / 1024) + " KB");
