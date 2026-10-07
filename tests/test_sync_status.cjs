// 雲端同步狀態：/api/sync 的回應 → 畫面上顯示什麼（sync-status.js 的純函式 PR.syncView）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const PR = { t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s), $: () => null, ls: { get: () => "", set() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/library/sync-status.js"), "utf8"),
    { window: { PR }, document: { addEventListener() {} } });
  return PR;
}
const rel = () => "剛剛";
const me = { id: "a", name: "Mac", platform: "darwin", me: true, state: "me", at: "t" };

test("沒在同步、也沒有建議：不顯示", () => {
  const PR = load();
  assert.equal(PR.syncView({ enabled: false, devices: [], advice: null }, rel).show, false);
  assert.equal(PR.syncView(null, rel).show, false);
});

test("兩台都在線：綠燈，每台一行，對方確認收到才說雙向正常", () => {
  const PR = load();
  const v = PR.syncView({ enabled: true, path: "/x/My Drive/EasyRead", papers: 9, drive: { label: "Google Drive" }, last_remote_at: "t",
    devices: [me, { id: "b", name: "PC", platform: "win32", state: "ok", at: "t" }, { id: "c", name: "Lab", platform: "linux", state: "waiting", at: "t" }] }, rel);
  assert.equal(v.tone, "ok");
  assert.equal(v.title, "Google Drive › EasyRead · 9 篇");
  assert.deepEqual(v.lines.map((l) => l.name), ["Mac · Mac", "PC · Windows", "Lab · Linux"]);
  assert.match(v.lines[1].text, /雙向同步正常/);
  assert.doesNotMatch(v.lines[2].text, /雙向同步正常/);
  assert.match(v.hint, /上次收到別台的修改/);
  assert.equal(v.action, null);
});

test("只有這台：不亮燈，提示另一台會自己找到；對方很久沒出現算不在線", () => {
  const PR = load();
  assert.equal(PR.syncView({ enabled: true, path: "/d/EasyRead", papers: 1, devices: [me] }, rel).tone, "idle");
  assert.match(PR.syncView({ enabled: true, path: "/d/EasyRead", papers: 1, devices: [me] }, rel).hint, /還沒有別的電腦/);
  const v = PR.syncView({ enabled: true, path: "/d/EasyRead", papers: 1, devices: [me, { id: "b", name: "PC", platform: "win32", state: "away", at: "t" }] }, rel);
  assert.equal(v.tone, "idle");
  assert.match(v.lines[1].text, /上次上線/);
});

test("這台在本機、雲端已有文獻庫：橘燈，建議改用它", () => {
  const PR = load();
  const v = PR.syncView({ enabled: false, path: "/home/EasyRead/library", devices: [],
    advice: { kind: "join", path: "/g/EasyRead", count: 8, devices: ["Mac"], label: "Google Drive", mode: "merge", mine: 2 } }, rel);
  assert.equal(v.show, true);
  assert.equal(v.tone, "warn");
  assert.equal(v.action.kind, "join");
  assert.match(v.action.text, /Google Drive 裡已經有文獻庫（8 篇，Mac 在用）/);
  assert.match(v.action.text, /這台的 2 篇會一起併過去/);
});

test("雲端硬碟裡還有別的 EasyRead 資料夾：建議合併；舊版裝置說明要更新；有衝突副本也亮橘燈", () => {
  const PR = load();
  const v = PR.syncView({ enabled: true, path: "/d/EasyRead", papers: 8, devices: [me, { id: "b", name: "cb60", legacy: true, state: "away", at: "t" }],
    advice: { kind: "absorb", paths: ["/d", "/d/x/EasyRead"], count: 3, new: 2, devices: ["PC"] } }, rel);
  assert.equal(v.tone, "warn");
  assert.equal(v.action.kind, "absorb");
  assert.match(v.action.text, /還有 2 個 EasyRead 資料夾（共 3 篇，其中 2 篇這裡沒有）/);
  assert.match(v.lines[1].text, /舊版 EasyRead/);
  assert.equal(v.lines[1].name, "另一台電腦");
  assert.equal(PR.syncView({ enabled: true, path: "/d/EasyRead", devices: [me], conflicts: ["a/x (1).json"] }, rel).tone, "warn");
});

test("沒在同步但找得到雲端硬碟：可以放進去，不亮橘燈、不出橫幅", () => {
  const PR = load();
  const v = PR.syncView({ enabled: false, path: "/h/library", devices: [], advice: { kind: "start", path: "/g/EasyRead", label: "Google Drive" } }, rel);
  assert.equal(v.tone, "off");
  assert.equal(v.action.kind, "start");
});
