"""模型回的 JSON（出複習卡、術語表、比較表）常常不守規矩：前後多一句話、包在 ``` 裡、字串裡直接換行、
TeX 只打一條反斜線。這裡寬鬆地拿出第一個完整的 JSON 值；拿不到回 None。

反斜線：JSON 合法的跳脫只有 \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX。模型照 TeX 寫 \\kappa（不合法）整份就解析失敗；
\\theta、\\nabla、\\frac、\\beta、\\rho、\\underline 看起來合法，會被吃成 tab、換行、換頁……字就壞了（「heta」「abla」）。
所以先把字串裡「不合法的跳脫」和「其實是 TeX 指令的」補成兩條反斜線；單獨的 \\n \\t（後面不是 TeX 指令）照常是換行、tab。
"""
from __future__ import annotations

import json
import re

_VALID = set('"\\/bfnrtu')
# 開頭是 b f n r t u 的 TeX 指令（後面不能再接字母，\\nabla 對、\\nabc 不算）
_TEXCMD = re.compile(
    r"(?:t(?:heta|au|imes|ext(?:bf|it|rm|sf|tt)?|ilde|op|o|riangle|frac|binom|ag)|"
    r"n(?:abla|eq|u|ot|otin|ewline|i|e|eg|mid|earrow|leq|geq|olimits|warrow)|"
    r"f(?:rac|orall|lat|rown|ootnotesize)|"
    r"b(?:eta|ar|f|ig|igl|igr|igg|oldsymbol|inom|ot|ullet|egin|mod|ackslash|reve|eth|m|ox|ecause|igcup|igcap|igoplus|igotimes|igvee|igwedge|lacksquare|rack|race)|"
    r"r(?:ho|ight|angle|m|ceil|floor|ightarrow|brace|brack|Vert|vert|ef|ightharpoonup|ightleftharpoons|aisebox)|"
    r"u(?:parrow|nderline|psilon|nderbrace|nion|plus|lcorner|rcorner|downarrow|nderset|pharpoonright))(?![A-Za-z])")


def _repair(s: str) -> str:
    """字串裡的反斜線：TeX 指令和不合法的跳脫補成兩條；字串外面照抄。"""
    out, i, n, in_str = [], 0, len(s), False
    while i < n:
        c = s[i]
        if not in_str:
            out.append(c)
            in_str = c == '"'
            i += 1
            continue
        if c == '"':
            in_str = False
            out.append(c)
            i += 1
            continue
        if c == "\\":
            nxt = s[i + 1] if i + 1 < n else ""
            tex = nxt in "bfnrtu" and _TEXCMD.match(s, i + 1)
            bad_u = nxt == "u" and not re.fullmatch(r"[0-9a-fA-F]{4}", s[i + 2:i + 6])
            if nxt in _VALID and not tex and not bad_u:
                out.append(c + nxt)
                i += 2
                continue
            out.append("\\\\")  # 當成字面上的反斜線（後面那個字下一輪照常處理）
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def first(text: str, opens: str = "[{"):
    """text 裡第一個以 opens 裡的字元開頭、完整的 JSON 值；後面多的字不管。拿不到回 None。"""
    s = re.sub(r"^\s*```(?:json|JSON)?\s*|\s*```\s*$", "", text or "")
    dec = json.JSONDecoder(strict=False)  # strict=False：字串裡直接換行也收
    for m in re.finditer("[" + re.escape(opens) + "]", s):
        try:
            value, _end = dec.raw_decode(_repair(s[m.start():]))
            return value
        except ValueError:
            continue
    return None
