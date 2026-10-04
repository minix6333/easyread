"""譯文語言：論文翻成哪種語言。預設繁體中文（台灣）；設定裡可以改，每篇論文第一次翻譯時記下當時的語言。

資料格式不變：譯文仍然存在 zh / caption_zh / title_zh 這些欄位裡，欄位名只是歷史叫法。
zh 是簡體中文（上游的預設），zh-TW 是繁體中文（台灣用語）；1.3 以前譯的論文沒記語言，都是簡體。
"""
from __future__ import annotations

# 代碼 → (介面上顯示的名字, 提示詞裡怎麼稱呼, 英文名)
TARGETS = {
    "zh-TW": ("繁體中文", "繁體中文（台灣用語）", "Traditional Chinese"),  # i18n-ok 語言名
    "zh": ("简体中文", "中文", "Simplified Chinese"),  # i18n-ok 提示詞沿用上游的「中文」
    "ja": ("日本語", "日语（日本語）", "Japanese"),  # i18n-ok
    "ko": ("한국어", "韩语（한국어）", "Korean"),  # i18n-ok
    "es": ("Español", "西班牙语（Español）", "Spanish"),  # i18n-ok
    "fr": ("Français", "法语（Français）", "French"),  # i18n-ok
    "de": ("Deutsch", "德语（Deutsch）", "German"),  # i18n-ok
}
DEFAULT = "zh-TW"
LEGACY = "zh"  # 沒記語言的舊論文


def valid(code: str | None) -> str:
    return code if code in TARGETS else DEFAULT


def is_chinese(code: str | None) -> bool:
    return code in ("zh", "zh-TW")


def of_paper(meta: dict | None, cfg: dict | None = None) -> str:
    """這篇論文的譯文語言：翻過的用當時記下的，沒翻過的用設定裡的。"""
    meta = meta or {}
    if meta.get("target") in TARGETS:
        return meta["target"]
    if meta.get("title_zh"):  # 1.3 以前譯的論文沒記語言，都是簡體中文
        return LEGACY
    if cfg is None:
        from . import config
        cfg = config.load()
    return valid(cfg.get("target"))


def remember(ws, code: str | None) -> None:
    """匯入時選了譯文語言：記到這篇論文上。已經有譯文的論文不改，免得一篇裡混兩種語言。"""
    if code not in TARGETS:
        return

    def apply(paper):
        meta = paper.setdefault("meta", {})
        if not meta.get("target") and not any(b.get("zh") or b.get("caption_zh") for b in paper.get("blocks", [])):
            meta["target"] = code
    ws.update("paper", apply)


def prompt_name(code: str) -> str:
    return TARGETS[valid(code)][1]


def listing() -> list[dict]:
    return [{"id": k, "name": v[0]} for k, v in TARGETS.items()]


def reply_code(meta: dict | None) -> str:
    """問 AI、整理筆記用什麼語言回答（代碼）：論文翻過就用譯文語言，沒翻過跟介面語言。
    簡體論文（含沒記語言的舊論文）的回答跟著介面的簡繁（介面是英文時用繁體）：簡體只有明確選了簡體介面才會出現。"""
    meta = meta or {}
    from . import i18n
    ui = i18n.lang()
    target = meta["target"] if meta.get("target") in TARGETS else (LEGACY if meta.get("title_zh") else None)
    if target == LEGACY:
        return "zh" if ui == "zh" else "zh-TW"
    return target or ui


def reply_lang(meta: dict | None) -> str:
    """問 AI、整理筆記用什麼語言回答：提示詞裡的稱呼。"""
    code = reply_code(meta)
    return "英文（English）" if code == "en" else prompt_name(code)  # i18n-ok 提示詞
