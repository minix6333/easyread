"""界面偏好（字号、版心、主题、快捷键……）存在数据目录的 prefs.json。

以前放在浏览器 localStorage 里，换个浏览器或清一下缓存就没了；现在以这份文件为准，浏览器里只留一份缓存。
"""
from __future__ import annotations

import threading

from . import config
from .store import read_json_lenient, write_json_atomic

ALLOWED = {"reader", "keys", "ui", "library", "import"}  # ui：功能开关 features、快捷键总开关 keys_on
_lock = threading.Lock()  # 讀出來、併進去、寫回去要一口氣做完：每個請求一條執行緒，幾個頁面同時存會互相蓋掉


def path():
    # 测试用的临时文献库各自带一份，不碰真实偏好
    return config.library_dir() / ".prefs.json" if config.temp_library() else config.HOME / "prefs.json"


def load() -> dict:
    # 每一頁都要讀它（介面語言）：檔案壞了不能讓整個程式打不開，救得回來就救、救不回來當成沒設定過（store.read_json_lenient）
    data = read_json_lenient(path(), {})
    return data if isinstance(data, dict) else {}


def save(patch: dict) -> dict:
    with _lock:
        data = load()
        for k, v in (patch or {}).items():
            if k in ALLOWED and isinstance(v, dict):
                data[k] = {**(data[k] if isinstance(data.get(k), dict) else {}), **v}
        write_json_atomic(path(), data)
        return data
