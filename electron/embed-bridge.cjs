// 右邊外部工具欄裡的 AI 網頁和 FOLI 之間（web/js/dock-ai.js 的主程序這一半）：
// 1. giveFiles：把檔案交給那個網頁（「附上整份 PDF／這一頁」）。它有收這種檔案的 <input type=file> 就用 DevTools 協定的
//    DOM.setFileInputFiles 直接放進去（和讀者在檔案視窗裡選好一樣）；沒有（Gemini 要先點選單才長出欄位）就模擬把檔案拖到
//    它的輸入框上放開（Input.dispatchDragEvent，網頁收到的是真的拖放）。不會按送出。
// 2. selectionItems：在它的回答上選字按右鍵，多幾項：存成筆記（改寫成筆記的樣子，存進正在讀的那一頁）、在小視窗問這段、
//    在文件裡找這段、（選的字裡有頁碼時）跳到那一頁。
// 只接受外部工具欄裡的網頁（embed 分區、掛在主視窗上的 webview）；檔案只能是 FOLI 放在快取 share 資料夾裡的 PDF 或圖片（handoff.py 做的）。
const fs = require("fs");
const path = require("path");

const OK_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".md", ".txt"]);
const MAX_BYTES = 300 * 1024 * 1024;

/* 檔案要是 <…>/cache/<文件 id 或 dock>/share/<檔名>，存在、不太大、是 PDF、圖片或 Markdown／文字檔 */
function checkFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 4) return null;
  const out = [];
  for (const f of files) {
    if (typeof f !== "string" || !path.isAbsolute(f)) return null;
    const p = path.resolve(f);
    if (!OK_EXT.has(path.extname(p).toLowerCase())) return null;
    const share = path.dirname(p), docDir = path.dirname(share), cache = path.dirname(docDir);
    if (path.basename(share) !== "share" || path.basename(cache) !== "cache" || !/^[\w-]{4,64}$/.test(path.basename(docDir))) return null;
    let st;
    try { st = fs.statSync(p); } catch (_) { return null; }
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    out.push(p);
  }
  return out;
}

/* 找合用的上傳欄位：PDF 要收 application/pdf（或什麼都收）的，圖片要收 image 的；有 multiple 的優先。回傳 objectId 或 null */
function pickInputExpr(kind) {
  return `(() => {
    const kind = ${JSON.stringify(kind)};
    let best = null, score = 0;
    for (const i of document.querySelectorAll("input[type=file]")) {
      if (i.disabled) continue;
      const a = (i.accept || "").toLowerCase();
      let s = !a || a === "*" || a.includes("*/*") ? 2 : kind === "pdf" ? (a.includes("pdf") || a.includes("application/") ? 3 : 0)
        : kind === "text" ? (a.includes("text") || a.includes(".md") || a.includes(".txt") ? 3 : 0) : (a.includes("image") || a.includes(".jpg") || a.includes("jpeg") ? 3 : 0);
      if (!s) continue;
      if (i.multiple) s += 0.5;
      if (s > score) { score = s; best = i; }
    }
    return best;
  })()`;
}

async function giveFiles(wc, files, at) {
  const dbg = wc.debugger;
  let mine = false;
  if (!dbg.isAttached()) { dbg.attach("1.3"); mine = true; }
  try {
    const ext = path.extname(files[0]).toLowerCase(), kind = ext === ".pdf" ? "pdf" : ext === ".md" || ext === ".txt" ? "text" : "image";
    const { result } = await dbg.sendCommand("Runtime.evaluate", { expression: pickInputExpr(kind), returnByValue: false });
    if (result && result.subtype === "node" && result.objectId) {
      // 先清空：同一個檔案再附一次時，欄位的值沒變，網頁收不到 change（有的網站自己會清，有的不會）
      await dbg.sendCommand("Runtime.callFunctionOn", { objectId: result.objectId, functionDeclaration: "function () { try { this.value = ''; } catch (e) {} }" });
      await dbg.sendCommand("DOM.setFileInputFiles", { files, objectId: result.objectId });
      return { ok: true, how: "input" };
    }
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return { ok: false, error: "no-input" };
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await dbg.sendCommand("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data });
    return { ok: true, how: "drop" };
  } finally {
    if (mine) { try { dbg.detach(); } catch (_) { /* 已經斷了 */ } }
  }
}

// 選的字裡的頁碼（和 web/js/dock-guest.js 的 pageRefs 同一套，只取第一個）
const PAGE = [/第\s*(\d{1,4})\s*[頁页]/, /第\s*(\d{1,4})\s*張投影片/, /(?:^|[^A-Za-z])(?:pp?\.|pages?|slides?)\s*(\d{1,4})(?!\d)/i];
function pageIn(text) {
  for (const re of PAGE) { const m = re.exec(String(text || "")); if (m) return parseInt(m[1], 10); }
  return 0;
}

/* 右鍵選單多的幾項（選了字才有）；send(action) 交給外殼的 dock-ai.js 做 */
function selectionItems(text, zh, send) {
  const t = String(text || "").trim();
  if (!t) return [];
  const page = pageIn(t);
  return [
    { type: "separator" },
    { label: zh ? "存成筆記" : "Save as a note", click: () => send({ action: "save", text: t.slice(0, 60000) }) },
    { label: zh ? "在小視窗問這段" : "Ask about this in a small window", click: () => send({ action: "aside", text: t.slice(0, 1500) }) },
    { label: zh ? "在文件裡找這段" : "Find in the document", click: () => send({ action: "find", text: t.slice(0, 200) }) },
    ...(page ? [{ label: zh ? `跳到第 ${page} 頁` : `Go to page ${page}`, click: () => send({ action: "page", page }) }] : []),
  ];
}

module.exports = { checkFiles, giveFiles, selectionItems, pageIn };
