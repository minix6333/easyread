"""繁體中文（台灣）：簡轉繁與台灣用語。

介面詞典由 scripts/i18n_tw.py 產生；這裡管的是「進出模型的文字」：
- 給模型的提示詞：上游的提示詞是簡體寫的，譯文語言是 zh-TW 時整段轉成繁體再送，模型才不會跟著寫簡體。
- 模型回來的文字（翻譯、問 AI、筆記點評）：一律再過一遍，保證介面上不出現簡體字。

OpenCC 的 s2twp 只動漢字，TeX、JSON 鍵、英文都不受影響。詞組轉換（软件→軟體）可能改變字串長度，
所以譯文要在算句子對齊（sentences.attach）之前轉。
"""
from __future__ import annotations

import re
from functools import lru_cache

CODE = "zh-TW"
_HAN = re.compile("[㐀-䶿一-鿿]")  # i18n-ok 漢字範圍
# 串流回答留到這些字元之後再轉，詞語才不會被切在兩段中間
_BOUNDARY = "\n。！？；，、：）」』.,;:!?) "  # i18n-ok 標點表


@lru_cache(maxsize=1)
def _cc():
    import opencc  # opencc-python-reimplemented，純 Python
    return opencc.OpenCC("s2twp")


@lru_cache(maxsize=1)
def _cc_back():
    import opencc
    return opencc.OpenCC("t2s")


def to_cn(text):
    """繁→簡（只動字，不換詞）：上游用簡體正則判斷讀者的問題（「標紅的」「畫線」），先轉成簡體再比對。"""
    if not isinstance(text, str) or not _HAN.search(text):
        return text
    return _cc_back().convert(text)


def is_tw(target) -> bool:
    return target == CODE


def to_tw(text):
    """簡體（或混雜）→ 繁體台灣用語；沒有漢字的原樣返回。"""
    if not isinstance(text, str) or not _HAN.search(text):
        return text
    return _cc().convert(text).replace("臺", "台")  # i18n-ok 台灣、平台：介面和譯文都用「台」


def convert(obj, skip: tuple[str, ...] = ("en", "caption_en", "image_en", "title_en", "tex", "id", "type", "src", "anchor", "key", "reply_to")):
    """遞迴轉換 JSON 結構裡的字串；skip 裡的鍵是原文、TeX、識別字，不動。"""
    if isinstance(obj, str):
        return to_tw(obj)
    if isinstance(obj, list):
        return [convert(x, skip) for x in obj]
    if isinstance(obj, dict):
        return {k: (v if k in skip else convert(v, skip)) for k, v in obj.items()}
    return obj


class Stream:
    """串流輸出逐段轉繁體：攢到標點或換行再送出，太久沒標點就先送。"""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.buf = ""

    def feed(self, piece: str) -> str:
        if not self.enabled:
            return piece
        self.buf += piece
        cut = max(self.buf.rfind(c) for c in _BOUNDARY)
        if cut < 0:
            if len(self.buf) < 60:
                return ""
            cut = len(self.buf) - 1
        out, self.buf = self.buf[:cut + 1], self.buf[cut + 1:]
        return to_tw(out)

    def flush(self) -> str:
        out, self.buf = self.buf, ""
        return to_tw(out) if self.enabled else out
