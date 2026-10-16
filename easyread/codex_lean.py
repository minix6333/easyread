"""翻译调用 Codex 时不拉起用户自己配的 MCP 服务，也关掉翻译用不到的功能。

codex exec 每次启动都会把 ~/.codex/config.toml（或 CODEX_HOME 下的）里的 [mcp_servers.*] 全部拉起来：
npx 起的服务每个就是好几个 node 进程，分段并行 4 段时实测 300 多个进程、峰值 8 GB。翻译用不到这些工具。
这里读出配置里有哪些 MCP 服务，给每个传 -c mcp_servers.<名字>.enabled=false，再把 turn 结束时的 notify 钩子关掉。
不用 --ignore-user-config：那样会连用户自定义的 provider、model 一起丢掉。
读不到配置、解析不出来就不碰 MCP；Codex 版本不认这些键时会忽略，真报错时 run_codex 去掉它们再调一次，也就是退回现状。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

# [mcp_servers.名字] 或 [mcp_servers."带点的名字"]；子表 [mcp_servers.名字.env] 不算新服务
_HEADER = re.compile(r"""(?m)^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]""")
_BARE = re.compile(r"[A-Za-z0-9_-]+")


def config_path() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"


def server_names(text: str) -> list[str]:
    out = []
    for m in _HEADER.finditer(text):
        raw = m.group(1)
        name = raw[1:-1].replace('\\"', '"') if raw[0] in "\"'" else raw
        if name and name not in out:
            out.append(name)
    return out


def _key(name: str) -> str:
    return name if _BARE.fullmatch(name) else '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def args(path: Path | None = None, tools: bool = False) -> list[str]:
    """codex exec 要加的 -c 参数。配置读不到、解析不出就只关功能、不碰 MCP。
    tools=True（app-server 用）：留著 code_mode_host——Codex 0.160 起模型呼叫任何工具（包括上網搜尋）都要經過它，
    整個行程關掉的話每個對話都用不了工具；要不要給工具改由每個對話自己的設定決定（thread_config）。實測留著它不多開行程、不多吃記憶體。"""
    try:
        text = (path or config_path()).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return features(tools)  # 没有配置文件：没有 MCP 要关
    try:
        names = server_names(text)
    except Exception:  # noqa: BLE001 —— 解析不了就不碰 MCP
        return features(tools)
    out: list[str] = []
    for n in names:
        out += ["-c", f"mcp_servers.{_key(n)}.enabled=false"]
    if re.search(r"(?m)^\s*notify\s*=", text.split("\n[", 1)[0]):
        out += ["-c", "notify=[]"]  # 每次结束时调用的提醒程序（Codex 桌面版的电脑操作组件），翻译用不到
    return out + features(tools)


# 翻译用不到的功能：插件、应用、浏览器、电脑操作、生图、多代理、记忆……每个都会往每次调用里加工具定义，
# 有的还会拉起 node_repl 之类的进程。实测（codex-cli 0.159）空调用固定上下文从约 2.5 万 token 降到约 1.7 万，
# 进程从 19 个降到 3 个，内存从约 840 MB 降到约 200 MB。只关这一次调用，不改用户的配置。
# 版本不认某个名字时 Codex 照常忽略；真报错时 run_codex 会去掉这些参数再调一次。
FEATURES_OFF = ("apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation", "multi_agent",
                "memories", "goals", "skill_search", "in_app_browser", "tool_suggest", "realtime_conversation", "code_mode_host",
                "sleep_tool")


def features(tools: bool = False) -> list[str]:
    out: list[str] = []
    for f in FEATURES_OFF:
        if tools and f == "code_mode_host":
            continue
        out += ["-c", f"features.{f}=false"]
    return out


# [plugins."名字@市集"]：使用者在 Codex 裡裝的外掛（電腦操作、瀏覽器、Gmail、GitHub、Google 雲端硬碟…）
_PLUGIN = re.compile(r"""(?m)^\s*\[\s*plugins\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_@.-]+)\s*\]""")


def plugin_ids(path: Path | None = None) -> list[str]:
    try:
        text = (path or config_path()).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return []
    out = []
    for m in _PLUGIN.finditer(text):
        raw = m.group(1)
        name = raw[1:-1].replace('\\"', '"') if raw[0] in "\"'" else raw
        if name and name not in out:
            out.append(name)
    return out


def thread_config(web: bool = False, path: Path | None = None) -> dict:
    """app-server 每個對話自己的設定（thread/start 的 config）。
    Codex 0.160 起使用者裝的外掛（電腦操作 cua_repl、Gmail／GitHub／雲端硬碟的 codex_apps…）是跟著對話載入的，
    行程層級的 -c features.*=false、plugins.*.enabled=false 擋不住（實測：模型在回答裡試著打開 Chrome 和終端機）；
    要寫在這裡，加上 turn/start 的 disabledPluginIds（plugin_ids）才真的不載入。
    不給執行指令、看圖的工具；web=True 時開上網搜尋（web_search="live"，要 code_mode_host 才叫得動）。"""
    feats = {f: False for f in FEATURES_OFF if f != "code_mode_host"}
    feats.update({"shell_tool": False, "unified_exec": False, "view_image": False, "code_mode_host": bool(web)})
    conf: dict = {"features": feats, "web_search": "live" if web else "disabled"}
    ids = plugin_ids(path)
    if ids:
        conf["plugins"] = {i: {"enabled": False} for i in ids}
    try:
        names = server_names((path or config_path()).read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError):
        names = []
    if names:
        conf["mcp_servers"] = {n: {"enabled": False} for n in names}
    return conf
