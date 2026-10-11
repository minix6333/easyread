// 從 electron/assets/icon.svg 做出各平台要的圖示：icon.png（1024，macOS／Linux 用，electron-builder 會轉成 icns）、
// icon.ico（Windows，16–256 各一張）、web/favicon.png（32，給不支援 SVG favicon 的地方）。
// 用法：node scripts/build_icons.js（改了 icon.svg 之後跑一次，產物一起提交）
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIcoMod = require("png-to-ico");
const pngToIco = typeof pngToIcoMod === "function" ? pngToIcoMod : pngToIcoMod.default;

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "electron", "assets", "icon.svg");
const OUT = path.join(ROOT, "electron", "assets");

async function main() {
  const svg = fs.readFileSync(SRC);
  const png = (size) => sharp(svg, { density: Math.ceil((size / 1024) * 72 * 4) }).resize(size, size).png().toBuffer();
  fs.writeFileSync(path.join(OUT, "icon.png"), await png(1024));
  // Windows 的 .ico：幾個尺寸包在一起（小尺寸由大圖縮下來，比系統自己縮的清楚）
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = [];
  for (const s of sizes) buffers.push(await png(s));
  fs.writeFileSync(path.join(OUT, "icon.ico"), await pngToIco(buffers));
  fs.writeFileSync(path.join(ROOT, "easyread", "web", "favicon.png"), await png(64));
  console.log("icons: icon.png 1024, icon.ico", sizes.join("/"), ", web/favicon.png 64");
}
main().catch((e) => { console.error(e); process.exit(1); });
