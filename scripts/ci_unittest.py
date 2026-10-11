"""CI 跑單元測試：和 `python -m unittest discover tests -v` 完全一樣，另外把沒過的測試寫成 GitHub 的 ::error 註記。

Actions 的 log 要登入才看得到；註記（annotations）在執行頁面上方和公開的 API 都看得到，
哪個測試在哪個平台掛了、最後幾行錯誤是什麼，不用登入就能查。
"""
import os
import sys
import unittest

# `python -m unittest` 會把目前的資料夾放在 sys.path 最前面（有些測試 `from tests.test_translate import …`）；直接跑腳本時放的是 scripts/，要自己補上
sys.path.insert(0, os.getcwd())


def _esc(text: str) -> str:
    # 註記的內容不能直接換行：% 和換行要編碼
    return text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


def main() -> int:
    prog = unittest.main(module=None, argv=["python -m unittest", "discover", "tests", "-v"], exit=False)
    result = prog.result
    sys.stderr.flush()
    for kind, items in (("FAIL", result.failures), ("ERROR", result.errors)):
        for test, tb in items:
            tail = "\n".join(tb.strip().splitlines()[-30:])
            print(f"::error title={kind} {_esc(test.id())}::{_esc(tail)}", flush=True)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
