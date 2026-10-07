"""检查新版本：问 GitHub 最新的 Release，比当前版本新就告诉页面（文献库顶栏显示“有新版本”）。

一天最多问一次，结果记在数据目录的 update.json；没网、GitHub 连不上就当没有新版本，不报错。
帮助里关掉“自动检查新版本”后，只有点“检查更新”时才联网。
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.request

from . import VERSION, __version__, config, http
from .log import log
from .store import read_json, write_json_atomic

# 這個分支只看自己的發版。看上游的話，「有新版本」按下去會裝回上游的版本，這個分支加的功能全部不見
# （上游 1.3.2 起 Windows 版還會把資料夾搬進安裝目錄）。
REPO = "minix6333/easyread"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
EVERY = 24 * 3600   # 成功问到后多久再问
RETRY = 3 * 3600    # 没问到（没网）多久后再试
_lock = threading.Lock()


def _path():
    return config.HOME / "update.json"


def parse(v: str) -> tuple[int, ...]:
    """'v1.2.10' → (1, 2, 10)；'v1.3.1-tw.3' → (1, 3, 1, 3)（第四個數是這個分支自己的版次）；认不出的部分当 0。"""
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:4]) or (0,)


def newer(latest: str, current: str = VERSION) -> bool:
    return parse(latest) > parse(current)


def _fetch() -> dict:
    req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json", "User-Agent": f"EasyRead/{__version__}"})
    with http.urlopen(req, timeout=8) as r:
        rel = json.loads(r.read())
    return {"repo": REPO, "latest": (rel.get("tag_name") or "").lstrip("v"), "url": rel.get("html_url") or f"https://github.com/{REPO}/releases/latest",
            "notes": (rel.get("body") or "")[:6000], "published": rel.get("published_at") or ""}


def check(force: bool = False) -> dict:
    """{"current", "latest", "newer", "url", "notes", "published", "enabled"}。force：手动点“检查更新”，关掉自动检查也照样问。"""
    out = {"current": VERSION, "latest": "", "newer": False, "enabled": bool(config.load().get("check_updates", True))}
    if not out["enabled"] and not force:
        return out
    with _lock:  # 两个页面同时打开只问一次
        cache = read_json(_path(), {}) or {}
        if cache.get("repo") != REPO:  # 上次問的是別的倉庫（上游）：那個答案不能用
            cache = {}
        age = time.time() - cache.get("checked", 0)
        if force or age > (EVERY if cache.get("latest") else RETRY):
            try:
                cache = {**_fetch(), "repo": REPO, "checked": time.time()}
            except Exception as e:  # noqa: BLE001  没网、限流、GitHub 改了格式：都当没有新版本
                log.info("检查新版本没成功：%s", e)
                cache = {**cache, "repo": REPO, "checked": time.time()}
            try:
                write_json_atomic(_path(), cache)
            except OSError:
                pass
    if cache.get("latest"):
        out.update(latest=cache["latest"], url=cache.get("url", ""), notes=cache.get("notes", ""),
                   published=cache.get("published", ""), newer=newer(cache["latest"]))
    return out
