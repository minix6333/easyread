/* 共用小工具。所有脚本共用全局 PR 命名空间（不打包、不用构建，也能内联成单文件离线版）。 */
window.PR = window.PR || {};
(function (PR) {
  "use strict";

  PR.$ = (sel, root) => (root || document).querySelector(sel);
  PR.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  PR.el = function (tag, attrs, html) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    if (html != null) e.innerHTML = html;
    return e;
  };

  /* 译文语言的名字跟着界面语言写：中文界面“日语”，英文界面“Japanese” */
  PR.TARGETS = [["zh-TW", PR.t("繁體中文")], ["zh", PR.t("简体中文")], ["ja", PR.t("日语")], ["ko", PR.t("韩语")], ["es", PR.t("西班牙语")], ["fr", PR.t("法语")], ["de", PR.t("德语")]];
  PR.targetName = (code) => (PR.TARGETS.find(([k]) => k === code) || PR.TARGETS[0])[1];
  /* 文件類型（kinds.py）：論文 / 投影片 / 講義 */
  PR.KINDS = [["paper", PR.t("論文")], ["slides", PR.t("投影片")], ["notes", PR.t("講義")]];
  PR.kindName = (code) => (PR.KINDS.find(([k]) => k === code) || PR.KINDS[0])[1];

  /* 论文标题哪个当主标题：译文语言和界面语言一样时用译文标题（中文界面看中文译文），
     否则用英文原标题，译文标题放第二行。short 是侧栏用的短标题 */
  PR.titles = function (i) {
    const tr = i.title_zh || "", en = i.title_en || "", lang = i.target || "zh";
    if (tr && (PR.lang === lang || !en)) return { main: tr, sub: en, subLang: "en", short: i.short_zh || tr.split(/[：:]/)[0] };
    return { main: en || PR.t("（未命名）"), sub: tr, subLang: lang, short: en.split(/:\s/)[0] || PR.t("（未命名）") };
  };

  PR.esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* 和 Python store.text_hash 一致：FNV-1a 32 位，按 UTF-16 码元 */
  PR.hashText = function (s) {
    let h = 0x811c9dc5;
    s = s || "";
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  };

  PR.nowIso = function () {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" +
      pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + String(d.getMilliseconds()).padStart(3, "0") +
      (off >= 0 ? "+" : "-") + pad(off / 60) + ":" + pad(off % 60);
  };

  PR.shortTime = function (iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return PR.t("{m}月{d}日 {time}", { m: d.getMonth() + 1, d: d.getDate(), time: pad(d.getHours()) + ":" + pad(d.getMinutes()) });
  };
  PR.relTime = function (iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return PR.t("刚刚");
    if (s < 3600) return PR.t("{n} 分钟前", { n: Math.floor(s / 60) });
    if (s < 86400) return PR.t("{n} 小时前", { n: Math.floor(s / 3600) });
    if (s < 86400 * 30) return PR.t("{n} 天前", { n: Math.floor(s / 86400) });
    return new Date(iso).toLocaleDateString(PR.lang === "en" ? "en-US" : PR.lang === "zh-TW" ? "zh-TW" : "zh-CN");
  };

  PR.uid = (p) => (p || "n") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  PR.debounce = function (fn, ms) {
    let t;
    const f = function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
    f.flush = () => { clearTimeout(t); fn(); };
    f.cancel = () => clearTimeout(t);
    return f;
  };
  PR.throttle = function (fn, ms) {
    let last = 0, t;
    return function () {
      const now = Date.now(), wait = ms - (now - last);
      clearTimeout(t);
      if (wait <= 0) { last = now; fn(); } else t = setTimeout(() => { last = Date.now(); fn(); }, wait);
    };
  };

  PR.ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  try { // 改名前（coread-*）存的偏好搬过来
    Object.keys(localStorage).filter((k) => k.startsWith("coread-")).forEach((k) => {
      const nk = "easyread-" + k.slice(7);
      if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
      localStorage.removeItem(k);
    });
  } catch (e) { /* ignore */ }

  /* 偏好存到本机数据目录的 prefs.json（换浏览器、清缓存都还在）；localStorage 只当缓存。离线单文件版没有服务，只用缓存。 */
  let prefQueue = {}, prefT = null;
  PR.savePrefs = function (section, obj) {
    prefQueue[section] = Object.assign(prefQueue[section] || {}, obj);
    clearTimeout(prefT);
    prefT = setTimeout(flushPrefs, 700);
  };
  function flushPrefs(leaving) {
    clearTimeout(prefT);
    if (!PR.token || location.protocol === "file:" || !Object.keys(prefQueue).length) return;
    const body = prefQueue; prefQueue = {};
    if (leaving) {  // 关页面、刷新时：keepalive 让请求在页面走掉后也能发完
      fetch("/api/prefs", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Token": PR.token }, body: JSON.stringify(body) }).catch(() => {});
    } else PR.api("/api/prefs", { method: "POST", body }).catch(() => { /* 下次改动再存 */ });
  }
  window.addEventListener("pagehide", () => flushPrefs(true));
  PR.loadPrefs = async function () {
    if (location.protocol === "file:") return {};
    try {
      const p = await PR.api("/api/prefs");
      if (p.reader) PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), p.reader));
      if (p.keys) PR.ls.set("easyread-keys", Object.fromEntries(Object.entries(p.keys).filter(([, v]) => v !== null)));
      return p;
    } catch (e) { return {}; }
  };

  PR.autosize = function (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };

  /* 圖示：Lucide 的線條圖示（24×24，ISC 授權），一個名字對一段 SVG 內容；樣式在 base.css 的 svg.i */
  const P = {
    menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
    notebook: '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
    edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    en: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    page: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    redo: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    pdf: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    marker: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    stop: '<rect width="12" height="12" x="6" y="6" rx="2"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 20h16"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    log: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    list: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    sparkle: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    question: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    region: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M12 8v8"/><path d="M8 12h8"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    type: '<path d="M21 14h-5"/><path d="M16 16v-3.5a2.5 2.5 0 0 1 5 0V16"/><path d="M4.5 13h6"/><path d="m3 16 4.5-9 4.5 9"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    follow: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    template: '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
    bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
    italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
    bigger: '<path d="M3.5 13h6"/><path d="m2 16 4.5-9 4.5 9"/><path d="M18 16V7"/><path d="m14 11 4-4 4 4"/>',
    sigma: '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  };
  PR.HL_COLORS = [["yellow", PR.t("黄")], ["green", PR.t("绿")], ["blue", PR.t("蓝")], ["pink", PR.t("红")]];  // pink 历史上叫粉，现在画成红
  /* 標誌：一張文件加一道勾（單色線條，顏色由 CSS 的 .mark / .hero 給，預設是強調色） */
  PR.LOGO = '<path d="M8 23.4V9.5a7 7 0 0 1 7-7h13.5"/><path d="M38.2 13.5V20"/><path d="M37.6 31.6v3.9a4.5 4.5 0 0 1-4.5 4.5H24.5"/>' +
    '<path d="M30 2.4 40.5 12.9H33a3 3 0 0 1-3-3z" fill="currentColor" stroke="none"/>' +
    '<path d="M16.6 14.6H27M16.6 20H27" stroke-width="2.7" stroke-linecap="round"/>' +
    '<path d="M20.6 32.2 13 27.9c-5-2.6-10.2 1-9.6 6 .15 1.2.4 2.3.8 3.3 1.8 5.3 8.2 7 13 4L45 22v6.5" stroke-linecap="round"/>';
  PR.logo = (cls) => '<svg class="' + (cls || "mark") + '" viewBox="-1 -1 50 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linejoin="round">' + PR.LOGO + "</svg>";
  PR.icon = (name, cls) => '<svg class="i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || "") + "</svg>";
  PR.icons = { menu: PR.icon("menu"), edit: PR.icon("edit", "sm"), note: PR.icon("note", "sm") };

  PR.toast = function (html, action, ms) {
    let t = PR.$("#toast");
    if (!t) { t = PR.el("div", { id: "toast", role: "status" }); document.body.appendChild(t); }
    t.innerHTML = "<span>" + html + "</span>";
    if (action) {
      const b = PR.el("button", { text: action.label });
      b.onclick = () => { t.classList.remove("open"); action.fn(); };
      t.appendChild(b);
    }
    t.classList.add("open");
    clearTimeout(PR._toastT);
    PR._toastT = setTimeout(() => t.classList.remove("open"), ms || 4200);
  };

  /* 服务接口：写操作带页面加载时拿到的令牌 */
  PR.api = async function (path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    let body = opts.body;
    if (body != null && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { body = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    if (opts.method && opts.method !== "GET") headers["X-Token"] = PR.token || "";
    const r = await fetch(path, { method: opts.method || "GET", headers, body, cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || PR.t("请求失败 {status}", { status: r.status }));
    return data;
  };

  /* 主题：文献库和阅读页共用 */
  PR.applyTheme = function (theme) {
    const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };

  /* 简单事件总线 */
  const subs = {};
  PR.on = (ev, fn) => (subs[ev] = subs[ev] || []).push(fn);
  PR.emit = (ev, data) => (subs[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  /* 通用下拉菜单：items = [{label, icon, kbd, fn} | "-"] */
  PR.menu = function (anchorOrPoint, items) {
    let m = PR.$("#ctxmenu");
    if (!m) { m = PR.el("div", { id: "ctxmenu", class: "menu" }); document.body.appendChild(m); }
    m.innerHTML = '<div class="menu-list">' + items.map((it, i) => it === "-" ? "<hr>" :
      '<button data-i="' + i + '"' + (it.disabled ? " disabled" : "") + ">" + (it.icon ? PR.icon(it.icon, "sm") : "") + "<span>" + PR.esc(it.label) + "</span>" +
      (it.kbd ? '<span class="kbd">' + PR.esc(it.kbd) + "</span>" : "") + "</button>").join("") + "</div>";
    m.onclick = (e) => {
      const b = e.target.closest("[data-i]"); if (!b) return;
      const r = m.getBoundingClientRect();
      PR.lastMenuAt = { x: r.left, y: r.top };  // 菜单项要确认时，确认框就出在菜单原来的位置
      PR.closeMenu(); items[+b.dataset.i].fn();
      setTimeout(() => (PR.lastMenuAt = null), 0);
    };
    m.classList.add("open");
    const r = anchorOrPoint.getBoundingClientRect ? anchorOrPoint.getBoundingClientRect() : { left: anchorOrPoint.x, right: anchorOrPoint.x, top: anchorOrPoint.y, bottom: anchorOrPoint.y };
    const w = m.offsetWidth, h = m.offsetHeight;
    let x = anchorOrPoint.getBoundingClientRect ? r.right - w : r.left;
    let y = r.bottom + 4;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
    m.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + "px";
    m.style.top = y + "px";
  };
  PR.closeMenu = () => { const m = PR.$("#ctxmenu"); m && m.classList.remove("open"); };
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctxmenu")) PR.closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") PR.closeMenu(); });
})(window.PR);
