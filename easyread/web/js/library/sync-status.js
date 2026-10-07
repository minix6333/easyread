/* 雲端同步的狀態：文獻庫頂欄的一顆雲，點開看得到「哪些電腦在用這個文獻庫、多久前上線、對方有沒有收到這台的更新」。
   同步出問題最常見的原因不是程式壞了，而是兩台電腦指著不同的資料夾——以前畫面上完全看不出來。現在：
   - 另一台有連上：雲上是綠點，點開每台一行（剛剛上線 · 雙向同步正常）。
   - 這台用的是本機資料夾，而雲端硬碟裡已經有文獻庫：橘點＋清單上方一條提示，一鍵「改用它」（這台的論文一起併過去，完成後自動重啟）。
   - 雲端硬碟裡還有別的 EasyRead 資料夾（另一台可能正在用那個）：一鍵「合併進來」；舊資料夾不刪，只留路標，另一台下次啟動會自己跟過來。
   - 這台是跟著路標自動換過來的：說一聲。
   伺服器端見 cloudsync.py（/api/sync、/api/sync/pull、/api/sync/absorb）。PR.syncView 是純函式（tests/test_sync_status.cjs）。 */
(function (PR) {
  "use strict";
  const OS = { win32: "Windows", darwin: "Mac", linux: "Linux" };
  const DISMISS = "easyread-sync-dismissed";
  let data = null, open = false, busy = false, timer = null;

  /* 純函式：/api/sync 的回應 → 畫面要的東西 {show, tone, title, lines:[{dot,name,text}], action:{kind,label,text}, hint}
     tone：ok（有別台在線）／idle（同步開著，只有這台）／warn（需要處理）／off（沒在同步） */
  PR.syncView = function (d, rel) {
    rel = rel || ((iso) => iso);
    if (!d) return { show: false };
    const a = d.advice || null;
    const others = (d.devices || []).filter((x) => !x.me);
    const live = others.filter((x) => x.state === "ok" || x.state === "waiting");
    const v = { show: !!(d.enabled || a), tone: "off", lines: [], action: null, hint: "", title: "" };
    if (d.enabled) {
      v.tone = live.length ? "ok" : "idle";
      v.title = (d.drive ? d.drive.label + " › " : "") + String(d.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() + " · " + PR.t("{n} 篇", { n: d.papers || 0 });
      for (const x of d.devices || []) {
        const os = OS[x.platform] || "";
        const name = x.legacy ? PR.t("另一台電腦") : x.name + (os ? " · " + os : "");  // 舊版只留下一串代號，不拿來當名字
        let text, dot;
        if (x.me) { text = PR.t("這台"); dot = "me"; }
        else if (x.legacy) { text = PR.t("舊版 EasyRead，最後寫入 {t}（更新後這裡才看得到它的狀態）", { t: rel(x.at) }); dot = "away"; }
        else if (x.state === "ok") { text = PR.t("{t}上線 · 雙向同步正常", { t: rel(x.at) }); dot = "ok"; }
        else if (x.state === "waiting") { text = PR.t("{t}上線", { t: rel(x.at) }); dot = "ok"; }
        else { text = PR.t("上次上線 {t}", { t: rel(x.at) }); dot = "away"; }
        v.lines.push({ dot, name, text });
      }
      if (!others.length) v.hint = PR.t("還沒有別的電腦連上這個文獻庫。在另一台打開 EasyRead（要是同一版），它會自己找到這裡。");
      else if (d.last_remote_at) v.hint = PR.t("上次收到別台的修改：{t}", { t: rel(d.last_remote_at) });
    } else {
      v.title = PR.t("這台的文獻庫在本機資料夾，不會同步");
    }
    if (a && a.kind === "join") {
      const who = (a.devices || []).join(", ");
      v.tone = "warn";
      v.action = { kind: "join", label: PR.t("改用它"),
        text: (a.split ? PR.t("這台和另一台用的不是同一個資料夾。") : "") +
          (who ? PR.t("{label} 裡已經有文獻庫（{n} 篇，{who} 在用）。", { label: a.label, n: a.count, who }) : PR.t("{label} 裡已經有文獻庫（{n} 篇）。", { label: a.label, n: a.count })) +
          (a.mine ? PR.t("這台的 {n} 篇會一起併過去。", { n: a.mine }) : "") };
    } else if (a && a.kind === "absorb") {
      v.tone = "warn";
      v.action = { kind: "absorb", label: PR.t("合併進來"),
        text: PR.t("雲端硬碟裡還有 {k} 個 EasyRead 資料夾（共 {n} 篇，其中 {m} 篇這裡沒有）。", { k: (a.paths || []).length, n: a.count, m: a.new }) +
          PR.t("另一台電腦可能正在用那邊，所以兩邊對不起來。") };
    } else if (a && a.kind === "start") {
      v.action = { kind: "start", label: PR.t("放進 {label}", { label: a.label }), text: PR.t("把文獻庫放進 {label}，另一台電腦登入同一個帳號就能接著讀，筆記會自動合併。", { label: a.label }) };
    }
    if ((d.conflicts || []).length) { v.tone = "warn"; v.conflicts = d.conflicts.length; }
    return v;
  };

  const btn = () => PR.$("#syncBtn");
  const view = () => PR.syncView(data, PR.relTime);
  const sig = (a) => (a ? a.kind + ":" + (a.path || (a.paths || []).join("|")) + ":" + (a.count || 0) : "");

  function paint() {
    const b = btn(), v = view();
    if (!b) return;
    b.hidden = !v.show;
    b.className = "btn icon sync-btn tone-" + v.tone + (open ? " on" : "");
    b.innerHTML = PR.icon("cloud") + '<i class="dot"></i>';
    b.title = v.tone === "ok" ? PR.t("雲端同步：正常") : v.tone === "warn" ? PR.t("雲端同步：需要處理") : v.tone === "idle" ? PR.t("雲端同步：只有這台電腦") : PR.t("雲端同步");
    banner(v);
    pop(v);
    notice();
  }

  /* 清單上方的一條提示：只有「兩台不在同一個資料夾」這類要處理的事才出現；按過「稍後」就不再提同一件事 */
  function banner(v) {
    let node = PR.$("#syncBanner");
    const a = data && data.advice;
    const want = v.action && v.action.kind !== "start" && PR.ls.get(DISMISS, "") !== sig(a);
    if (!want) { if (node) node.remove(); return; }
    if (!node) {
      node = PR.el("div", { id: "syncBanner", class: "sync-banner", role: "status" });
      PR.$(".main").insertBefore(node, PR.$(".list-head"));
    }
    node.innerHTML = '<span class="ic">' + PR.icon("cloud", "sm") + "</span><span class=\"tx\">" + PR.esc(v.action.text) + "</span>" +
      '<button class="btn sm accent" data-sync="' + v.action.kind + '"' + (busy ? " disabled" : "") + ">" + (busy ? '<span class="spin"></span>' : "") + PR.esc(v.action.label) + "</button>" +
      '<button class="btn sm" data-sync="later">' + PR.t("稍後") + "</button>";
  }

  function pop(v) {
    let p = PR.$("#syncPop");
    if (!open) { if (p) p.remove(); return; }
    if (!p) { p = PR.el("div", { id: "syncPop", class: "sync-pop", role: "dialog", "aria-label": PR.t("雲端同步") }); document.body.append(p); }
    const r = btn().getBoundingClientRect();
    p.style.top = Math.round(r.bottom + 8) + "px";
    p.style.right = Math.max(8, Math.round(innerWidth - r.right - 4)) + "px";
    p.innerHTML = '<div class="sp-head"><b>' + PR.t("雲端同步") + '</b><span class="grow"></span>' +
      (data && data.enabled ? '<button class="btn sm line" data-sync="pull"' + (busy ? " disabled" : "") + ">" + PR.icon("redo", "sm") + PR.t("立即同步") + "</button>" : "") + "</div>" +
      '<div class="sp-where"><span class="tt">' + PR.esc(v.title) + '</span><button class="linkish" data-sync="reveal">' + PR.t("開啟資料夾") + "</button></div>" +
      (v.lines.length ? '<div class="sp-devs">' + v.lines.map((l) => '<div class="sp-dev"><i class="dot ' + l.dot + '"></i><span class="nm">' + PR.esc(l.name) + '</span><span class="st">' + PR.esc(l.text) + "</span></div>").join("") + "</div>" : "") +
      (v.hint ? '<p class="sp-hint">' + PR.esc(v.hint) + "</p>" : "") +
      (v.action ? '<div class="sp-act"><p>' + PR.esc(v.action.text) + '</p><button class="btn sm accent" data-sync="' + v.action.kind + '"' + (busy ? " disabled" : "") + ">" + (busy ? '<span class="spin"></span>' : "") + PR.esc(v.action.label) + "</button></div>" : "") +
      (v.conflicts ? '<p class="sp-hint warn">' + PR.t("雲端硬碟產生了 {n} 個衝突副本（檔名帶 (1) 或 conflict），可以在資料夾裡刪掉多的那份。", { n: v.conflicts }) + "</p>" : "") +
      '<div class="sp-foot"><button class="linkish" data-sync="settings">' + PR.t("文獻庫位置設定…") + "</button></div>";
  }

  /* 這台是跟著路標自動換過來的：說一次 */
  function notice() {
    const n = data && data.notice;
    if (!n || n.kind !== "followed") return;
    const key = "easyread-sync-followed", id = n.from + ">" + n.to;
    if (PR.ls.get(key, "") === id) return;
    PR.ls.set(key, id);
    PR.toast(PR.t("文獻庫已經併到雲端硬碟的 EasyRead 資料夾，這台已自動改用它。"), null, 7000);
  }

  async function load() {
    try { data = await PR.api("/api/sync"); } catch (e) { /* 連不上後端：文獻庫頁自己會提示 */ }
    paint();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(load, open ? 5000 : 30000);
  }

  async function act(kind, at) {
    if (busy) return;
    const a = data && data.advice;
    try {
      if (kind === "later") { PR.ls.set(DISMISS, sig(a)); return paint(); }
      if (kind === "settings") { open = false; paint(); return PR.openSettings("cloud"); }
      if (kind === "reveal") return void (await PR.api("/api/library/reveal", { method: "POST", body: {} }));
      if (kind === "pull") {
        busy = true; paint();
        data = await PR.api("/api/sync/pull", { method: "POST", body: {} });
        if (PR.lib && PR.lib.load) await PR.lib.load();
        PR.toast(PR.t("已同步"), null, 1200);
        return;
      }
      if (kind === "absorb") {
        if (!(await PR.confirm({ title: PR.t("把別的 EasyRead 資料夾合併進來？"), ok: PR.t("合併"), at,
          body: PR.t("那邊有、這裡沒有的論文會複製過來；兩邊都有的，筆記、對話會併在一起。舊資料夾不會刪，只留一個路標：還在用舊資料夾的電腦，下次打開 EasyRead 會自己換到這裡。") }))) return;
        busy = true; paint();
        const r = await PR.api("/api/sync/absorb", { method: "POST", body: {} });
        data = r;
        if (PR.lib && PR.lib.load) await PR.lib.load();
        PR.toast(PR.t("合併好了：複製 {a} 篇，併入筆記 {b} 篇。另一台電腦更新 EasyRead 後會自己跟過來。", { a: r.copied || 0, b: r.merged || 0 }), null, 8000);
        return;
      }
      if (kind === "join" || kind === "start") {
        const mode = kind === "start" ? "copy" : a.mode;
        if (!(await PR.confirm({ title: kind === "start" ? PR.t("把文獻庫放進雲端硬碟？") : PR.t("改用雲端硬碟裡的文獻庫？"), ok: kind === "start" ? PR.t("放進去") : PR.t("改用它"), at,
          body: (mode === "use" ? PR.t("以後這台直接用那裡的論文和筆記。") : mode === "merge" ? PR.t("這台的論文會複製過去（那邊已經有的跳過，筆記併在一起），以後兩台用同一個資料夾。") : PR.t("這台的論文會複製過去，以後都存在那裡。")) +
            PR.t("原來的資料夾保留不刪。完成後 EasyRead 會重新啟動。") }))) return;
        busy = true; paint();
        const r = kind === "join" ? await PR.api("/api/sync/join", { method: "POST", body: { path: a.path } })
          : await PR.api("/api/library/move", { method: "POST", body: { path: a.path, mode } });
        if (r.ok === false) throw new Error(r.message);
        if (window.easyreadDesktop && window.easyreadDesktop.relaunch) await window.easyreadDesktop.relaunch();
        else { if (PR.libraryLocationNotice) PR.libraryLocationNotice({ library_status: "restart_required" }); PR.toast(PR.t("請關掉 EasyRead 再重新打開"), null, 8000); }
        return;
      }
    } catch (e) {
      PR.toast(PR.esc(e.message || String(e)), null, 6000);
    } finally {
      busy = false;
      await load();
    }
  }

  if (typeof document === "undefined" || !document.body) return;  // 測試只用上面的純函式
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-sync]");
    if (t) { e.preventDefault(); return void act(t.dataset.sync, t); }
    if (e.target.closest && e.target.closest("#syncBtn")) { open = !open; paint(); if (open) load(); return; }
    if (open && !(e.target.closest && e.target.closest("#syncPop, .confirm"))) { open = false; paint(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { open = false; paint(); } });
  window.addEventListener("resize", () => { if (open) paint(); });
  if (btn()) load();
})(window.PR);
