/* 论文笔记的 AI 帮手：点评、帮我改、起草稿。结果流到笔记下方的小框里，读者决定替换、追加还是丢掉。
   和“问 AI”分开（不占右侧面板、不进对话记录）；服务端见 notehelp.py。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const NAMES = { review: PR.t("AI 点评"), revise: PR.t("AI 改过的笔记"), draft: PR.t("AI 起的草稿") };
  const ai = { mode: null, text: "", model: "", streaming: false, error: "", ctrl: null };
  const noteNow = () => { const ed = PR.notesEditor && PR.notesEditor("paper"); return ed ? ed.getValue() : (S.reader.paper_note || {}).body || ""; };

  PR.noteHelpOn = () => PR.store.mode === "server" && PR.feature("chat") && PR.canChat && PR.canChat();

  /* 工具栏上的按钮：笔记空着时只有“起草稿” */
  PR.noteHelpButtons = function () {
    if (!PR.noteHelpOn()) return "";
    const empty = !noteNow().trim();
    const dis = ai.streaming ? " disabled" : "";
    // 圖示鈕（字在滑鼠提示裡）：空的時候「起草稿」，有字了「點評」「幫我改」
    const b = (k, icon, label) => '<button class="btn icon" data-nh="' + k + '" title="' + PR.esc(label) + '" aria-label="' + PR.esc(label) + '"' + dis + ">" + PR.icon(icon, "sm") + "</button>";
    return '<span class="nh-btns">' + (empty ? b("draft", PR.hasIcon("wand") ? "wand" : "sparkle", PR.t("AI 起个草稿"))
      : b("review", PR.hasIcon("chats") ? "chats" : "sparkle", PR.t("AI 点评")) + b("revise", "edit", PR.t("AI 帮我改"))) + "</span>";
  };

  PR.noteHelpBox = function () {
    if (!ai.mode) return "";
    const apply = ai.mode === "review" ? '<button class="btn sm" data-nh="append">' + PR.t("追加到笔记末尾") + "</button>"
      : '<button class="btn sm accent" data-nh="replace">' + PR.t("替换我的笔记") + '</button><button class="btn sm" data-nh="append">' + PR.t("追加到末尾") + "</button>";
    return '<div class="np-ai"><div class="np-ai-head"><b>' + NAMES[ai.mode] + "</b>" + (ai.model ? "<small>" + PR.esc(ai.model) + "</small>" : "") + '<span class="grow"></span>' +
      (ai.streaming ? '<button class="btn sm" data-nh="stop">' + PR.t("停止") + "</button>" : '<button class="btn icon" data-nh="close" title="' + PR.t("丢掉") + '">×</button>') + "</div>" +
      '<div class="np-ai-body">' + (ai.text ? PR.mdBlocks(ai.text, ai.streaming ? { live: true } : null) : ai.streaming ? '<p class="hint"><span class="spin"></span> ' + PR.t("正在想…") + "</p>" : "") +
      (ai.error ? '<p class="err">' + PR.esc(ai.error) + "</p>" : "") + "</div>" +
      (!ai.streaming && ai.text ? '<div class="np-ai-acts">' + apply + "</div>" : "") + "</div>";
  };

  const paint = () => { const box = PR.$("#notespanel .np-ai"); if (box) box.outerHTML = PR.noteHelpBox(); else PR.renderNotesPanel(); };
  const paintSoon = PR.debounce(paint, 80);

  async function run(mode) {
    ai.ctrl && ai.ctrl.abort();
    const note = noteNow();  // 先取再重画：输入框里可能有还没存下的字（自动保存有 0.6 秒延迟）
    if (note !== ((S.reader.paper_note || {}).body || "")) PR.commit({ op: "paper_note", body: note });
    Object.assign(ai, { mode, text: "", model: "", streaming: true, error: "", ctrl: new AbortController() });
    PR.renderNotesPanel();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/notehelp", {
        method: "POST", signal: ai.ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode, note }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.model) ai.model = ev.model;
          if (ev.t) { ai.text += ev.t; paintSoon(); }
          if (ev.error) ai.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") ai.error = PR.t("没能完成：{msg}", { msg: e.message });
    }
    ai.streaming = false; ai.ctrl = null;
    PR.renderNotesPanel();
  }

  function setNote(body) {
    const ed = PR.notesEditor && PR.notesEditor("paper");
    if (ed) ed.blur();
    PR.commit({ op: "paper_note", body });
    if (ed) ed.setValue(body);
    ai.mode = null;
    PR.renderNotesPanel();
  }

  PR.$("#notespanel").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-nh]");
    if (!b) return;
    const act = b.dataset.nh;
    if (NAMES[act]) return run(act);
    if (act === "stop") { ai.ctrl && ai.ctrl.abort(); return; }
    if (act === "close") { ai.mode = null; return PR.renderNotesPanel(); }
    const cur = noteNow();
    if (act === "append") return setNote((cur.trim() ? cur.replace(/\s+$/, "") + "\n\n" : "") + (ai.mode === "review" ? "**" + PR.t("AI 点评") + "**\n\n" : "") + ai.text.trim());
    if (act === "replace") {
      setNote(ai.text.trim());
      PR.toast(PR.t("已替换论文笔记"), { label: PR.t("撤销"), fn: () => setNote(cur) });
    }
  });
})(window.PR);
