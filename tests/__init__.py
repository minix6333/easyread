"""测试统一用中文界面：从源码运行时数据目录就是仓库，作者在界面上切成英文后，prefs.json 不能影响测试结果。"""
import os

os.environ.setdefault("EASYREAD_LANG", "zh")
# 测试里别真的拉起 claude / codex 的常驻进程（claude_live / codex_live）；要测它们的测试自己把这个环境变量清掉
os.environ.setdefault("EASYREAD_NO_LIVE", "1")
