const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { execFile } = require("child_process");
const started = performance.now();

function mark(app, stage) {
  const line = `${new Date().toISOString()} startup ${stage} +${Math.round(performance.now() - started)}ms\n`;
  // Diagnostic logging must never prevent the window from opening.
  fs.appendFile(path.join(app.getPath("userData"), "startup.log"), line, () => {});
}

function loginShellPath(platform = process.platform, shell = process.env.SHELL || "/bin/zsh", run = execFile) {
  if (platform === "win32") return Promise.resolve("");
  return new Promise(resolve => {
    run(shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'],
      { encoding: "utf8", timeout: 5000, maxBuffer: 65536, windowsHide: true }, (error, out) => {
        const match = !error && String(out).match(/__PATH__(.*)__PATH__/);
        resolve(match ? match[1] : "");
      });
  });
}

function loadingUrl(zh) {
  const title = zh ? "正在開啟 FOLI" : "Opening FOLI";
  const hint = zh ? "正在準備文獻庫，請稍候…" : "Preparing your library. Please wait…";
  const html = `<!doctype html><html lang="${zh ? "zh-TW" : "en"}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>FOLI</title><style>
:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;background:#f6f3ee;color:#2b2420;font:15px -apple-system,"SF Pro Text","PingFang TC",system-ui,sans-serif}
h1{font-size:22px;font-weight:600;margin:10px 0 6px;letter-spacing:-.01em}p{margin:0;color:#928a82}.logo{width:64px;height:70px;margin:0 auto 8px;display:block}
.loader{width:22px;height:22px;border:2.5px solid #e6e0d8;border-top-color:#b8552f;border-radius:50%;margin:18px auto 0;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-color-scheme:dark){body{background:#1a1816;color:#eee8e0}p{color:#8e857c}.loader{border-color:#342f2b;border-top-color:#f0a27f}.lg-s{fill:#eadfd2}.lg-a{fill:#9c8b79}.lg-b{fill:#6f6154}}
@media(prefers-reduced-motion:reduce){.loader{animation:none}}.lg-s{fill:#4b413b}.lg-a{fill:#ebe0d1}.lg-b{fill:#cdb9a2}
</style><main role="status" aria-live="polite"><svg class="logo" viewBox="19 17 29.5 32" aria-hidden="true"><path class="lg-s" d="M20.4 24.4 C20.4 22.3 22.1 20.6 24.2 20.6 L28.4 20.6 L28.4 47.6 C25 47.6 20.4 46.8 20.4 43.2 Z"/><path class="lg-b" d="M28.4 33.2 C31.6 31.9 35.8 31.3 40.2 31.3 L43.6 31.3 L43.6 37.6 C43.6 41 41.4 43 38 44 C34.4 45.1 31 45.7 28.4 47.6 Z"/><path class="lg-a" d="M28.4 20.6 L44.2 18.2 C45.8 17.9 47 19 47 20.6 L47 27.2 C47 30.6 44.9 32.4 41.2 32.8 C36.5 33.3 31.6 33 28.4 35.3 Z"/></svg><h1>${title}</h1><p>${hint}</p><div class="loader" aria-hidden="true"></div></main></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

module.exports = { mark, loginShellPath, loadingUrl };
