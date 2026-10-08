// 把另一個程式的視窗「貼齊」在主視窗右邊（只有 macOS；要使用者給「輔助使用」權限）。
//
// 做法：主視窗讓出右邊一塊（視窗變窄），請幫手程式（native/winhelper.swift）把那個程式的視窗擺進讓出來的地方；
// 主視窗移動、改大小時跟著擺。兩個視窗合起來占的還是原來那一塊。收回時主視窗變回原來的寬度，對方的視窗放回原位。
// 這裡只有算位置和開關，真正去動別的視窗的是幫手。幫手和算法分開，所以算法有測試（tests/test_native_dock.cjs）。
const { spawn } = require("child_process");
const fs = require("fs");

const MIN_HOST = 640;      // 貼著別的視窗時，主視窗最窄多少
const MIN_SIDE = 360, DEF_SIDE = 480;

// 純函式：整塊區域 group、想要的旁邊寬度 → 主視窗和旁邊視窗各占哪裡；擺不下回 null
function split(group, want) {
  const side = Math.round(Math.max(MIN_SIDE, Math.min(Number(want) || DEF_SIDE, group.width - MIN_HOST)));
  if (side < MIN_SIDE || group.width - side < MIN_HOST) return null;
  return {
    host: { x: group.x, y: group.y, width: group.width - side, height: group.height },
    side: { x: group.x + group.width - side, y: group.y, width: side, height: group.height },
  };
}
// 主視窗現在在哪 → 旁邊的視窗該在哪
const beside = (host, sideWidth) => ({ x: host.x + host.width, y: host.y, width: sideWidth, height: host.height });
const arr = (r) => [r.x, r.y, r.width, r.height];

function createNativeDock({ platform, helperPath, getWindow, minSize, notify, spawnHelper, dry }) {
  let proc = null, buf = "", seq = 0, state = null, timer = null;
  const pending = new Map();
  const supported = () => platform === "darwin" && !!helperPath && fs.existsSync(helperPath);

  function start() {
    if (proc) return proc;
    proc = (spawnHelper || spawn)(helperPath, dry ? ["--dry"] : [], { stdio: ["pipe", "pipe", "ignore"] });
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        else if (msg.event) onEvent(msg);
      }
    });
    const dead = () => { proc = null; for (const done of pending.values()) done({ ok: false, reason: "helper" }); pending.clear(); if (state) release(false); };
    proc.once("exit", dead);
    proc.once("error", dead);
    return proc;
  }
  const send = (msg) => { try { start().stdin.write(JSON.stringify(msg) + "\n"); } catch (_) { /* 幫手沒了：exit 那邊會收拾 */ } };
  const ask = (msg, ms = 15000) => new Promise((resolve) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, reason: "timeout" }); }, ms);
    pending.set(id, (r) => { clearTimeout(t); resolve(r); });
    send({ ...msg, id });
  });

  // 主視窗動了：旁邊的跟上（一幀最多一次）
  function follow() {
    if (!state || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const win = getWindow();
      if (!state || !win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      send({ cmd: "frame", frame: arr(beside(win.getBounds(), state.side)) });
    }, 16);
  }
  // 使用者自己動了旁邊的視窗：只是拉了它的左緣（改寬度）就讓主視窗跟著補上；拖走了就擺回來
  function onEvent(msg) {
    if (msg.event === "gone") { release(false); notify({ type: "gone" }); return; }
    if (msg.event === "dry-frame") { notify({ type: "dry", frame: msg.frame }); return; }  // 開發時看得到有沒有跟著擺
    if (msg.event !== "frame" || !state || !Array.isArray(msg.frame)) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const [x, y, w, h] = msg.frame, host = win.getBounds();
    const right = host.x + host.width + state.side;
    const resized = Math.abs(y - host.y) < 3 && Math.abs(h - host.height) < 3 && Math.abs(x + w - right) < 3 && w >= MIN_SIDE && x - host.x >= MIN_HOST;
    if (resized) { state.side = Math.round(w); win.setBounds({ x: host.x, y: host.y, width: Math.round(x - host.x), height: host.height }); notify({ type: "width", width: state.side }); }
    else follow();
  }

  function release(restore) {
    const s = state;
    state = null;
    clearTimeout(timer); timer = null;
    const win = getWindow();
    if (!s || !win || win.isDestroyed()) return;
    for (const [ev, fn] of s.listeners) win.removeListener(ev, fn);
    win.setMinimumSize(minSize[0], minSize[1]);
    if (restore !== "keep" && !win.isFullScreen()) { const b = win.getBounds(); win.setBounds({ x: b.x, y: b.y, width: b.width + s.side, height: b.height }); }
  }

  return {
    supported,
    split, beside,
    active: () => !!state,
    async status() {
      if (!supported()) return { supported: false, trusted: false, active: false };
      const r = await ask({ cmd: "trust", prompt: false }, 4000);
      return { supported: true, trusted: !!r.trusted, active: !!state, path: state ? state.path : "" };
    },
    /* 跳出系統的那個「想要控制這部電腦」對話框（只會出現一次；之後要到系統設定裡開） */
    async request() {
      if (!supported()) return { supported: false, trusted: false };
      const r = await ask({ cmd: "trust", prompt: true }, 4000);
      return { supported: true, trusted: !!r.trusted };
    },
    async attach(appPath, width) {
      if (!supported()) return { ok: false, reason: "platform" };
      const win = getWindow();
      if (!win || win.isDestroyed()) return { ok: false, reason: "window" };
      if (win.isFullScreen()) return { ok: false, reason: "fullscreen" };
      if (!/\.app\/?$/i.test(String(appPath || "")) || !fs.existsSync(appPath)) return { ok: false, reason: "path" };
      const trust = await ask({ cmd: "trust", prompt: false }, 4000);
      if (!trust.trusted) return { ok: false, reason: "permission" };
      if (state) { await ask({ cmd: "detach", restore: true }, 4000); release(true); }
      const group = win.getBounds();  // 最大化著也直接用現在占的那一塊（另外叫 unmaximize 的話它的動畫會晚一步把大小蓋回去）
      const plan = split(group, width);
      if (!plan) return { ok: false, reason: "narrow" };
      const r = await ask({ cmd: "attach", path: appPath, frame: arr(plan.side) });
      if (!r.ok) return { ok: false, reason: r.reason || "helper", message: r.message || "" };
      // 對方不一定肯變成我們要的寬度（有最小寬度）：照它實際的寬度讓位
      const got = Array.isArray(r.frame) ? Math.round(r.frame[2]) : plan.side.width;
      const side = Math.max(MIN_SIDE, Math.min(got, group.width - MIN_HOST));
      const listeners = [["move", follow], ["resize", follow], ["moved", follow], ["resized", follow], ["restore", follow], ["leave-full-screen", follow]];
      state = { path: appPath, side, listeners };
      win.setMinimumSize(Math.min(MIN_HOST, minSize[0]), minSize[1]);
      win.setBounds({ x: group.x, y: group.y, width: group.width - side, height: group.height });
      for (const [ev, fn] of listeners) win.on(ev, fn);
      follow();
      return { ok: true, width: side };
    },
    async detach() {
      if (!state) return { ok: true };
      release(true);
      await ask({ cmd: "detach", restore: true }, 4000);
      return { ok: true };
    },
    /* 視窗要關了、程式要結束了：主視窗先變回原來的寬度（才會記到對的大小），再請幫手把對方放回原位 */
    restoreNow() { if (state) { release(true); send({ cmd: "detach", restore: true }); } },
    dispose() { if (proc) { try { proc.stdin.end(); } catch (_) { /* 已經關了 */ } proc = null; } },
  };
}

module.exports = { createNativeDock, split, beside, MIN_HOST, MIN_SIDE };
