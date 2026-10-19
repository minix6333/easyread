"""設定 →「外部 AI」：把 FOLI 的 MCP 伺服器（mcp_server.py）加進電腦上 AI App 的設定，或拿掉。
- Codex（ChatGPT.app 裡的 Codex、Codex.app、codex 指令共用）：~/.codex/config.toml 的 [mcp_servers.foli]
- Claude（Claude.app）：Claude 的 claude_desktop_config.json 的 mcpServers.foli
- Cursor：~/.cursor/mcp.json 的 mcpServers.foli
- Claude Code：用它自己的指令加（claude mcp add --scope user foli …）——~/.claude.json 是它一直在寫的狀態檔，不從外面改；
  看有沒有加只讀那個檔的 mcpServers
只動 foli 那一項，別的設定一個字都不動；改之前在同一個資料夾留一份備份（檔名後面加 .foli-backup）。
寫完再讀一次確認還讀得懂，讀不懂就放回原本的。改好要重開那個 App 才會生效。
指令：打包的桌面版是後端程式本身加 mcp；原始碼、pip 安裝的是這個 Python 加 -m easyread mcp。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

from .i18n import tr

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    tomllib = None

NAME = "foli"


def command() -> tuple[str, list[str]]:
    if getattr(sys, "frozen", False):
        return sys.executable, ["mcp"]
    return sys.executable, ["-m", "easyread", "mcp"]


def _home() -> Path:
    return Path(os.environ.get("EASYREAD_MCP_HOME") or Path.home())  # 測試用：換一個假的家目錄


def _claude_config() -> Path:
    h = _home()
    if sys.platform == "darwin":
        return h / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA") or h / "AppData" / "Roaming") / "Claude" / "claude_desktop_config.json"
    return h / ".config" / "Claude" / "claude_desktop_config.json"


def _app_path(*names: str) -> str:
    """Mac 上那個 App 在哪（設定頁拿它的圖示）；沒有就空字串。"""
    if sys.platform != "darwin":
        return ""
    for n in names:
        for base in (Path("/Applications"), _home() / "Applications"):
            if (base / n).exists():
                return str(base / n)
    return ""


def _apps(*names: str) -> bool:
    return bool(_app_path(*names))


def targets() -> list[dict]:
    h = _home()
    codex_home = Path(os.environ.get("CODEX_HOME") or h / ".codex")
    out = [
        {"id": "codex", "name": "ChatGPT／Codex", "path": codex_home / "config.toml", "kind": "toml",  # i18n-ok 產品名
         "installed": codex_home.exists() or _apps("ChatGPT.app", "Codex.app") or bool(shutil.which("codex"))},
        {"id": "claude", "name": "Claude", "path": _claude_config(), "kind": "json",
         "installed": _claude_config().parent.exists() or _apps("Claude.app")},
        {"id": "cursor", "name": "Cursor", "path": h / ".cursor" / "mcp.json", "kind": "json",
         "installed": (h / ".cursor").exists() or _apps("Cursor.app")},
        {"id": "claude-code", "name": "Claude Code", "path": h / ".claude.json", "kind": "cli", "installed": bool(_claude_cli())},
    ]
    apps = {"codex": ("ChatGPT.app", "Codex.app"), "claude": ("Claude.app",), "cursor": ("Cursor.app",)}
    for t in out:
        t["connected"] = _connected(t)
        t["app"] = _app_path(*apps.get(t["id"], ()))
    return out


def _claude_cli() -> str | None:
    try:
        from . import config, engines
        return engines.claude_path(config.load().get("claude") or {})
    except Exception:  # noqa: BLE001
        return shutil.which("claude")


def listing() -> dict:
    cmd, args = command()
    return {"targets": [{k: (str(v) if isinstance(v, Path) else v) for k, v in t.items()} for t in targets()], "command": [cmd, *args]}


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    data = json.loads(text)  # 讀不懂就丟出去：不去改一個看不懂的檔案
    if not isinstance(data, dict):
        raise ValueError(tr("設定檔的格式看不懂：{path}", path=str(path)))
    return data


_SECTION = re.compile(r"^\s*\[\s*mcp_servers\s*\.\s*(?:\"foli\"|'foli'|foli)\s*(?:\.[^\]]*)?\]\s*$")
_HEADER = re.compile(r"^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$")


def _strip_toml(text: str) -> str:
    """拿掉 [mcp_servers.foli]（和它底下的 [mcp_servers.foli.env] 之類）那幾段，其他原樣留著。"""
    out, skip = [], False
    for line in text.splitlines(keepends=True):
        if _HEADER.match(line):
            skip = bool(_SECTION.match(line))
        if not skip:
            out.append(line)
    return "".join(out)


def _connected(t: dict) -> bool:
    try:
        if t["kind"] == "toml":
            p = t["path"]
            return p.exists() and any(_SECTION.match(line) for line in p.read_text(encoding="utf-8").splitlines())
        return NAME in (_read_json(t["path"]).get("mcpServers") or {})
    except (OSError, ValueError):
        return False


def _write(path: Path, text: str, check) -> None:
    """備份 → 寫 → 再讀一次確認；確認不過就把原本的放回去。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_name(path.name + ".foli-backup")
    had = path.exists()
    if had:
        shutil.copy2(path, backup)
    tmp = path.with_name(path.name + ".foli-tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        check(tmp.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise ValueError(tr("改完的設定讀不懂，沒有存：{msg}", msg=str(e))) from e
    tmp.replace(path)


def _change(t: dict, on: bool) -> None:
    cmd, args = command()
    path = t["path"]
    if t["kind"] == "cli":
        exe = _claude_cli()
        if not exe:
            raise ValueError(tr("找不到 claude 指令"))
        import subprocess
        run = [exe, "mcp", "add", "--scope", "user", "--transport", "stdio", NAME, "--", cmd, *args] if on else [exe, "mcp", "remove", "--scope", "user", NAME]
        if on and _connected(t):  # 已經有了（可能是舊的路徑）：先拿掉再加
            subprocess.run([exe, "mcp", "remove", "--scope", "user", NAME], capture_output=True, timeout=60)
        r = subprocess.run(run, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise ValueError((r.stderr or r.stdout or "claude mcp").strip()[:300])
        return
    if t["kind"] == "toml":
        old = path.read_text(encoding="utf-8") if path.exists() else ""
        new = _strip_toml(old).rstrip()
        if on:
            new += ("\n\n" if new else "") + f"[mcp_servers.{NAME}]\ncommand = {json.dumps(cmd)}\nargs = {json.dumps(args)}\n"
        else:
            new += "\n" if new else ""

        def check(text):
            if tomllib:
                data = tomllib.loads(text)
                if on and (data.get("mcp_servers") or {}).get(NAME, {}).get("command") != cmd:
                    raise ValueError("foli")
        _write(path, new, check)
        return
    data = _read_json(path)
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    if on:
        entry = {"command": cmd, "args": args}
        if t["id"] == "claude-code":
            entry["type"] = "stdio"
        servers[NAME] = entry
    else:
        servers.pop(NAME, None)
    data["mcpServers"] = servers
    _write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n", lambda text: json.loads(text))


def handle(body: dict) -> dict:
    """POST /api/mcp：{do: "connect"|"disconnect", id}。"""
    do, tid = str(body.get("do") or ""), str(body.get("id") or "")
    t = next((x for x in targets() if x["id"] == tid), None)
    if not t or do not in ("connect", "disconnect"):
        raise ValueError(tr("沒有這個 App：{id}", id=tid))
    _change(t, do == "connect")
    return listing()
