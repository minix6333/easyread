/* 设置对话框（文献库页和阅读页共用）：外壳、分页、保存。
   页：模型（翻译和问 AI 合在一起，settings-chat.js）、阅读 / 侧边栏 / 快捷键（settings-tabs.js 等）。
   本文件里的 engine 不再单独成页，只留它的 collect：存的时候从 cfg 取翻译设置。
   PR.openSettings("keys") 直接打开某一页；不指定就从“模型”页开始（不记上次停在哪页）。 */
(function (PR) {
  "use strict";
  const dlg = () => PR.$("#settingsDlg");
  const ALL_TABS = [["chat", PR.t("模型")], ["look", PR.t("外觀")], ["reading", PR.t("阅读")], ["library", PR.t("侧边栏")], ["cloud", PR.t("云文献库")], ["keys", PR.t("快捷键")]];
  const tabs = () => ALL_TABS.filter(([k]) => PR.settingsTabs[k]);  // “侧边栏”页只在文献库页面有
  PR.settingsTabs = PR.settingsTabs || {};
  const st = (PR.settingsState = { tab: "chat", cfg: null, presets: [], groups: [], found: null, chat: null, ui: null });

  PR.opt = (list, val) => list.map(([v, l]) => '<option value="' + PR.esc(v) + '"' + (String(v) === String(val) ? " selected" : "") + ">" + PR.esc(l) + "</option>").join("");

  PR.openSettings = async function (tab) {
    await modelSaveQueue;
    const [d, chat] = await Promise.all([PR.api("/api/config"), PR.api("/api/chat/models").catch(() => null)]);
    Object.assign(st, { tab: typeof tab === "string" && tab !== "engine" ? tab : "chat", cfg: d.config, presets: d.presets, groups: d.groups || [], chat,
      fetchMsg: null, apiTyping: false, advOpen: false, ui: { features: Object.assign({}, PR.features), keys_on: PR.keysOn, keys: Object.assign({}, PR.keymap) },
      theme: PR.ls.get("easyread-prefs", {}).theme || "auto", recording: null, editing: null, form: null, chatKeys: null, type: null, transChecked: false, pinned: false });
    render();
    dlg().classList.add("open");
    // 每次打开都问一次（后端有缓存，很快）：刚装好或更新了 Claude Code / Codex，版本号和模型名单马上跟上
    const r = await PR.api("/api/engines").catch(() => null);
    if (r && (JSON.stringify([r.found, r.models]) !== JSON.stringify([st.found, st.models]))) {
      st.found = r.found; st.models = r.models;
      if (dlg().classList.contains("open")) { sync(); render(); }
    }
  };
  window.addEventListener("focus", async () => {
    if (!dlg().classList.contains("open")) return;
    const r = await PR.api("/api/engines").catch(() => null);
    if (r && JSON.stringify(r.models) !== JSON.stringify(st.models)) {
      sync(); st.models = r.models; st.found = r.found; render();
    }
  });
  const btn = PR.$("#settingsBtn");
  if (btn) btn.onclick = () => PR.openSettings();

  function sync() { const t = PR.settingsTabs[st.tab]; if (t && t.sync) t.sync(st, dlg()); }
  PR.settingsRender = render;
  function render() {
    const t = PR.settingsTabs[st.tab];
    dlg().querySelector(".dialog").innerHTML =
      '<div class="set-head"><h2>' + PR.t("设置") + '</h2><div class="set-tabs">' + tabs().map(([k, l]) => '<button data-set-tab="' + k + '" class="' + (st.tab === k ? "on" : "") + '">' + l + "</button>").join("") + "</div>" + (st.tab === "chat" ? saveStatusHtml() : "") + "</div>" +
      '<div class="set-body">' + (t ? t.render(st) : "") + "</div>" +
      '<div class="actions set-foot"><button class="linkish" id="showLog">' + PR.t("运行日志") + '</button>' + (PR.$("#langBtn") && location.protocol !== "file:" ? '<button class="linkish lang-link" id="setLang">' + (PR.lang === "en" ? "中文介面" : "English") + "</button>" : "") + '<span class="grow"></span>' +  // i18n-ok 寫的是要切換到的語言
      // 模型那一頁自己會存、外觀那一頁點了就生效：前者只有「關閉」，後者只有「完成」（順便把別頁還沒存的一起存了）；其他頁是取消／儲存
      (st.tab === "look" ? '<button class="btn" data-look-reset>' + PR.t("恢復預設外觀") + "</button>" : '<button class="btn" id="setCancel">' + (st.tab === "chat" ? PR.t("关闭") : PR.t("取消")) + "</button>") +
      (st.tab === "chat" ? "" : '<button class="btn primary" id="setSave">' + (st.tab === "look" ? PR.t("完成") : PR.t("保存")) + "</button>") + "</div>";
  }

  function saveStatusHtml() {
    return '<span id="modelSaveStatus" class="set-save-status" data-state="' + (st.modelSavePhase || "idle") + '" role="status" aria-live="polite" title="' + PR.esc(st.modelSaveDetail || "") + '">' + PR.esc(st.modelSaveStatus || "") + '</span>';
  }
  let statusTimer, saveRevision = 0;
  function setSaveStatus(phase, text, detail = "") {
    clearTimeout(statusTimer);
    Object.assign(st, { modelSavePhase: phase, modelSaveStatus: text, modelSaveDetail: detail });
    const el = PR.$("#modelSaveStatus");
    if (el) { el.dataset.state = phase; el.textContent = text; el.title = detail; }
    if (phase === "saved") statusTimer = setTimeout(() => setSaveStatus("idle", ""), 2200);
  }

  let modelSaveQueue = Promise.resolve();
  PR.saveModelSettings = function () {
    const config = JSON.parse(JSON.stringify(PR.settingsTabs.engine.collect(st)));
    const chat = JSON.parse(JSON.stringify({ models: st.chat.models, default: st.chat.default, keys: st.chatKeys || {} }));
    const revision = ++saveRevision;
    setSaveStatus("saving", PR.t("正在保存…"));
    modelSaveQueue = modelSaveQueue.then(async () => {
      await PR.api("/api/chat/models", { method: "POST", body: chat });
      await PR.api("/api/config", { method: "POST", body: config });
      if (revision === saveRevision) setSaveStatus("saved", PR.t("已保存"));
      PR.onSettingsSaved && PR.onSettingsSaved();
      PR.emit("settings-saved", st);
    }).catch((err) => {
      if (revision === saveRevision) setSaveStatus("error", PR.t("保存失败"), err.message);
      PR.toast(PR.t("保存失败：{msg}", { msg: err.message }));
    });
    return modelSaveQueue;
  };

  async function save() {
    await modelSaveQueue;
    sync();
    const r = await PR.api("/api/config", { method: "POST", body: PR.settingsTabs.engine.collect(st) });
    st.cfg = r.config;
    if (st.chat) st.chat = await PR.api("/api/chat/models", { method: "POST", body: { models: st.chat.models, default: st.chat.default, keys: st.chatKeys || {} } });
    PR.applyUi(st.ui, true);
    PR.ls.set("easyread-auto-translate", !!st.cfg.auto_translate);
    // 主題不在這裡存：「外觀」那一頁點了就已經換好、存好了（PR.setTheme）。以前這裡會把開對話框時記下的主題再寫一次——可能已經是舊的
    if (st.type) {  // 排版：阅读页里立刻生效；文献库页只存起来
      PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), st.type));
      if (PR.resetAllType) PR.resetAllType(st.type); else PR.savePrefs("reader", st.type);
    }
    if (st.target && st.target !== PR.target) {  // 译文语言存在 config.json，按钮文字跟着变，所以也刷新一下
      await PR.api("/api/config", { method: "POST", body: { target: st.target } });
      if (!st.lang || st.lang === PR.langChoice) return location.reload();
    }
    if (st.lang && st.lang !== PR.langChoice) {  // 换界面语言：存好后刷新，页面由后端按新语言重新生成
      await PR.api("/api/prefs", { method: "POST", body: { ui: { lang: st.lang } } });
      return location.reload();
    }
    dlg().classList.remove("open");
    PR.toast(PR.t("设置已保存"));
    PR.onSettingsSaved && PR.onSettingsSaved();
    PR.emit("settings-saved", st);
  }

  PR.showText = function (title, text) {
    const d = PR.$("#textDlg");
    d.querySelector(".dialog").innerHTML = "<h2>" + PR.esc(title) + '</h2><pre class="logview">' + PR.esc(text || PR.t("（还没有记录）")) + '</pre><div class="actions"><button class="btn" data-close>' + PR.t("关闭") + "</button></div>";
    d.classList.add("open");
    const pre = d.querySelector("pre"); pre.scrollTop = pre.scrollHeight;
  };
  const td = PR.$("#textDlg");
  if (td) td.addEventListener("click", (e) => { if (e.target.id === "textDlg" || e.target.closest("[data-close]")) td.classList.remove("open"); });

  dlg().addEventListener("click", async (e) => {
    if (e.target === dlg() || e.target.closest("#setCancel")) { st.recording = null; return dlg().classList.remove("open"); }
    const tb = e.target.closest("[data-set-tab]");
    if (tb) {
      sync(); st.tab = tb.dataset.setTab; st.recording = null; st.editing = null; render();
      // 換頁：內容淡進來、往上浮一點點（設定一次會點好幾頁，所以很短）
      const body = dlg().querySelector(".set-body");
      if (body && body.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) body.animate([{ opacity: 0, translate: "0 6px" }, { opacity: 1, translate: "0 0" }], { duration: 220, easing: "cubic-bezier(.23, 1, .32, 1)" });
      return;
    }
    // 外觀那一頁：點了就換、馬上存，不用按儲存
    const pick = (attr, apply) => { const b = e.target.closest("[" + attr + "]"); if (!b) return false; apply(b.getAttribute(attr)); PR.$$("[" + attr + "]", dlg()).forEach((x) => x.classList.toggle("on", x === b)); return true; };
    const sk = e.target.closest("[data-skin-pick]");
    if (sk) { PR.setSkin(sk.dataset.skinPick); return render(); }  // 換主題：整套一起換（強調色、背景跟著主題），畫面淡入淡出
    if (pick("data-accent-pick", (v) => PR.setLook("accent", v))) return;
    if (pick("data-paper-pick", (v) => PR.setLook("paper", v))) return;
    if (pick("data-backdrop-pick", (v) => PR.setLook("backdrop", v))) return;
    if (e.target.closest("[data-backdrop-add]")) { PR.$("[data-backdrop-file]", dlg()).click(); return; }
    if (pick("data-look-theme", (v) => { st.theme = v; PR.setTheme(v); })) return;
    if (e.target.closest("[data-look-reset]")) {
      for (const [key, v] of [["skin", ""], ["accent", "violet"], ["paper", "white"], ["backdrop", "auto"], ["tint", 0], ["hl", 100]]) PR.setLook(key, v);
      if (PR.setGlass) { PR.setGlass(60); PR.setClear(75); }
      return render();
    }
    if (e.target.closest("#setLang")) { PR.$("#langBtn").click(); return; }  // 介面語言：還是頂欄那顆（藏著的）按鈕在做
    if (e.target.closest("#showLog")) { const r = await PR.api("/api/log"); PR.showText(PR.t("运行日志"), r.text + "\n\n" + PR.t("（完整日志：{path}）", { path: r.path })); return; }
    if (e.target.closest("#setSave")) { try { await save(); } catch (err) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(err.message) })); } return; }
    const t = PR.settingsTabs[st.tab];
    if (t && t.click && (await t.click(e, st, dlg()))) render();
  });
  dlg().addEventListener("input", (e) => {  // 外觀的滑桿：拉著就看得到，不用按保存
    const r = e.target.closest("input.look-range");
    if (!r) return;
    r.style.setProperty("--p", Math.round(((+r.value - +r.min) / (+r.max - +r.min)) * 100) + "%");  // 軌道填到哪裡
    if (r.dataset.look) PR.setLook(r.dataset.look, +r.value);
    else if (r.dataset.skinCustom) {  // 自訂主題的滑桿：拉著就換；滑桿自己的顏色（色相軌道）、上面的預覽卡跟著變
      const c = Object.assign({}, PR.look().skinCustom, { [r.dataset.skinCustom]: +r.value });
      PR.setLook("skinCustom", c);
      PR.$$("input[data-skin-custom]", dlg()).forEach((x) => { x.style.setProperty("--h", c.h); x.style.setProperty("--a", c.a); });
      const card = PR.$('.skin-card[data-skin-pick="custom"] .sk-scope', dlg());
      if (card) card.setAttribute("style", PR.customSkin(c));
    }
    else if (r.hasAttribute("data-glass-level") && PR.setGlass) PR.setGlass(+r.value);  // 不能用 data-glass：那是玻璃元素自己的記號
    else if (r.hasAttribute("data-clear-level") && PR.setClear) PR.setClear(+r.value);
  });
  dlg().addEventListener("change", async (e) => {
    if (e.target.matches && e.target.matches("[data-backdrop-file]")) {  // 外觀 → 背景 → 挑一張圖片：縮好、存起來、馬上換上
      const f = e.target.files && e.target.files[0], add = PR.$("[data-backdrop-add]", dlg());
      e.target.value = "";
      if (!f) return;
      if (add) add.classList.add("busy");
      try { await PR.uploadBackdrop(f); } catch (err) { PR.toast(PR.t("這張圖用不了：{msg}", { msg: PR.esc(err.message) })); }
      if (st.tab === "look" && dlg().classList.contains("open")) render();
      return;
    }
    const t = PR.settingsTabs[st.tab];
    if (t && t.change && t.change(e, st, dlg())) render();
  });
  document.addEventListener("keydown", (e) => {
    if (!dlg().classList.contains("open")) return;
    const t = PR.settingsTabs[st.tab];
    if (st.recording && t && t.key) { e.preventDefault(); e.stopImmediatePropagation(); if (t.key(e, st)) render(); return; }
    if (e.key === "Escape") dlg().classList.remove("open");
  }, true);

  /* ---------- 翻译设置：存的时候从 cfg 取（页面在 settings-chat.js，改动随时写回 cfg） ---------- */
  PR.settingsTabs.engine = {
    collect(state) {
      const c = state.cfg, o = c.openai;
      return { engine: c.engine, batch_pages: c.batch_pages, concurrency: c.concurrency, page_cap: c.page_cap, auto_translate: !!c.auto_translate, preread: c.preread !== false, web_images: c.web_images !== false,
        quick: { translate_model: (c.quick || {}).translate_model || "" },
        claude: { model: c.claude.model, command: c.claude.command, reasoning_effort: c.claude.reasoning_effort || "" },
        codex: { model: c.codex.model, command: c.codex.command, reasoning_effort: c.codex.reasoning_effort || "", service_tier: c.codex.service_tier || "" },
        openai: { preset: o.preset, base_url: o.base_url, api: o.api, model: o.model, api_key: o.api_key, vision: o.vision,
          reasoning_effort: o.reasoning_effort || "", service_tier: o.service_tier || "" } };
    },
  };
})(window.PR);
