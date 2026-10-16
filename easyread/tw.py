"""繁體中文（台灣）：簡轉繁與台灣用語。

介面詞典由 scripts/i18n_tw.py 產生；這裡管的是「進出模型的文字」：
- 給模型的提示詞：上游的提示詞是簡體寫的，譯文語言是 zh-TW 時整段轉成繁體再送，模型才不會跟著寫簡體。
- 模型回來的文字（翻譯、問 AI、筆記點評）：一律再過一遍，保證介面上不出現簡體字。

怎麼轉（to_tw）：
1. 字：夾了簡體字的那一小句轉成繁體（OpenCC 的 s2t；一對多的字靠詞組判斷，发→發／髮）；最後整段換成台灣的標準字形（t2tw）。
2. 詞：大陸用語換成台灣的說法（软件→軟體）。**只對真的夾了簡體字的那一小句做**；本來就是繁體的句子不換詞
   （只有 _ALWAYS 那幾個台灣完全不用的詞例外）。

為什麼分開：2.1.0-tw.10 以前是整段套 OpenCC 的 s2twp（字＋詞一起）。它的詞組表是給電腦介面用的，而且是「看到這幾個字連在一起就換」，
不管那幾個字是不是一個詞。模型明明寫了通順的繁體，存下來卻變成——
  參數→引數、損失函數→損失函式、激活函數→啟用函式、局部最小值→區域性最小值、前綴→字首（詞義不對）
  明顯存在差異→明視訊記憶體在差異、區間內存在一點→區間記憶體在一點、這篇論文本身→這篇論文字身、
  線性能夠分開→線效能夠分開、在線性可分→線上性可分、受傷的士兵→受傷計程車兵、包羅萬象→包羅永珍（字剛好連在一起）
這些都是實際會出現的句子（tests/test_tw.py 裡有一整排）。現在繁體的句子不碰，就不會再有；
簡體的那一小句照舊換詞，但表裡會改錯的詞不換（_KEEP），再補幾個學術上的說法（_TERMS）。
只動漢字，TeX、JSON 鍵、英文都不受影響。詞組轉換可能改變字串長度，所以譯文要在算句子對齊（sentences.attach）之前轉。
"""
from __future__ import annotations

import re
from functools import lru_cache

CODE = "zh-TW"
_HAN = re.compile("[㐀-䶿一-鿿]")  # i18n-ok 漢字範圍
# 串流回答留到這些字元之後再轉，詞語才不會被切在兩段中間
_BOUNDARY = "\n。！？；，、：）」』.,;:!?) "  # i18n-ok 標點表

# 夾了簡體字的句子才會用到台灣詞組表；表裡這些詞還是不換（左邊是表裡的來源詞，繁體）——
# 詞義不對的：參數→引數、函數→函式、局部→區域性、前綴→字首、圖像→影象、文件→檔案、對象→物件、通過→透過、支持→支援、循環→迴圈、
#   激活→啟用、實例→例項、項目→專案、程序→程式、連接→連線（全連接層）、映射→對映、擴展→擴充套件、集成→整合、類型→型別、
#   範式→正規化、算子→運算元、導出→匯出（導出公式）、刷新→重新整理、適配器→介面卡、多任務→多工…
# 很容易和前後的字湊成別的詞的：內存（區間內存在）、顯存（明顯存在）、文本（論文本身）、性能（線性能夠）、在線（在線性）、的士（的士兵）、
#   萬象（包羅萬象）、比特（相比特徵）、數組（大多數組織）、保存（確保存在）、調用（強調用）、界面（世界面臨）、高清（最高清晰度）…
_KEEP = frozenset((
    "參數 參數表 函數 局部 全局 前綴 後綴 圖像 文件 對象 通過 支持 循環 激活 實例 項目 程序 進程 連接 聯繫 映射 擴展 集成 類型 範式 "  # i18n-ok 詞表
    "算子 捲積 發佈 刷新 聲明 審覈 導入 導出 權限 視圖 鏡像 多任務 適配器 分區 像素 綁定 串行 性價比 "  # i18n-ok 詞表
    "內存 顯存 文本 性能 在線 的士 萬象 比特 數組 保存 調用 調度 調試 回調 界面 高清 查找 查看 設置 字符 字體 圖標 縮進 進制 "  # i18n-ok 詞表
    "高級 低級 高端 散列 信道 指針 詞組 批量 加納 歐拉 奔馳 網卡 死機 總線 運行 內核 內置 交互 仿真 腳本 用戶 智能 社區 搜索 "  # i18n-ok 詞表
    "創建 優化 接口 窗口 設備 登錄 菜單 溢出 發送 通信 屏蔽 截取 拷貝 信號 採樣 添加 打開 組件 剪切 呼出 消息"  # i18n-ok 詞表
).split())
# 表裡換得不好的、和表裡沒有的大陸學術用語 → 台灣的說法（一樣只用在夾了簡體字的句子）。
# 右邊和左邊一樣的是「保護」：這個詞整個留著，裡面的短詞不要被換（均方差、平方差裡的方差）。
_TERMS = {  # i18n-ok 詞表
    "激光": "雷射", "筆記本電腦": "筆記型電腦", "信息安全": "資訊安全", "計算機安全": "電腦安全", "計算機視覺": "電腦視覺",  # i18n-ok 詞表
    "似然函數": "概似函數", "最大似然": "最大概似", "對數似然": "對數概似", "似然估計": "概似估計", "似然比": "概似比",  # i18n-ok 詞表
    "貝葉斯": "貝氏", "樸素貝葉斯": "單純貝氏", "魯棒": "穩健", "協方差": "共變異數", "方差": "變異數",  # i18n-ok 詞表
    "均方差": "均方差", "平方差": "平方差", "立方差": "立方差", "次方差": "次方差", "標量": "純量", "目標量": "目標量",  # i18n-ok 詞表
    "泊松": "卜瓦松", "伯努利": "白努利", "馬爾可夫": "馬可夫", "馬爾科夫": "馬可夫", "蒙特卡洛": "蒙地卡羅", "蒙特卡羅": "蒙地卡羅",  # i18n-ok 詞表
    "最小二乘": "最小平方", "歸一化": "正規化", "鏈式法則": "連鎖律", "拉格朗日乘子": "拉格朗日乘數", "置信區間": "信賴區間", "假設檢驗": "假設檢定",  # i18n-ok 詞表
    "線性回歸": "線性迴歸", "邏輯回歸": "邏輯迴歸", "回歸分析": "迴歸分析", "回歸模型": "迴歸模型", "回歸問題": "迴歸問題", "自回歸": "自迴歸",  # i18n-ok 詞表
    "最優解": "最佳解", "最優化": "最佳化", "最優值": "最佳值", "最優策略": "最佳策略", "最優點": "最佳點", "局部最優": "局部最佳", "全局最優": "全域最佳", "次優": "次佳",  # i18n-ok 詞表
    "全局最小": "全域最小", "全局最大": "全域最大", "全局變量": "全域變數", "聚類": "分群", "目標檢測": "物件偵測", "異常檢測": "異常偵測", "邊緣檢測": "邊緣偵測",  # i18n-ok 詞表
    "語音識別": "語音辨識", "人臉識別": "人臉辨識", "監督學習": "監督式學習", "無監督學習": "非監督式學習", "半監督學習": "半監督式學習", "自監督學習": "自監督式學習",  # i18n-ok 詞表
    "並行處理": "平行處理", "並行化": "平行化", "並行運算": "平行運算", "維數災難": "維度災難",  # i18n-ok 詞表
    "改變量": "改變量", "運算法則": "運算法則", "計算法則": "計算法則", "估算法": "估算法",  # i18n-ok 詞表
}
# 本來就是繁體的句子也換的詞：只有這幾個——台灣完全不這樣講、又不容易和前後的字湊成別的詞。右邊和左邊一樣的是保護。
_ALWAYS = {  # i18n-ok 詞表
    "信息": "資訊", "概率": "機率", "默認": "預設", "視頻": "影片", "軟件": "軟體", "硬件": "硬體", "網絡": "網路", "算法": "演算法",  # i18n-ok 詞表
    "運算法則": "運算法則", "計算法則": "計算法則", "估算法": "估算法", "沉默認": "沉默認",  # i18n-ok 詞表
    # 字都是簡繁共用、所以整句看不出是簡體的幾個常見詞（模型偶爾漏出來）；後面那幾個是保護：繁體裡本來就這樣寫的，不要湊成別的
    "然后": "然後", "之后": "之後", "以后": "以後", "最后": "最後", "后来": "後來", "里面": "裡面",  # i18n-ok 詞表
    "公里": "公里", "英里": "英里", "千里": "千里", "鄰里": "鄰里", "故里": "故里", "皇后": "皇后", "王后": "王后", "太后": "太后",  # i18n-ok 詞表
}
_CLAUSE = re.compile("[^。！？；，、：\n.,;:!?]*[。！？；，、：\n.,;:!?]?")  # i18n-ok 一小句一小句切（連同後面那個標點）
_SENTENCE = re.compile("[^。！？\n]*[。！？\n]?")  # i18n-ok 一整句一整句切（連同後面那個句號）


@lru_cache(maxsize=1)
def _cc():
    """簡→繁（字，連同一對多的字靠詞組判斷：发→發／髮）。不含台灣詞組，那一步在 _phrases。"""
    import opencc  # opencc-python-reimplemented，純 Python
    return opencc.OpenCC("s2t")


@lru_cache(maxsize=1)
def _cc_variants():
    """繁體 → 台灣的標準字形（裏→裡、爲→為…）。"""
    import opencc
    return opencc.OpenCC("t2tw")


@lru_cache(maxsize=1)
def _simplified() -> frozenset[str]:
    """只有簡體才用的字（发、这、们…）。像 后、里、干、面、系 這種繁體裡也有的字不算——有它們不代表這一句是簡體。"""
    chars: set[str] = set()
    try:
        import os
        import opencc
        path = os.path.join(os.path.dirname(opencc.__file__), "dictionary", "STCharacters.txt")
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 2 and len(parts[0]) == 1 and parts[0] not in parts[1].split(" "):
                    chars.add(parts[0])
    except Exception:  # noqa: BLE001 —— 讀不到字表：當成都不是簡體（只轉字、不換詞）
        pass
    return frozenset(chars)


def _longest(table: dict[str, str]) -> int:
    return max((len(k) for k in table), default=1)


@lru_cache(maxsize=1)
def _table() -> tuple[dict[str, str], int]:
    """夾了簡體字的句子用的表（來源詞 → 台灣說法）和最長的來源詞有幾個字：OpenCC 的台灣詞組表去掉 _KEEP，蓋上 _TERMS、_ALWAYS。"""
    table: dict[str, str] = {}
    try:
        import os
        import opencc
        path = os.path.join(os.path.dirname(opencc.__file__), "dictionary", "TWPhrases.txt")
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 2 and parts[0] and parts[0] not in _KEEP:
                    table[parts[0]] = parts[1].split(" ")[0]  # 有幾個候選的用第一個（OpenCC 也是）
    except Exception:  # noqa: BLE001 —— 詞典讀不到就只用自己的那幾條
        pass
    table.update(_TERMS)
    table.update(_ALWAYS)
    return table, _longest(table)


def _phrases(text: str, table: dict[str, str], longest: int) -> str:
    """由左到右、每個位置找最長的來源詞來換（和 OpenCC 一樣的比對法）。
    已經是台灣說法的不再換：「演算法」裡的「算法」、「虛擬機器」裡的「虛擬機」（不然會疊成「演演算法」）。"""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if not ("㐀" <= ch <= "鿿"):  # i18n-ok 不是漢字：直接過
            out.append(ch)
            i += 1
            continue
        for size in range(min(longest, n - i), 0, -1):
            src = text[i:i + size]
            dst = table.get(src)
            if dst is None:
                continue
            if dst != src and src in dst:  # dst = a + src + b：前後已經是 a、b 就表示本來就是台灣說法
                a, b = dst.split(src, 1)
                if (a or b) and text[max(0, i - len(a)):i] == a and text[i + size:i + size + len(b)] == b:
                    dst = src
            out.append(dst)
            i += size
            break
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _convert(text: str) -> str:
    """字：這一整句（到句號、問號、換行）夾了簡體字，整句轉成繁體（s2t）——「然后，我们…」的「然后」也會一起轉；
    整句都沒有簡體字就不轉字（2.1.0-tw.12 以前每一句都跑 s2t：「只」這種簡繁共用、一對多的字會被它的詞組表改掉，
    「還是只用在」變成「還是隻用在」）。
    詞：一小句一小句看，那一小句真的夾了簡體字才照整張表換，否則只換 _ALWAYS 那幾個。"""
    simp = _simplified()
    full, full_len = _table()
    out = []
    for sm in _SENTENCE.finditer(text):
        sentence = sm.group(0)
        if not sentence:
            continue
        chars = any(ch in simp for ch in sentence)
        for m in _CLAUSE.finditer(sentence):
            clause = m.group(0)
            if not clause:
                continue
            if not _HAN.search(clause):
                out.append(clause)
            elif any(ch in simp for ch in clause):
                out.append(_phrases(_cc().convert(clause), full, full_len))
            else:
                out.append(_phrases(_cc().convert(clause) if chars else clause, _ALWAYS, 4))
    return "".join(out)


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


@lru_cache(maxsize=1)
def _dedup_rules() -> tuple[tuple[str, str], ...]:
    """s2twp 的台灣詞組規則裡，目標詞包含來源詞的（算法→演算法、虛擬機→虛擬機器）：模型本來就寫「演算法」時，
    裡面的「算法」會再被換一次，變成「演演算法」（實測一篇論文裡出現了 41 次）。從詞典找出這類規則，轉完後把疊出來的字去掉；
    轉兩次也不會再長。"""
    rules: list[tuple[str, str]] = []
    try:
        import os
        import opencc
        path = os.path.join(os.path.dirname(opencc.__file__), "dictionary", "TWPhrases.txt")
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 2:
                    continue
                src = parts[0]
                for dst in parts[1].split(" "):
                    if src != dst and src in dst:
                        a, b = dst.split(src, 1)  # dst = a + src + b；轉兩次就成了 a + dst + b
                        rules.append((a + dst + b, dst))
    except Exception:  # noqa: BLE001 —— 詞典讀不到就只用下面寫死的幾條
        pass
    rules += [("演演算法", "演算法"), ("運運算", "運算")]  # i18n-ok 疊字修正
    return tuple(dict.fromkeys(rules))


def _dedup(text: str) -> str:
    for bad, good in _dedup_rules():
        if bad in text:
            text = text.replace(bad, good)
    return text


def to_tw(text):
    """簡體（或混雜）→ 繁體台灣用語；沒有漢字的原樣返回。本來就是繁體的句子只轉字形、不換詞（見檔頭）。"""
    if not isinstance(text, str) or not _HAN.search(text):
        return text
    out = _cc_variants().convert(_convert(text))
    return _dedup(out).replace("臺", "台")  # i18n-ok 台灣、平台：介面和譯文都用「台」；_dedup 修的是以前存下來的疊字


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
