"""介面語言：中文系統顯示繁體中文（台灣），其餘顯示英文；設定裡可以手動指定（含簡體中文）。

程式碼裡只寫中文：前端 `PR.t("中文 {n}", {n})`，後端 `tr("中文 {n}", n=…)`。
中文原文就是詞條的鍵（上游用簡體寫；本分支新加的字串直接寫繁體，繁體詞典查不到就原樣顯示），
英文在 web/i18n/en.json，繁體在 web/i18n/zh-TW.json（scripts/i18n_tw.py 產生）；缺了哪條英文，tests/test_i18n.py 會報出來。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

# 不匯入 config：config 間接匯入了很多用 tr 的模組，這裡保持沒有套件內依賴
I18N_DIR = Path(__file__).resolve().parent / "web" / "i18n"
EN_PATH = I18N_DIR / "en.json"
TW_PATH = I18N_DIR / "zh-TW.json"
LANGS = ("zh-TW", "zh", "en")      # zh 是簡體中文（上游原文）
CHOICES = ("auto",) + LANGS
HTML_LANG = {"zh-TW": "zh-TW", "zh": "zh-CN", "en": "en"}


@lru_cache(maxsize=4)
def _dict_cached(path: str, mtime: float) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load(path: Path) -> dict:
    try:
        return _dict_cached(str(path), path.stat().st_mtime)
    except (OSError, ValueError):
        return {}


def en_dict() -> dict:
    return _load(EN_PATH)


def tw_dict() -> dict:
    return _load(TW_PATH)


def dict_for(language: str) -> dict:
    return en_dict() if language == "en" else tw_dict() if language == "zh-TW" else {}


def _is_zh(tag: str | None) -> bool:
    tag = (tag or "").strip().lower().replace("_", "-")
    return tag.startswith("zh") or tag.startswith("chinese")


@lru_cache(maxsize=1)
def system_lang() -> str:
    """中文系統（不分簡繁）一律繁體中文；簡體只在設定裡手動選。"""
    # 桌面版由 Electron 傳進來（macOS 從啟動台開啟時拿不到 LANG）
    tag = os.environ.get("EASYREAD_SYSTEM_LANG")
    if tag:
        return "zh-TW" if _is_zh(tag) else "en"
    for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        value = os.environ.get(var)
        if value and value not in ("C", "POSIX", "C.UTF-8"):
            return "zh-TW" if _is_zh(value) else "en"
    if sys.platform == "win32":
        try:
            import ctypes
            return "zh-TW" if ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF == 0x04 else "en"
        except (AttributeError, OSError):
            pass
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True, timeout=3).stdout
            first = next((line.strip(' ",()') for line in out.splitlines() if line.strip(' ",()')), "")
            return "zh-TW" if _is_zh(first) else "en"
        except (OSError, subprocess.SubprocessError):
            pass
    return "zh-TW"  # 判斷不出來時用繁體中文


def choice() -> str:
    forced = os.environ.get("EASYREAD_LANG")  # 測試、排查問題時臨時指定，優先於設定
    if forced in LANGS:
        return forced
    from . import prefs
    value = (prefs.load().get("ui") or {}).get("lang")
    return value if value in CHOICES else "auto"


def lang() -> str:
    value = choice()
    return value if value in LANGS else system_lang()


def tr(text: str, **kw) -> str:
    """中文原文 → 目前語言；{name} 佔位符用 kw 填。"""
    d = dict_for(lang())
    if d:
        text = d.get(text) or text
    return text.format(**kw) if kw else text


def inject(page: str, language: str | None = None) -> str:
    """返回頁面時寫上語言；不是簡體時把詞典也塞進去，前端同步就能用。"""
    picked = choice() if language is None else language  # 設定裡的「介面語言」要顯示目前選的是哪項
    language = language or lang()
    from . import config, langs  # 用到時再匯入，見檔案開頭
    target = langs.valid(config.load().get("target"))  # 設定裡的譯文語言：按鈕文字、沒譯過的論文用它
    page = page.replace('<html lang="zh-CN">', f'<html lang="{HTML_LANG.get(language, language)}" data-lang-choice="{picked}" data-target="{target}">', 1)
    d = dict_for(language)
    if d:
        payload = json.dumps(d, ensure_ascii=False).replace("<", "\\u003c")
        page = page.replace("</title>", f'</title>\n<script id="pr-i18n" type="application/json">{payload}</script>', 1)
    return page
