"""編譯 macOS 上「貼齊別的程式視窗」用的小幫手（electron/native/winhelper.swift → build/native/easyread-winhelper）。
別的平台沒有這個功能：只建一個空資料夾，打包時 extraResources 才不會找不到來源。
用法：python scripts/build_native.py（npm run build:native、npm run dist 會叫）"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "native"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "README.txt").write_text("macOS window-docking helper (see electron/native/winhelper.swift). Empty on other platforms.\n", encoding="utf-8")
    if sys.platform != "darwin":
        print("build_native: not macOS, nothing to build")
        return 0
    swiftc = shutil.which("swiftc")
    if not swiftc:
        print("build_native: swiftc not found; the docked-app feature will be unavailable in this build", file=sys.stderr)
        return 0
    out = OUT / "easyread-winhelper"
    cmd = [swiftc, "-O", "-swift-version", "5", "-o", str(out), str(ROOT / "electron" / "native" / "winhelper.swift")]
    print("build_native:", " ".join(cmd))
    done = subprocess.run(cmd)
    if done.returncode != 0:
        return done.returncode
    print("build_native: built", out, out.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
