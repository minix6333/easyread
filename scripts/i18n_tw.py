"""產生繁體中文（台灣）介面詞典 easyread/web/i18n/zh-TW.json。

程式裡的中文原文（簡體）是詞條的鍵；英文在 en.json，繁體在 zh-TW.json。
這支腳本以 en.json 的鍵為準，用 OpenCC（s2twp，簡轉繁＋台灣用語）轉一遍，再套用下面的人工修正，
最後保留 zh-TW.json 裡已經手改過、和自動結果不同的詞條（除非加 --fresh）。

上游新增字串後重跑：
    python scripts/i18n_tw.py          # 補上新鍵，保留手改
    python scripts/i18n_tw.py --fresh  # 全部重新產生
    python scripts/i18n_tw.py --check  # 只列出 zh-TW.json 缺了哪些鍵（測試用）
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EN = ROOT / "easyread" / "web" / "i18n" / "en.json"
TW = ROOT / "easyread" / "web" / "i18n" / "zh-TW.json"
AUTO = ROOT / "easyread" / "web" / "i18n" / "zh-TW.auto.json"  # 上次自動轉出的結果，用來分辨哪些是手改過的

# 整句修正：鍵是簡體原文，值是繁體（台灣用語）。OpenCC 轉不對、或整句要換說法的放這裡。
WHOLE: dict[str, str] = {
    "宋体": "明體",
    "黑体": "黑體",
    "字号": "字級",
    "下划线": "底線",
    "国内直连": "中國大陸直連",
    "海外（要梯子）": "國際服務",
    "查看跳过的项目": "檢視跳過的項目",
    "已复制 {copied} 篇，跳过 {skipped} 项": "已複製 {copied} 篇，跳過 {skipped} 項",
}

# 詞語修正：在 OpenCC 轉完的結果上做字面替換（依序套用）。只放台灣慣用、而 s2twp 沒轉到的詞。
PHRASES: list[tuple[str, str]] = [
    ("臺", "台"),                 # 平臺、臺灣 → 平台、台灣（UI 習慣寫法）
    ("劃線", "畫線"),             # 畫線、畫重點
    ("下劃線", "底線"),
    ("字號", "字級"),
    ("宋體", "明體"),
    ("質量", "品質"),
    ("標籤頁", "分頁"),
    ("後臺", "背景"), ("後台", "背景"),  # 後台翻譯 → 背景翻譯
    ("梯子", "VPN"),
    ("網盤", "雲端硬碟"),
    ("雲文獻庫", "雲端文獻庫"),
    ("重新整理頁面", "重新整理頁面"),
    ("聯網", "連網"),
    ("點擊", "點選"),
    ("單擊", "點一下"),
    ("雙擊", "連點兩下"),
    ("右鍵選單", "右鍵選單"),
    ("信息", "資訊"),
    ("用戶", "使用者"),
    ("賬號", "帳號"), ("帳戶", "帳號"),
    ("默認", "預設"),
    ("視頻", "影片"),
    ("智能", "智慧"),
    ("軟件", "軟體"), ("硬件", "硬體"),
    ("數據", "資料"),
    ("文件夾", "資料夾"),
    ("鼠標", "滑鼠"),
    ("服務器", "伺服器"),
    ("網絡", "網路"),
    ("打印", "列印"),
    ("程序", "程式"),
    ("運行日誌", "執行記錄"), ("運行", "執行"),
    ("加載", "載入"),
    ("刷新", "重新整理"),
    ("保存", "儲存"),
    ("搜索", "搜尋"),
    ("屏幕", "螢幕"),
    ("窗口", "視窗"),
    ("菜單", "選單"),
    ("鏈接", "連結"),
    ("複製鏈接", "複製連結"),
    ("粘貼", "貼上"),
    ("滾動", "捲動"),
    ("支持", "支援"),
    ("優化", "最佳化"),
    ("當前", "目前"),
    ("生成", "產生"),
    ("算法", "演算法"),
    ("變量", "變數"),
    ("函數", "函式"),
    ("對象", "物件"),
    ("字符", "字元"),
    ("字節", "位元組"),
    ("內存", "記憶體"),
    ("硬盤", "硬碟"),
    ("移動", "行動"),
    ("在線", "線上"), ("離線", "離線"),
    ("調用", "呼叫"),
    ("接口", "介面"),
    ("交互", "互動"),
    ("兼容", "相容"),
    ("反饋", "回饋"),
    ("設置", "設定"),
    ("創建", "建立"),
    ("打開", "開啟"),
    ("關閉", "關閉"),
    ("退出", "結束"),
    ("登錄", "登入"),
    ("註冊", "註冊"),
    ("提交", "送出"),
    ("取消", "取消"),
    ("確定", "確定"),
    ("幫助", "說明"),
    ("導入", "匯入"), ("導出", "匯出"),
    ("掃描", "掃描"),
    ("模塊", "模組"),
    ("插件", "外掛"),
    ("配置", "設定"),
    ("解析", "解析"),
    ("目錄", "目錄"),
    ("公式", "公式"),
    ("譯文", "譯文"),
]


def convert(text: str, cc) -> str:
    if text in WHOLE:
        return WHOLE[text]
    out = cc.convert(text)
    for a, b in PHRASES:
        if a != b:
            out = out.replace(a, b)
    return out


def generate(fresh: bool = False) -> dict:
    import opencc  # opencc-python-reimplemented，純 Python
    cc = opencc.OpenCC("s2twp")
    keys = list(json.loads(EN.read_text(encoding="utf-8")).keys())
    old = {} if fresh or not TW.exists() else json.loads(TW.read_text(encoding="utf-8"))
    auto_old = {} if fresh or not AUTO.exists() else json.loads(AUTO.read_text(encoding="utf-8"))
    out, auto = {}, {}
    for k in keys:
        a = convert(k, cc)
        auto[k] = a
        cur = old.get(k)
        out[k] = cur if (cur is not None and cur != auto_old.get(k) and cur != a) else a  # 手改過的留著
    AUTO.write_text(json.dumps(auto, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return out


def missing() -> list[str]:
    keys = json.loads(EN.read_text(encoding="utf-8")).keys()
    tw = json.loads(TW.read_text(encoding="utf-8")) if TW.exists() else {}
    return [k for k in keys if k not in tw]


def main(argv):
    if "--check" in argv:
        miss = missing()
        for k in miss:
            print(k)
        return 1 if miss else 0
    data = generate(fresh="--fresh" in argv)
    TW.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n = len(data)
    still = sum(1 for k, v in data.items() if re.search(r"[一-鿿]", k) and v == k)
    print(f"zh-TW.json：{n} 條；{still} 條轉完和原文一樣（多半本來就沒有簡繁差異）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
