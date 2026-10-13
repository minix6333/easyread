"""繁體中文（台灣）：簡轉繁、模型輸出的保險、提示詞轉繁。  python -m unittest tests.test_tw"""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread import chat, engines, langs, translate, tw
from easyread.store import write_json_atomic
from tests.test_translate import make_ws


class TwTest(unittest.TestCase):
    def test_to_tw_only_touches_han(self):
        self.assertEqual(tw.to_tw("软件的数据在服务器上"), "軟體的資料在伺服器上")
        self.assertEqual(tw.to_tw("台湾、平台"), "台灣、平台")  # 不寫「臺」
        self.assertEqual(tw.to_tw("$\\frac{a}{b}$ and {n}"), "$\\frac{a}{b}$ and {n}")
        self.assertEqual(tw.to_tw(""), "")
        self.assertIsNone(tw.to_tw(None))
        self.assertEqual(tw.to_cn("標紅的筆記"), "标红的笔记")

    def test_already_taiwanese_terms_are_not_doubled(self):
        # 模型本來就寫「演算法」：s2twp 會把裡面的「算法」再換一次，變成「演演算法」（4cf6b1e1a402 那篇出現了 41 次）
        self.assertEqual(tw.to_tw("演算法和算法，虛擬機器與虛擬機"), "演算法和演算法，虛擬機器與虛擬機")  # 繁體的句子只換台灣完全不用的那幾個詞（算法）
        self.assertEqual(tw.to_tw("虚拟机器与虚拟机"), "虛擬機器與虛擬機器")  # 簡體的句子照舊整張表換
        self.assertEqual(tw.to_tw(tw.to_tw("MCMC 取樣演算法")), "MCMC 取樣演算法")  # 轉兩次也不會長
        self.assertEqual(tw.to_tw("模型原生的運運算元"), "模型原生的運算元")
        self.assertIn(("演演算法", "演算法"), tw._dedup_rules())

    def test_academic_terms_are_not_turned_into_computer_jargon(self):
        # 2.1.0-tw.10 以前整張套 OpenCC 的台灣詞組表（給電腦介面用的）：模型寫對的詞被改成沒人這樣講的
        # （參數→引數、函數→函式、局部→區域性、激活→啟用、前綴→字首、循環→迴圈、文件→檔案、對象→物件…）
        same = ["參數", "損失函數", "激活函數", "核函數", "局部最小值", "前綴", "循環神經網路", "全連接層", "支持向量機", "集成學習", "新的範式", "適配器",
                "多任務學習", "擴展到高維", "由此導出", "這份文件", "研究對象", "通過測試", "三種類型", "實例分割", "刷新紀錄", "兩者的聯繫", "特徵映射", "最優先"]
        for word in same:
            self.assertEqual(tw.to_tw(word), word)
        for cn, want in [("参数", "參數"), ("损失函数", "損失函數"), ("激活函数", "激活函數"), ("局部最小值", "局部最小值"), ("前缀", "前綴"),
                         ("循环神经网络", "循環神經網路"), ("全连接层", "全連接層"), ("这份文件", "這份文件"), ("这个项目", "這個項目")]:
            self.assertEqual(tw.to_tw(cn), want)
        self.assertEqual(tw.to_tw(tw.to_tw("参数和函数")), "參數和函數")  # 轉兩次也一樣

    def test_traditional_sentences_are_never_reworded(self):
        # 詞組表是「這幾個字連在一起就換」：下面每一句都是通順的繁體，2.1.0-tw.10 以前全部會被改壞
        # （明視訊記憶體在差異、區間記憶體在一點、受傷計程車兵、包羅永珍、這篇論文字身、線效能夠分開、線上性可分…）
        good = ["剛好在線上的點", "在線性可分的情況下", "明顯存在差異", "區間內存在一點", "受傷的士兵", "包羅萬象", "這篇論文本身", "相比特徵 A", "大多數組織",
                "確保存在一個解", "檢查找到的結果", "強調用這個方法", "強調度量學習", "假設置信水準", "一連串行為", "文字符號", "參加納稅", "國家安全局", "世界面臨",
                "來回調整", "搬運行李", "如圖標示的區域", "壓縮進行中", "先進制度", "提高級別", "分散列出", "相信道理", "所指針對的是", "名詞組合", "線性能夠分開",
                "這種特性能夠", "最高清晰度", "在草原上奔馳", "上網卡住", "改變量測方式", "國內核能", "四則運算法則", "他沉默認為", "平方差公式", "部分詞彙"]
        for text in good:
            self.assertEqual(tw.to_tw(text), text)
        self.assertEqual(tw.to_tw("、".join(good) + "。"), "、".join(good) + "。")
        # 同樣的句子用簡體寫：字轉成繁體，一樣不會被湊成別的詞
        for cn, want in [("明显存在差异", "明顯存在差異"), ("区间内存在一点", "區間內存在一點"), ("受伤的士兵", "受傷的士兵"), ("包罗万象", "包羅萬象"),
                         ("这篇论文本身", "這篇論文本身"), ("线性能够分开", "線性能夠分開"), ("在线性可分的情况下", "在線性可分的情況下"), ("后面的里程", "後面的里程")]:
            self.assertEqual(tw.to_tw(cn), want)
        # 一段裡只有一小句夾了簡體：只有那一小句換詞
        self.assertEqual(tw.to_tw("這篇論文本身很長，但软件很好用。"), "這篇論文本身很長，但軟體很好用。")

    def test_mainland_only_terms_still_become_taiwanese(self):
        # 夾了簡體字的句子：電腦用語照舊換，另外補了幾個學術上的；繁體的句子裡只換台灣完全不用的幾個詞
        self.assertEqual(tw.to_tw("數據和信息的概率，默認的算法"), "數據和資訊的機率，預設的演算法")
        for cn, want in [("软件的数据在服务器上", "軟體的資料在伺服器上"), ("概率分布", "機率分佈"), ("算法", "演算法"), ("信息熵", "資訊熵"), ("随机变量", "隨機變數"),
                         ("似然函数", "概似函數"), ("贝叶斯定理", "貝氏定理"), ("朴素贝叶斯", "單純貝氏"), ("鲁棒性", "穩健性"), ("方差和协方差", "變異數和共變異數"),
                         ("均方差", "均方差"), ("线性回归", "線性迴歸"), ("聚类", "分群"), ("归一化", "正規化"), ("全局最优", "全域最佳"), ("最优解", "最佳解"),
                         ("目标检测", "物件偵測"), ("马尔可夫链蒙特卡洛", "馬可夫鏈蒙地卡羅"), ("激光测距", "雷射測距"), ("面向对象", "物件導向"), ("文件夹和文件名", "資料夾和檔名"),
                         ("头发发现", "頭髮發現"), ("干燥的树干", "乾燥的樹幹"), ("里面", "裡面")]:
            self.assertEqual(tw.to_tw(cn), want)

    def test_convert_keeps_original_and_ids(self):
        data = {"blocks": [{"id": "p1-1", "type": "para", "en": "data 软件", "zh": "软件", "tex": "x_i", "items": [{"en": "a", "zh": "网络"}]}],
                "glossary": [{"en": "network", "zh": "网络"}], "meta": {"title_zh": "标题", "title_en": "Title 简体"}}
        out = tw.convert(data)
        b = out["blocks"][0]
        self.assertEqual((b["en"], b["zh"], b["tex"], b["items"][0]["zh"]), ("data 软件", "軟體", "x_i", "網路"))
        self.assertEqual(out["glossary"][0]["zh"], "網路")
        self.assertEqual((out["meta"]["title_zh"], out["meta"]["title_en"]), ("標題", "Title 简体"))
        self.assertEqual(data["blocks"][0]["zh"], "软件")  # 原物件不動

    def test_stream_waits_for_a_boundary(self):
        s = tw.Stream(True)
        self.assertEqual(s.feed("这是软"), "")  # 詞還沒完整，先留著
        self.assertEqual(s.feed("件，很好"), "這是軟體，")
        self.assertEqual(s.flush(), "很好")
        self.assertEqual(s.flush(), "")
        off = tw.Stream(False)
        self.assertEqual(off.feed("软件"), "软件")
        long = tw.Stream(True)
        self.assertNotEqual(long.feed("软" * 70), "")  # 太久沒標點也會送出

    def test_translation_output_is_guarded(self):
        ws = make_ws(1)
        self.addCleanup(shutil.rmtree, ws.root, True)

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            self.assertIn("繁體中文", prompt)
            self.assertNotIn("译成", prompt)
            return json.dumps({"glossary": [{"en": "software", "zh": "软件"}],
                               "blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "Software ‖ runs.", "zh": "软件 ‖ 运行。"}]}, ensure_ascii=False)
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}, "target": "zh-TW"}
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.netcheck, "problem", lambda cfg: ""), \
                mock.patch.object(translate.pdfwork, "locate", lambda root: None), mock.patch.object(translate, "tex_problems", lambda tex: []):
            self.assertEqual(translate.translate_pages(ws, cfg, [1], threading.Event(), lambda *a: None), {})
        paper = ws.load("paper")
        self.assertEqual(paper["meta"]["target"], "zh-TW")
        b = paper["blocks"][0]
        self.assertEqual(b["zh"], "軟體運行。")  # 轉了繁體、‖ 也正常去掉（中文句間不留空格）；「運行」台灣也通，不再硬換成「執行」
        self.assertEqual(b["en"], "Software runs.")
        self.assertIn("sents", b)  # 句子對齊在轉換之後算，位置對得上
        self.assertEqual(paper["glossary"], [{"en": "software", "zh": "軟體"}])

    def test_chat_prompt_follows_reply_language(self):
        ws = make_ws(1)
        self.addCleanup(shutil.rmtree, ws.root, True)
        paper = ws.load("paper")
        paper["meta"]["target"] = "zh-TW"
        paper["blocks"] = [{"id": "p1-1", "type": "para", "page": 1, "en": "Hello.", "zh": "你好。"}]
        write_json_atomic(ws.root / "paper.json", paper)
        text = chat.prompt(ws, [{"role": "user", "content": "這段在說什麼"}], "p1-1", "", "openai")
        self.assertIn("用繁體中文（台灣用語）", text)
        self.assertNotIn("读者", text)
        self.assertIn("這段在說什麼", text)
        with mock.patch("easyread.i18n.lang", lambda: "zh"):
            paper["meta"]["target"] = "zh"
            write_json_atomic(ws.root / "paper.json", paper)
            zh = chat.prompt(ws, [{"role": "user", "content": "问"}], "p1-1", "", "openai")
            self.assertIn("用中文。写法", zh)   # 這個分支用繁體寫的提示詞，簡體回答時轉成簡體
            self.assertNotIn("寫法", zh)

    def test_marks_detected_in_traditional_chinese(self):
        self.assertEqual(chat.wants_marks("我標紅的那些公式有什麼關係"), (True, {"红"}))
        self.assertEqual(chat.wants_marks("把我畫過線的內容串起來")[0], True)
        self.assertEqual(chat.wants_marks("這段在說什麼"), (False, None))

    def test_reply_code(self):
        with mock.patch("easyread.i18n.lang", lambda: "zh-TW"):
            self.assertEqual(langs.reply_code({"target": "zh"}), "zh-TW")
            self.assertEqual(langs.reply_code({"target": "ja"}), "ja")
            self.assertEqual(langs.reply_code({}), "zh-TW")
        with mock.patch("easyread.i18n.lang", lambda: "en"):
            self.assertEqual(langs.reply_code({}), "en")
            self.assertEqual(langs.reply_code({"title_zh": "旧"}), "zh-TW")


if __name__ == "__main__":
    unittest.main()
