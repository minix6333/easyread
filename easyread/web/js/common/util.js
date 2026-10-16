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

  /* 文件標題：翻譯過（有譯文標題）的一律用譯文標題——讀者說過：翻譯完的文章，主頁上顯示中文、不要顯示原文。
     以前是「介面語言和譯文語言一樣」才用譯文：介面跟著系統、系統是英文或簡體的電腦（Windows 常這樣）就變成整排英文。
     translated＝主標題是譯文；這時 sub（原文標題）只放在詳細資訊裡，清單、卡片、側欄都不放。short 是側欄用的短標題 */
  PR.titles = function (i) {
    const tr = i.title_zh || "", en = i.title_en || "", lang = i.target || "zh";
    if (tr) return { main: tr, sub: en, subLang: "en", short: i.short_zh || tr.split(/[：:]/)[0], translated: true };
    return { main: en || PR.t("（未命名）"), sub: "", subLang: lang, short: en.split(/:\s/)[0] || PR.t("（未命名）"), translated: false };
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
  /* 上網查資料（2.1.0-tw.12）：問 AI、便利貼、邊注、小視窗追問、筆記 AI 共用一個開關（輸入框旁邊那顆地球），預設開著——
     模型自己判斷要不要查（文件裡就有答案的不會查）。模型不能上網（別家的 API）時不送 web：後端也會擋。 */
  PR.web = {
    on: () => PR.ls.get("easyread-web", true) !== false,
    set(v) { PR.ls.set("easyread-web", !!v); if (PR.emit) PR.emit("web"); },
    ok: (m) => !m || m.web !== false,
    body: (m) => ({ web: PR.web.on() && PR.web.ok(m) }),
  };
  /* 上網查的動作 → 一句話（等待的地方、回答寫到一半又去查時那一行、筆記 AI 的建議標題都用這個） */
  PR.webStatusText = function (s) {
    if (!s) return "";
    if (s.kind === "search") return s.query ? PR.t("搜尋「{q}」", { q: s.query }) : PR.t("上網搜尋");
    if (s.kind === "open") return PR.t("讀 {site}", { site: s.domain || s.url || "" });
    if (s.kind === "find") return PR.t("在 {site} 裡找「{q}」", { site: s.domain || "", q: s.pattern || "" });
    if (s.kind === "note" && s.text) return s.text.length > 60 ? s.text.slice(0, 58) + "…" : s.text;  // 模型動手前說的那句（「我會去查…」）
    return "";
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
  /* now：不等那 0.7 秒，馬上送（換主題這種一下就定的；拉滑桿那種連續的還是等一下） */
  PR.savePrefs = function (section, obj, now) {
    prefQueue[section] = Object.assign(prefQueue[section] || {}, obj);
    clearTimeout(prefT);
    if (now) flushPrefs(); else prefT = setTimeout(flushPrefs, 700);
  };
  function flushPrefs(leaving) {
    clearTimeout(prefT);
    if (!PR.token || location.protocol === "file:" || !Object.keys(prefQueue).length) return;
    const body = prefQueue; prefQueue = {};
    // 主題、外觀是整個 App 共用的：這一格排著要存的可能是舊的（排進去之後別格才改的），送出去之前對到最新，舊的才不會蓋掉新的
    if (body.reader && PR.sharedPrefs) { const cur = PR.sharedPrefs(); for (const k in cur) if (k in body.reader) body.reader[k] = cur[k]; }
    if (leaving) {  // 关页面、刷新时：keepalive 让请求在页面走掉后也能发完
      fetch("/api/prefs", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Token": PR.token }, body: JSON.stringify(body) }).catch(() => {});
    } else PR.api("/api/prefs", { method: "POST", body }).catch(() => { /* 下次改动再存 */ });
  }
  window.addEventListener("pagehide", () => flushPrefs(true));
  PR.flushPrefs = () => flushPrefs();
  PR.loadPrefs = async function () {
    if (location.protocol === "file:") return {};
    try {
      const p = await PR.api("/api/prefs");
      if (p.reader) {
        PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), p.reader));
        // 伺服器存的和這台瀏覽器快取的不一樣時（換了瀏覽器、清過快取）：主題、外觀馬上跟上，記憶裡的那份也對過去
        PR.pullShared && PR.pullShared();
        PR.applyTheme && PR.sharedPrefs && PR.applyTheme(PR.sharedPrefs().theme);
        PR.applyLook && PR.applyLook();
        PR.glassSync && PR.glassSync();
      }
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
    sidebar: '<rect width="18" height="18" x="3" y="3" rx="4"/><path d="M9 3v18"/><path d="M5.5 8h1.5M5.5 11h1.5"/>',
    sort: '<path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m21 16-4 4-4-4"/>',
    panelright: '<rect width="18" height="18" x="3" y="3" rx="4"/><path d="M15 3v18"/>',
    strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
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
    popout: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    dock: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    read: '<path d="M12 21V7"/><path d="m16 12 2 2 4-4"/><path d="M22 6V4a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4 4 4 0 0 0-4-4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6a1 1 0 0 0 1-1v-1.3"/>',
    cursor: '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 22h1a4 4 0 0 0 4-4v-1"/><path d="M7 2h1a4 4 0 0 1 4 4v1"/>',
    quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  };
  /* 螢光筆的顏色（八種；前四種是原本的，順序不能動——數字鍵 1–8 照這個順序）。顏色本身在 css/craft.css 的 .c-<名字> */
  PR.HL_COLORS = [["yellow", PR.t("黄")], ["green", PR.t("绿")], ["blue", PR.t("蓝")], ["pink", PR.t("红")],
    ["orange", PR.t("橙")], ["purple", PR.t("紫")], ["teal", PR.t("青")], ["gray", PR.t("灰")]];  // pink 历史上叫粉，现在画成红
  /* 外觀（設定 → 外觀）：強調色、紙張色調、視窗染色、螢光筆濃度。都存在 easyread-prefs；點了就套到畫面上，不用按儲存。
     強調色、紙張掛在 <html data-accent／data-paper>，染色和濃度是 --tint、--hl-k 兩個變數；顏色本身在 css/craft.css */
  PR.ACCENTS = [["violet", PR.t("紫")], ["blue", PR.t("蓝")], ["teal", PR.t("青")], ["green", PR.t("绿")], ["orange", PR.t("橙")], ["pink", PR.t("粉")], ["red", PR.t("红")], ["graphite", PR.t("石墨")]];
  PR.PAPERS = [["white", PR.t("白")], ["warm", PR.t("暖")], ["cool", PR.t("冷")], ["green", PR.t("绿")]];
  /* 背景：整個視窗後面的一張圖（像 Craft 文件的背景）。內建幾張漸層；"image" 是自選的圖片（存在伺服器，見 backdrop.py），"none" 是不放（桌面版就是透出桌面） */
  PR.BACKDROPS = [["auto", PR.t("跟著主題")], ["none", PR.t("無")], ["mist", PR.t("霧")], ["dawn", PR.t("晨")], ["sea", PR.t("海")], ["forest", PR.t("林")], ["dusk", PR.t("暮")]];
  /* 主題（2.1.0-tw.12）：一組配色（紙、字、材質、畫布、強調色、背景，淺深各一份），顏色寫在 css/themes.css。"" 是原色（不加 data-skin）；
     custom 是自己調的：色調（h）、濃淡（c，0–100）、強調色的色相（a），PR.customSkin 算成 CSS 變數 */
  PR.SKINS = [["", PR.t("原色")], ["mist", PR.t("霧藍")], ["paper", PR.t("紙本")], ["sage", PR.t("鼠尾草")], ["sea", PR.t("海鹽")], ["lavender", PR.t("薰衣草")],
    ["rose", PR.t("玫瑰")], ["honey", PR.t("蜂蜜")], ["latte", PR.t("拿鐵")], ["night", PR.t("夜空")], ["ink", PR.t("墨")], ["custom", PR.t("自訂")]];
  const num = (v, d, lo, hi) => { const n = Number(v); return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : d)); };
  PR.customSkin = function (o) {
    o = o || {};
    const h = num(o.h, 250, 0, 360), c = num(o.c, 45, 0, 100) / 100, a = num(o.a, 265, 0, 360);
    const k = (x) => (x * c).toFixed(4), ok = (l, ch, hue, alpha) => "oklch(" + l + " " + ch + " " + hue + (alpha != null ? " / " + alpha : "") + ")";
    const v = {
      "l-sheet": ok(0.985, k(0.012), h), "l-ink": ok(0.25, k(0.04), h), "l-mat": ok(0.915, k(0.024), h), "l-canvas": ok(0.952, k(0.018), h), "l-accent": ok(0.53, 0.15, a),
      "d-sheet": ok(0.235, k(0.02), h), "d-ink": ok(0.93, k(0.022), h), "d-mat": ok(0.18, k(0.018), h), "d-canvas": ok(0.208, k(0.02), h), "d-accent": ok(0.78, 0.12, a),
      "l-bd": "var(--grain), radial-gradient(120% 80% at 16% 4%, " + ok(0.99, k(0.01), h, 0.9) + ", transparent 60%), radial-gradient(90% 75% at 88% 22%, " + ok(0.86, 0.07, a, 0.55) +
        ", transparent 62%), linear-gradient(180deg, " + ok(0.91, k(0.026), h) + " 0%, " + ok(0.87, k(0.032), h) + " 55%, " + ok(0.82, k(0.036), h) + " 100%)",
      "d-bd": "var(--grain), radial-gradient(110% 80% at 14% 3%, " + ok(0.5, 0.09, a, 0.42) + ", transparent 60%), radial-gradient(90% 80% at 88% 22%, " + ok(0.42, k(0.06), h, 0.32) +
        ", transparent 62%), radial-gradient(120% 90% at 50% 108%, rgba(6, 7, 10, .82), transparent 62%), linear-gradient(180deg, " + ok(0.32, k(0.04), h) + " 0%, " + ok(0.24, k(0.03), h) + " 50%, " + ok(0.15, k(0.02), h) + " 100%)",
    };
    return Object.keys(v).map((key) => "--skc-" + key + ":" + v[key]).join(";");
  };
  const LOOK = {
    skin: (v) => (PR.SKINS.some(([k]) => k === v) ? v : ""),
    skinCustom: (v) => ({ h: num((v || {}).h, 250, 0, 360), c: num((v || {}).c, 45, 0, 100), a: num((v || {}).a, 265, 0, 360) }),
    accent: (v) => (PR.ACCENTS.some(([k]) => k === v) ? v : "violet"),
    paper: (v) => (PR.PAPERS.some(([k]) => k === v) ? v : "white"),
    backdrop: (v) => ((v === "image" && location.protocol !== "file:") || PR.BACKDROPS.some(([k]) => k === v) ? v : "auto"),
    backdropV: (v) => Math.max(0, Math.round(Number(v)) || 0),                       // 自選圖片的版本（換一張就變，網址帶著）
    tint: (v) => Math.max(0, Math.min(100, Math.round(Number(v)) || 0)),          // 視窗染上多少強調色
    hl: (v) => Math.max(50, Math.min(160, Math.round(Number(v)) || 100)),         // 螢光筆濃度（百分比）
  };
  PR.look = function () {
    const p = PR.ls.get("easyread-prefs", {}) || {}, o = {};
    for (const k of Object.keys(LOOK)) o[k] = LOOK[k](p[k]);
    return o;
  };
  PR.accent = () => PR.look().accent;
  PR.applyLook = function () {
    const k = PR.look(), d = document.documentElement;
    if (k.skin) d.dataset.skin = k.skin; else delete d.dataset.skin;
    if (k.skin === "custom") PR.customSkin(k.skinCustom).split(";").forEach((kv) => { const i = kv.indexOf(":"); d.style.setProperty(kv.slice(0, i), kv.slice(i + 1)); });
    else Array.from(d.style).filter((n) => n.startsWith("--skc-")).forEach((n) => d.style.removeProperty(n));
    if (k.accent === "violet") delete d.dataset.accent; else d.dataset.accent = k.accent;
    if (k.paper === "white") delete d.dataset.paper; else d.dataset.paper = k.paper;
    if (k.backdrop === "none") delete d.dataset.backdrop; else d.dataset.backdrop = k.backdrop;
    for (const [name, file] of [["--bd", "backdrop.jpg"], ["--bd-s", "backdrop-s.jpg"]]) {
      if (k.backdrop === "image") d.style.setProperty(name, 'url("/' + file + "?v=" + k.backdropV + '") center / cover no-repeat');
      else d.style.removeProperty(name);
    }
    d.style.setProperty("--tint", String(k.tint));
    d.style.setProperty("--hl-k", String(k.hl / 100));
  };
  PR.applyAccent = PR.applyLook;
  PR.setLook = function (key, value, opts) {
    if (!LOOK[key]) return;
    const v = LOOK[key](value), p = PR.ls.get("easyread-prefs", {}) || {};
    p[key] = v;
    if (key === "skinCustom" || (key === "skin" && v === "custom")) p.skinVars = PR.customSkin(p.skinCustom);  // 每一頁一開頭直接套這一串（不用等 util.js）
    PR.ls.set("easyread-prefs", p);
    if (PR.prefs) PR.prefs[key] = v;
    const slider = key === "tint" || key === "hl" || key === "skinCustom";
    if (PR.savePrefs) PR.savePrefs("reader", Object.assign({ [key]: v }, p.skinVars && (key === "skinCustom" || key === "skin") ? { skinVars: p.skinVars } : {}), !slider);  // 滑桿拉的時候一直在變：等停了再存
    if (opts && opts.apply === false) return;  // 一次改好幾樣（換主題）：都寫好再一起套
    if (opts && opts.animate) PR.lookTransition(PR.applyLook); else PR.applyLook();
  };
  /* 換主題：照 Craft 選主題的整個主題一起換——強調色回到主題自己的、背景跟著主題（自選的圖片留著）。用畫面淡入淡出換（不是一塊塊跳色） */
  PR.setSkin = function (id) {
    const p = PR.ls.get("easyread-prefs", {}) || {};
    // 先把設定都寫好（馬上讀得到新的主題：設定對話框接著重畫要知道），畫面在淡入淡出裡一次換過去
    PR.setLook("accent", "violet", { apply: false });
    if (p.backdrop !== "image" && p.backdrop !== "none") PR.setLook("backdrop", "auto", { apply: false });
    PR.setLook("skin", id, { apply: false });
    PR.lookTransition(PR.applyLook);
  };
  /* 外觀換了（主題、深淺）：整個畫面淡入淡出換過去（View Transitions），不是每個元件各自跳色；減少動態、不支援的瀏覽器就直接換 */
  PR.lookTransition = function (fn) {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || !document.startViewTransition || document.visibilityState !== "visible") { fn(); return; }
    try {
      const t = document.startViewTransition(fn);
      if (t && t.ready) t.ready.catch(() => {});
      if (t && t.finished) t.finished.catch(() => {});
    } catch (e) { fn(); }
  };
  PR.setAccent = (a) => PR.setLook("accent", a);
  /* 自選背景圖：在瀏覽器裡先縮好再送——大的那張最長邊 2560，小的那張 72（放大就是糊的，材質那一層用） */
  PR.uploadBackdrop = async function (file) {
    const bmp = await createImageBitmap(file);
    const shrink = (max, q, soft) => {
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      const g = c.getContext("2d");
      if (soft) g.filter = "blur(" + soft + "px)";
      g.drawImage(bmp, -4, -4, c.width + 8, c.height + 8);  // 稍微畫出去一點：邊緣才不會被模糊吃成黑邊
      return c.toDataURL("image/jpeg", q);
    };
    const r = await PR.api("/api/backdrop", { method: "POST", body: { image: shrink(2560, 0.86, 0), small: shrink(72, 0.82, 1.2) } });
    PR.setLook("backdropV", r.v);
    PR.setLook("backdrop", "image");
  };
  /* 主題也是點了就換、馬上存（設定 → 外觀、文獻庫的「⋯」、閱讀頁的 Aa 都走這裡）。先寫 localStorage 再套：那是共用的那一份 */
  PR.setTheme = function (theme) {
    theme = theme === "dark" || theme === "light" ? theme : "auto";
    if (PR.setPref && PR.prefs) return PR.setPref("theme", theme);  // 閱讀頁：和 Aa 面板裡的主題是同一個設定，走它那條路
    const p = PR.ls.get("easyread-prefs", {}) || {};
    p.theme = theme;
    PR.ls.set("easyread-prefs", p);
    if (PR.prefs) PR.prefs.theme = theme;
    if (PR.savePrefs) PR.savePrefs("reader", { theme }, true);
    PR.lookTransition(() => PR.applyTheme(theme));  // 深淺色換過去是整個畫面淡入淡出，不是每個元件各自跳色
  };
  /* 標誌：一張文件加一道勾（單色線條，顏色由 CSS 的 .mark / .hero 給，預設是強調色） */
  /* FOLI 的標誌：藍色的方塊、白色的折紙（顏色由 CSS 的 .lg-tile/.lg-s/.lg-a/.lg-b 決定）。和 web/logo.svg、electron/assets/icon.svg 是同一個形狀 */
  PR.LOGO = '<rect class="lg-tile" width="64" height="64" rx="14"/><g transform="translate(32 32) scale(1.5) translate(-33.7 -32.9)"><path class="lg-s" d="M20.4 24.4 C20.4 22.3 22.1 20.6 24.2 20.6 L28.4 20.6 L28.4 47.6 C25 47.6 20.4 46.8 20.4 43.2 Z"/><path class="lg-b" d="M28.4 33.2 C31.6 31.9 35.8 31.3 40.2 31.3 L43.6 31.3 L43.6 37.6 C43.6 41 41.4 43 38 44 C34.4 45.1 31 45.7 28.4 47.6 Z"/><path class="lg-a" d="M28.4 20.6 L44.2 18.2 C45.8 17.9 47 19 47 20.6 L47 27.2 C47 30.6 44.9 32.4 41.2 32.8 C36.5 33.3 31.6 33 28.4 35.3 Z"/></g>';
  PR.logo = (cls) => '<svg class="' + (cls || "mark") + '" viewBox="0 0 64 64" aria-hidden="true">' + PR.LOGO + "</svg>";
  PR.icon = (name, cls) => '<svg class="i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || "") + "</svg>";
  PR.addIcons = (more) => Object.assign(P, more);  // icons-extra.js（從 Lucide 產生的那一批）掛進同一張表
  PR.hasIcon = (name) => !!P[name];
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
    if (!r.ok) { const err = new Error(data.error || PR.t("请求失败 {status}", { status: r.status })); err.status = r.status; throw err; }  // status：呼叫的人要分「沒有這個東西」和「暫時連不上」
    return data;
  };

  /* ---------- 主題和外觀：整個 App 共用，以 localStorage 的 easyread-prefs 為準 ----------
     外殼裡的每一格（iframe）、每個視窗各有自己的記憶（閱讀頁的 PR.prefs）。以前各套各的：別格換了主題，這一格的記憶沒跟上，
     之後它一「重新套用設定」就把舊的主題套回去、還存起來，另一格發現又套回來——兩格記的不一樣就互相蓋個沒完，
     整個視窗一秒閃幾千次（2.1.0-tw.5）。規矩：
     - 只有使用者改了才寫（PR.setTheme／PR.setLook／閱讀頁的 PR.setPref），而且先寫 localStorage 再套；
     - 別格改了（storage 事件）：跟上、把記憶對過去，不寫任何東西；
     - 系統外觀變了：主題是「跟隨系統」才重算，一樣不寫；明確選了淺色／深色的不理它；
     - 閱讀頁重新套用設定（applyPrefs）之前先 PR.pullShared()，記憶裡過期的值套不回去。
     scripts/theme_loop_check.cjs 會開外殼＋兩份文件實際換一遍，數有沒有在閃。 */
  PR.SHARED_PREFS = ["theme", "skin", "skinCustom", "skinVars", "accent", "paper", "backdrop", "backdropV", "tint", "hl", "glass", "clear"];
  PR.sharedPrefs = function () {
    const s = PR.ls.get("easyread-prefs", {}) || {}, o = {};
    for (const k of PR.SHARED_PREFS) if (s[k] !== undefined) o[k] = s[k];
    return o;
  };
  PR.pullShared = function () { if (PR.prefs) Object.assign(PR.prefs, PR.sharedPrefs()); };

  let sentSource = null, flipTimes = [], frozenUntil = 0;
  PR.applyTheme = function (theme) {
    const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "dark" : "light", root = document.documentElement;
    if (root.dataset.theme !== next) {
      // 保險絲：正常用不可能兩秒內換十幾次。真的發生就是哪裡又在互相蓋：停三秒不跟，畫面不會一直閃
      const now = Date.now();
      if (now < frozenUntil) return;
      flipTimes = flipTimes.filter((t) => now - t < 2000);
      flipTimes.push(now);
      if (flipTimes.length > 16) { frozenUntil = now + 3000; flipTimes = []; console.warn("theme is flipping back and forth; pausing"); return; }
      root.dataset.theme = next;
    }
    // 桌面版：視窗的材質、系統畫的東西要跟著亮暗（只有最外層那一頁拿得到橋；iframe 裡改了主題，外殼靠 storage 事件跟上）。同一個值只送一次
    try {
      const d = window.easyreadDesktop, src = theme === "dark" || theme === "light" ? theme : "system";
      if (d && d.setTheme && src !== sentSource) { sentSource = src; d.setTheme(src); }
    } catch (e) { /* 不是桌面版 */ }
  };
  addEventListener("storage", (e) => {
    if (e.key !== "easyread-prefs") return;
    const s = PR.sharedPrefs(), root = document.documentElement;
    PR.pullShared();
    const dark = s.theme === "dark" || (s.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    const big = root.dataset.theme !== (dark ? "dark" : "light") || (root.dataset.skin || "") !== (s.skin || "");  // 深淺、主題換了：跟著淡入淡出；拉滑桿那種一直在變的直接套
    const go = () => { PR.applyTheme(s.theme); if (PR.applyLook) PR.applyLook(); };
    if (big && PR.lookTransition) PR.lookTransition(go); else go();
    PR.emit && PR.emit("shared-prefs", s);  // 閱讀頁的 Aa 開著的話，選中的那一格跟上
  });
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const t = (PR.ls.get("easyread-prefs", {}) || {}).theme;
      if (t !== "dark" && t !== "light") PR.applyTheme("auto");
    });
    PR.applyTheme((PR.ls.get("easyread-prefs", {}) || {}).theme);  // 一載入就對一次：最外層那一頁順便告訴桌面版現在是亮是暗（視窗材質要一致）
  }

  /* 简单事件总线 */
  const subs = {};
  PR.on = (ev, fn) => (subs[ev] = subs[ev] || []).push(fn);
  PR.emit = (ev, data) => (subs[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  /* 快捷鍵的寫法：程式裡一律寫 Mac 的符號（⌘⌥⇧↩⌫），不是 Mac 的電腦顯示成 Ctrl+、Alt+、Shift+、Enter、Backspace */
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  PR.kbd = (s) => (IS_MAC ? s : String(s).replace(/⌃/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+").replace(/⌘/g, "Ctrl+").replace(/↩/g, "Enter").replace(/⌫/g, "Backspace").replace(/Ctrl\+Ctrl\+/g, "Ctrl+"));
  /* 通用下拉選單。items 裡可以放：
       "-"                                       分隔線
       { label, icon, kbd, fn, disabled, danger, checked }   一般的一列（checked：右邊打勾）
       { label, icon, sub: [items] }             子選單：點了整個選單換成那一層（最上面一列是「‹ 返回」）
       { head: "小標" }                          一行小字的分組標題
       { row: [{ icon, title, on, fn, disabled }] }   一排圖示鈕（轉成哪一種區塊之類）
       { dots: [{ color, title, on, fn }] }      一排色點（color 是 CSS 顏色；空字串＝「不上色」那一顆）
     鍵盤：↑↓ 走、Enter 選、→ 進子選單、← 回上一層、Esc 關。 */
  PR.menu = function (anchorOrPoint, items) {
    let m = PR.$("#ctxmenu");
    if (!m) { m = PR.el("div", { id: "ctxmenu", class: "menu" }); document.body.appendChild(m); }
    const stack = [];  // 進了幾層子選單
    let cur = items.filter(Boolean);
    const rowHtml = (it, i) => {
      if (it === "-") return "<hr>";
      if (it.head) return '<div class="menu-head">' + PR.esc(it.head) + "</div>";
      if (it.row) return '<div class="menu-row">' + it.row.map((b, k) => '<button data-i="' + i + '" data-k="' + k + '" title="' + PR.esc(b.title || "") + '" class="' + (b.on ? "on" : "") + '"' + (b.disabled ? " disabled" : "") + ">" + PR.icon(b.icon, "sm") + "</button>").join("") + "</div>";
      if (it.dots) return '<div class="menu-dots">' + it.dots.map((d, k) => '<button data-i="' + i + '" data-k="' + k + '" title="' + PR.esc(d.title || "") + '" class="' + (d.on ? "on" : "") + (d.color ? "" : " none") + '"' + (d.color ? ' style="--dot:' + PR.esc(d.color) + '"' : "") + "></button>").join("") + "</div>";
      return '<button data-i="' + i + '" class="mi' + (it.danger ? " danger" : "") + '"' + (it.disabled ? " disabled" : "") + ">" + (it.icon ? PR.icon(it.icon, "sm") : "") + "<span>" + PR.esc(it.label) + "</span>" +
        (it.kbd ? '<span class="kbd">' + PR.esc(PR.kbd(it.kbd)) + "</span>" : "") + (it.checked ? '<span class="tick">' + PR.icon("check", "sm") + "</span>" : "") + (it.sub ? '<span class="tick sub">' + PR.icon("next", "sm") + "</span>" : "") + "</button>";
    };
    const paint = () => {
      m.innerHTML = '<div class="menu-list">' + (stack.length ? '<button class="mi back" data-back>' + PR.icon("back", "sm") + "<span>" + PR.esc(stack[stack.length - 1].label) + "</span></button><hr>" : "") + cur.map(rowHtml).join("") + "</div>";
    };
    const place = () => {
      const r = anchorOrPoint.getBoundingClientRect ? anchorOrPoint.getBoundingClientRect() : { left: anchorOrPoint.x, right: anchorOrPoint.x, top: anchorOrPoint.y, bottom: anchorOrPoint.y };
      const w = m.offsetWidth, h = m.offsetHeight;
      let x = anchorOrPoint.getBoundingClientRect ? (anchorOrPoint.dataset && anchorOrPoint.dataset.menuAlign === "left" ? r.left : r.right - w) : r.left;
      let y = r.bottom + 4;
      if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
      m.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + "px";
      m.style.top = y + "px";
      PR.growFrom(m, r);
    };
    const enter = (it) => { stack.push({ label: it.label, items: cur }); cur = it.sub.filter(Boolean); paint(); place(); };
    const back = () => { const s = stack.pop(); if (!s) return; cur = s.items; paint(); place(); };
    const run = (fn) => {
      const r = m.getBoundingClientRect();
      PR.lastMenuAt = { x: r.left, y: r.top };  // 菜单项要确认时，确认框就出在菜单原来的位置
      PR.closeMenu(); fn();
      setTimeout(() => (PR.lastMenuAt = null), 0);
    };
    m.onclick = (e) => {
      if (e.target.closest("[data-back]")) return back();
      const b = e.target.closest("[data-i]"); if (!b || b.disabled) return;
      const it = cur[+b.dataset.i];
      if (it.sub) return enter(it);
      const leaf = it.row ? it.row[+b.dataset.k] : it.dots ? it.dots[+b.dataset.k] : it;
      if (leaf && leaf.fn) run(leaf.fn);
    };
    m.onmousedown = (e) => e.preventDefault();  // 點選單不搶焦點（正在編的區塊才不會被收起來）
    PR.menuKey = (e) => {  // 開著的時候鍵盤歸選單
      const rows = PR.$$(".menu-list > button.mi:not([disabled])", m);
      let at = rows.findIndex((r) => r.classList.contains("kb-on"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        at = (at + (e.key === "ArrowDown" ? 1 : rows.length - 1) + (at < 0 && e.key === "ArrowUp" ? 1 : 0)) % rows.length;
        rows.forEach((r, k) => r.classList.toggle("kb-on", k === at));
        if (rows[at]) rows[at].scrollIntoView({ block: "nearest" });
        return true;
      }
      if (e.key === "Enter" || e.key === "ArrowRight") { if (at >= 0 && (e.key === "Enter" || rows[at].querySelector(".sub"))) { rows[at].click(); return true; } return e.key === "Enter"; }
      if (e.key === "ArrowLeft" && stack.length) { back(); return true; }
      return false;
    };
    paint();
    m.classList.add("open");
    place();
    return m;
  };
  /* 浮層（選單、小框、挑圖示的面板、確認框）從叫它出來的地方「長」出來：把縮放的原點定在觸發點相對於浮層的位置。
     以前一律是左上角——選單靠右對齊、或下面放不下改往上開的時候，看起來是從不相干的角落冒出來的。
     r：觸發點的位置（getBoundingClientRect 那種，或 {left, right, top, bottom}）；浮層要先擺好 left／top */
  PR.growFrom = function (el, r) {
    if (!el || !r) return;
    const left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0, w = el.offsetWidth, h = el.offsetHeight;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    el.style.transformOrigin = Math.round(Math.max(0, Math.min(w, cx - left))) + "px " + Math.round(Math.max(0, Math.min(h, cy - top))) + "px";
  };
  PR.menuOpen = () => { const m = PR.$("#ctxmenu"); return !!(m && m.classList.contains("open")); };
  PR.closeMenu = () => { const m = PR.$("#ctxmenu"); m && m.classList.remove("open"); };
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctxmenu")) PR.closeMenu(); });
  document.addEventListener("keydown", (e) => {
    if (!PR.menuOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return PR.closeMenu(); }
    if (PR.menuKey && PR.menuKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})(window.PR);
