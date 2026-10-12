// 開發用：檢查「PDF 捲快一點，頁面就一塊一塊畫不出來」不會再回來。
// 2.1.0-tw.8 以前，在 Mac 的桌面版裡捲投影片：捲快一點，頁面下半截透明、整份讀不出來（在小的瀏覽器分頁裡看不出來）。兩件事疊在一起：
//   ① 紙張色調用 mix-blend-mode 把每一頁的圖「相乘」印在色紙上（載入時的淡入也是）：每一頁的圖因此各自成了一個合成圖層；
//   ② PDF 的捲動區只圓上面兩個角：macOS 上，四角不一樣的圓角裁切要用遮罩圖層做，裡面每一組合成圖層都配一張和捲動區一樣大的遮罩。
//   投影片一個畫面附近十幾頁 → 二三十張遮罩（2 倍螢幕上一張二十幾 MB）→ 合成器的圖塊記憶體（約 600 MB）用完 → 畫面內的頁面分不到記憶體。
// 這支開一個和 Mac 一樣是 2 倍密度的視窗，幾種外觀各快捲一次，一邊錄合成器的追蹤，檢查：
//   頁面的圖沒有會讓它自己成層的樣式、捲動區四個角一樣圓；圓角遮罩圖層（Synthesized Clip）0 張、頁面的圖沒有各自成層、
//   圖塊記憶體沒有用完；紙張色調染出來的顏色對（白的地方就是那個紙色）。
//   node_modules/.bin/electron scripts/pdf_layers_check.cjs [--base http://localhost:8765] <一份 PDF 文件的 id（頁面是白底的；投影片最好）>
// 會動到開發用的偏好（主題、紙張…），跑完改回來。每一項印 ok／FAIL，結束碼 0＝全過。
const { app, BrowserWindow, ipcMain, nativeTheme, contentTracing } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = opt("--base", "http://localhost:8765");
const id = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!id) { console.log("要給一份 PDF 文件的 id"); process.exit(2); }

// [名字, 外觀, 頁面上白的地方該是什麼顏色（null＝不量）]
const LOOKS = [
  ["深色、夜間頁面原色、紙張冷色", { theme: "dark", night: "none", paper: "cool" }, [242, 246, 251]],
  ["淺色、紙張暖色", { theme: "light", night: "none", paper: "warm" }, [251, 246, 234]],
  ["淺色、白紙", { theme: "light", night: "none", paper: "white" }, [255, 255, 255]],
  ["深色、夜間頁面反相", { theme: "dark", night: "invert", paper: "white" }, null],
];

/* 追蹤檔 → 圖層幾層、遮罩幾張、頁面的圖有幾張各自成層、畫面內的圖塊用了多少、記憶體有沒有用完、有幾格缺內容 */
function summarize(file, pageSize) {
  const ev = JSON.parse(fs.readFileSync(file, "utf8")).traceEvents || [];
  const renderers = new Set(ev.filter((e) => e.ph === "M" && e.name === "process_name" && e.args && e.args.name === "Renderer").map((e) => e.pid));
  const out = { frames: 0, layers: 0, masks: 0, pageImgs: 0, nowMB: 0, oom: 0, assigns: 0, limitMB: 0, missing: 0, quads: 0 };
  const layersOf = (o, acc) => {
    if (Array.isArray(o)) o.forEach((v) => layersOf(v, acc));
    else if (o && typeof o === "object") { if ("layer_id" in o && o.bounds) acc.push(o); for (const k in o) layersOf(o[k], acc); }
    return acc;
  };
  const flags = (o) => {
    if (Array.isArray(o)) o.forEach(flags);
    else if (o && typeof o === "object") { if ("has_missing_content" in o) { out.quads++; if (o.has_missing_content === true || o.has_missing_content === "true") out.missing++; } for (const k in o) flags(o[k]); }
  };
  const isPage = (b) => Math.abs(b.width - pageSize[0]) <= 4 && Math.abs(b.height - pageSize[1]) <= 4;
  for (const e of ev) {
    if (!renderers.has(e.pid) || !e.args) continue;
    const snap = e.args.snapshot;
    if (snap && snap.active_tree) {
      out.frames++;
      const layers = layersOf(snap.active_tree, []);
      out.layers = Math.max(out.layers, layers.length);
      out.masks = Math.max(out.masks, layers.filter((l) => /Synthesized Clip/.test(l.layer_name || "")).length);
      out.pageImgs = Math.max(out.pageImgs, layers.filter((l) => / IMG\b/.test(l.layer_name || "") && isPage(l.bounds)).length);
      let now = 0;
      for (const t of snap.active_tiles || []) if (t.combined_priority && t.combined_priority.priority_bin === "NOW") now += t.gpu_memory_usage || 0;
      out.nowMB = Math.max(out.nowMB, Math.round(now / 1e6));
    } else if (e.name === "DidPrepareTiles" && e.args.state) {
      out.assigns++;
      if (e.args.state.did_oom_on_last_assign === true) out.oom++;
      out.limitMB = Math.round(((e.args.state.global_state || {}).hard_memory_limit_in_bytes || 0) / 1e6);
    } else flags(e.args);
  }
  return out;
}

let step = "start", restore = null;
process.on("unhandledRejection", async (e) => {
  console.log("FAILED at " + step + " — " + String((e && e.stack) || e).slice(0, 500));
  if (restore) await restore().catch(() => {});
  app.exit(2);
});
setTimeout(() => { console.log("TIMEOUT at " + step); app.exit(3); }, 300000);
app.commandLine.appendSwitch("force-device-scale-factor", "2");   // 和 Mac 的螢幕一樣：圖層、遮罩的大小是照實際像素算的
app.commandLine.appendSwitch("force-color-profile", "srgb");       // 量顏色用：不讓螢幕的色彩描述檔改掉數值
app.whenReady().then(async () => {
  ipcMain.handle("easyread:theme", (_e, theme) => { nativeTheme.themeSource = theme === "dark" || theme === "light" ? theme : "system"; return nativeTheme.shouldUseDarkColors; });
  const win = new BrowserWindow({ width: 1400, height: 860, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "shots-preload.cjs") } });
  const wc = win.webContents;
  const waitFor = async (frame, cond, what, tries) => { for (let i = 0; i < (tries || 80); i++) { if (await frame.executeJavaScript("!!(" + cond + ")").catch(() => false)) return; await sleep(250); } throw new Error("waited too long for " + what); };
  let saved = null;
  const reset = async (vals) => {
    await win.loadURL(base + "/library").catch(() => {});
    await waitFor(wc, "window.PR && PR.token", "the library page");
    if (!saved) saved = await wc.executeJavaScript('PR.api("/api/prefs").then((p) => p.reader || {})');
    const all = Object.assign({}, saved, vals);
    await wc.executeJavaScript('localStorage.removeItem("easyread-shell"); localStorage.removeItem("easyread-dock"); localStorage.setItem("easyread-nav", "false"); var p = JSON.parse(localStorage.getItem("easyread-prefs") || "{}"); Object.assign(p, ' + JSON.stringify(all) + '); localStorage.setItem("easyread-prefs", JSON.stringify(p)); PR.api("/api/prefs", { method: "POST", body: { reader: ' + JSON.stringify(all) + " } }).then(() => 1)");
  };
  restore = async () => { if (saved) await reset(saved); };
  let bad = 0;
  const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? "ok    " : "FAIL  ") + name + (ok ? "" : "  → " + JSON.stringify(detail).slice(0, 700))); };

  for (const [name, look, tone] of LOOKS) {
    step = name + " / open";
    nativeTheme.themeSource = look.theme;
    await reset(Object.assign({ layout: "pdf", pdfZoom: 1.2 }, look));
    await win.loadURL(base + "/").catch(() => {});
    await waitFor(wc, 'typeof window.easyreadOpen === "function"', "the shell");
    await wc.executeJavaScript("window.easyreadOpen(" + JSON.stringify("/read/" + id) + "); 1");
    let reader = null;
    for (let i = 0; i < 80 && !reader; i++) { reader = wc.mainFrame.framesInSubtree.find((f) => f.url.includes("/read/" + id)); if (!reader) await sleep(250); }
    if (!reader) throw new Error("the reader tab did not open");
    await waitFor(reader, "window.PR && PR.prefs && PR.state && PR.state.paper && PR.pageNodes && PR.pageNodes().length", "the reader");
    await sleep(700);
    // 到中間那一頁（先按一下：不然開頁時「回到上次讀到的地方」會把它捲回去），等附近的圖到齊
    const start = await reader.executeJavaScript('(function () { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); var n = PR.pageNodes().length, at = Math.max(1, Math.round(n * 0.35)); PR.openPage(at, null, { instant: true }); return at; })()');
    const loaded = "(function () { var e = PR.pageNodes()[PR.pdfPage() - 1]; return e.img.complete && e.img.naturalWidth > 0 && !document.querySelector('.pv-page.loading'); })()";
    await waitFor(reader, loaded, "the page images", 60);
    await sleep(500);

    step = name + " / styles";
    const st = JSON.parse(await reader.executeJavaScript('JSON.stringify((function () { var sc = document.querySelector(".pv-scroll"), r = sc.getBoundingClientRect(), fr = window.frameElement.getBoundingClientRect(), e = PR.pageNodes()[PR.pdfPage() - 1], c = getComputedStyle(e.img), s = getComputedStyle(sc), p = e.node.getBoundingClientRect(); return { pdf: PR.pdfMain(), dpr: devicePixelRatio, sc: [r.left + fr.left, r.top + fr.top, r.width, r.height], page: [p.width, p.height], pages: PR.pageNodes().length, paper: document.documentElement.dataset.paper || "white", theme: document.documentElement.dataset.theme, blend: c.mixBlendMode, willChange: c.willChange, opacity: c.opacity, transition: c.transitionProperty + " " + c.transitionDuration, animation: c.animationName, radii: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius] }; })())'));
    if (!st.pdf) throw new Error("the reader is not in the PDF-first layout");
    const fades = /opacity|all/.test(st.transition.split(" ")[0]) && parseFloat(st.transition.split(" ").pop()) > 0;
    check(name + "：頁面的圖沒有會讓它自己成一層的樣式（混色、淡入、will-change、動畫）", st.blend === "normal" && st.willChange === "auto" && st.opacity === "1" && !fades && st.animation === "none", st);
    check(name + "：PDF 捲動區四個角一樣圓（不一樣的話 macOS 要用遮罩圖層裁）", new Set(st.radii).size === 1, st.radii);

    step = name + " / scroll";
    const [sx, sy, sw, sh] = st.sc;
    const wheel = async (ms, dy) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { wc.sendInputEvent({ type: "mouseWheel", x: Math.round(sx + sw / 2), y: Math.round(sy + sh / 2), deltaX: 0, deltaY: dy, canScroll: true }); await sleep(16); } };
    const file = path.join(os.tmpdir(), "foli-pdf-layers-" + process.pid + ".json");
    await contentTracing.startRecording({ included_categories: ["cc", "disabled-by-default-cc.debug"] });
    await wheel(1200, -150);   // 一秒捲過十幾二十頁：比一般用力滑還快
    await sleep(250);
    await wheel(500, 220);
    await sleep(500);
    await contentTracing.stopRecording(file);
    const end = await reader.executeJavaScript("PR.pdfPage()");
    const t = summarize(file, [Math.round(st.page[0] * st.dpr), Math.round(st.page[1] * st.dpr)]);
    fs.rmSync(file, { force: true });
    const line = "第 " + start + "→" + end + " 頁、錄到 " + t.frames + " 格、圖層最多 " + t.layers + "、圓角遮罩 " + t.masks + "、自己成層的頁面圖 " + t.pageImgs + "、畫面內圖塊最多 " + t.nowMB + " MB（上限 " + t.limitMB + " MB，用完 " + t.oom + "／" + t.assigns + " 次）、缺內容 " + t.missing + "／" + t.quads + " 格";
    check(name + "：快捲時沒有遮罩圖層、頁面的圖沒有各自成層、圖塊記憶體沒用完｜" + line, t.frames >= 10 && end !== start && t.masks === 0 && t.pageImgs === 0 && t.oom === 0, t);

    if (tone) {
      step = name + " / colour";
      await waitFor(reader, loaded, "the page images after scrolling", 60);
      await sleep(400);
      // 現在這一頁在畫面上的那一塊（避開底下那顆頁碼膠囊）：最亮的那一點就是「紙」——白紙是 255、有色調的是那個紙色
      const r = JSON.parse(await reader.executeJavaScript('JSON.stringify((function () { var e = PR.pageNodes()[PR.pdfPage() - 1], p = e.node.getBoundingClientRect(), fr = window.frameElement.getBoundingClientRect(), sc = document.querySelector(".pv-scroll").getBoundingClientRect(); var top = Math.max(p.top, sc.top + 60), bottom = Math.min(p.bottom, sc.bottom - 90); return { x: Math.round(p.left + fr.left + 20), y: Math.round(top + fr.top + 6), width: Math.round(p.width - 40), height: Math.round(bottom - top - 12) }; })())'));
      const img = await wc.capturePage(r), size = img.getSize(), buf = img.toBitmap();
      let best = [0, 0, 0];
      for (let y = 0; y < size.height; y += 3) for (let x = 0; x < size.width; x += 3) {
        const i = (y * size.width + x) * 4;  // BGRA
        if (buf[i] + buf[i + 1] + buf[i + 2] > best[0] + best[1] + best[2]) best = [buf[i + 2], buf[i + 1], buf[i]];
      }
      // 拍下來的數值是螢幕色域的（P3 的螢幕上 #fbf6ea 不是 251,246,234）：在同一個畫面上放一小塊直接塗那個紙色的，拿它來比
      const sw = JSON.parse(await reader.executeJavaScript('JSON.stringify((function () { var d = document.createElement("div"); d.id = "toneSwatch"; d.style.cssText = "position:fixed;left:40px;top:120px;width:24px;height:24px;z-index:99999;background:rgb(' + tone.join(",") + ')"; document.body.append(d); var fr = window.frameElement.getBoundingClientRect(); return { x: Math.round(40 + fr.left + 8), y: Math.round(120 + fr.top + 8), width: 8, height: 8 }; })())'));
      await sleep(250);
      const ref = (await wc.capturePage(sw)).toBitmap();
      const want = [ref[2], ref[1], ref[0]];
      await reader.executeJavaScript('document.getElementById("toneSwatch").remove(); 1');
      check(name + "：頁面上白的地方就是紙色 rgb(" + tone.join(", ") + ")｜這個螢幕上紙色拍起來是 rgb(" + want.join(", ") + ")、頁面量到 rgb(" + best.join(", ") + ")", r.height > 40 && best.every((v, k) => Math.abs(v - want[k]) <= 4), { best, want, tone, r, size });
    }
  }

  step = "restore prefs";
  nativeTheme.themeSource = "dark";
  await restore();
  restore = null;
  await sleep(300);
  console.log(bad ? bad + " 項沒過" : "全部通過");
  win.destroy();
  app.exit(bad ? 1 : 0);
});
