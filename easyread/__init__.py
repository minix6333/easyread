"""EasyRead：把英文论文读成中文——翻译、阅读、批注与文献管理。"""
__version__ = "2.1.0"   # 分出來時上游的版本（打包、pyproject 用這個，要符合 PEP 440）
__fork__ = "tw.12"         # 這個分支自己的第幾版；發版的標籤是 v<上游版本>-<這個>，例如 v2.1.0-tw.5。
                          # 字首一定要是 tw：已經裝出去的 Windows 版靠它找更新（electron-updater 把它當頻道，見 electron/desktop-updates.cjs）
VERSION = f"{__version__}-{__fork__}"  # 顯示、檢查更新、同步心跳用
