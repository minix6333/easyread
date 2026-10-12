"""同一條連線上，一個被拒絕的請求不能弄壞下一個請求。  python -m unittest tests.test_keepalive

瀏覽器對本機服務的連線是保持著的。以前請求一進來就因為權杖不對（或沒有這篇、路徑不認得）被擋掉時，它帶來的內容沒人讀，
留在連線上被當成下一個請求的開頭——接著在同一條連線上要的東西（頁面、JS、圖）就收到 501。
已經刪掉的文件還開著分頁、關掉它時送出的閱讀進度正好會走到這裡。"""
import json
import os
import socket
import tempfile
import threading
import unittest
import urllib.request

from easyread import launch, server


def _read_response(f):
    """從連線上讀一個完整的回應：回傳（狀態碼, 標頭, 內容）。"""
    status = f.readline().decode("latin-1")
    headers = {}
    while True:
        line = f.readline().decode("latin-1")
        if line in ("\r\n", "\n", ""):
            break
        k, _, v = line.partition(":")
        headers[k.strip().lower()] = v.strip()
    body = f.read(int(headers.get("content-length", "0")))
    return int(status.split()[1]), headers, body


class KeepAliveTest(unittest.TestCase):
    def setUp(self):
        os.environ["EASYREAD_LIBRARY"] = tempfile.mkdtemp()
        self.app = server.App(server.config.load())
        server.Handler.app = self.app
        self.httpd = launch._Server(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.f = self.sock.makefile("rb")

    def tearDown(self):
        self.f.close()
        self.sock.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        os.environ.pop("EASYREAD_LIBRARY", None)

    def send(self, method, path, body=b"", token=None):
        head = f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
        if body or method == "POST":
            head += f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
        if token is not None:
            head += f"X-Token: {token}\r\n"
        self.sock.sendall(head.encode() + b"\r\n" + body)
        return _read_response(self.f)

    def assert_still_usable(self):
        code, _, body = self.send("GET", "/api/version")
        self.assertEqual(code, 200, body[:200])
        self.assertIn("version", json.loads(body))

    def test_bad_token_post_does_not_poison_the_connection(self):
        ops = json.dumps({"ops": [{"op": "progress", "block": "head", "ratio": 0, "page": 1}], "client": "x"}).encode()
        code, headers, _ = self.send("POST", "/api/p/eeeeeeeeeeee/ops", ops, token="")
        self.assertEqual(code, 403)
        self.assertNotEqual(headers.get("connection"), "close")  # 小的內容讀掉就好，連線照用
        self.assert_still_usable()

    def test_missing_paper_and_unknown_path_do_not_poison_the_connection(self):
        body = json.dumps({"ops": [], "client": "x"}).encode()
        code, _, _ = self.send("POST", "/api/p/eeeeeeeeeeee/ops", body, token=self.app.token)
        self.assertIn(code, (400, 404))
        self.assert_still_usable()
        code, _, _ = self.send("POST", "/api/no-such-thing", b'{"a": 1}', token=self.app.token)
        self.assertEqual(code, 404)
        self.assert_still_usable()
        code, _, _ = self.send("POST", "/api/notes/ffffffffffff", b'{"title": "x"}', token=self.app.token)
        self.assertEqual(code, 400)  # 沒有這份筆記
        self.assert_still_usable()

    def test_refused_big_upload_closes_the_connection_instead(self):
        big = b"x" * (2 << 20)
        head = (f"POST /api/import HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: application/pdf\r\n"
                f"Content-Length: {len(big)}\r\nX-Token: wrong\r\n\r\n").encode()
        self.sock.sendall(head)  # 內容還沒送，伺服器就該回了
        code, headers, _ = _read_response(self.f)
        self.assertEqual(code, 403)
        self.assertEqual(headers.get("connection"), "close")
        # 新的連線照常
        token = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/library").read())["token"]
        self.assertEqual(token, self.app.token)

    def test_cached_files_are_revalidated_not_trusted_for_a_day(self):
        # 可以快取的檔案：帶 ETag、要瀏覽器每次對一下；沒變回 304（不重傳），變了就給新的
        head = f"GET /web/vendor/lucide.LICENSE HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
        self.sock.sendall((head + "\r\n").encode())
        code, headers, body = _read_response(self.f)
        self.assertEqual(code, 200)
        self.assertEqual(headers.get("cache-control"), "no-cache")
        etag = headers.get("etag")
        self.assertTrue(etag and len(body) > 100)
        self.sock.sendall((head + f"If-None-Match: {etag}\r\n\r\n").encode())
        status = self.f.readline()
        self.assertIn(b"304", status)
        while self.f.readline() not in (b"\r\n", b"\n", b""):
            pass
        self.sock.sendall((head + 'If-None-Match: "something-else"\r\n\r\n').encode())
        code, _, again = _read_response(self.f)
        self.assertEqual((code, again), (200, body))
        self.assert_still_usable()

    def test_normal_posts_still_work_back_to_back(self):
        for i in range(3):
            code, _, body = self.send("POST", "/api/prefs", json.dumps({"reader": {"fs": 20 + i}}).encode(), token=self.app.token)
            self.assertEqual(code, 200, body[:200])
        self.assert_still_usable()


if __name__ == "__main__":
    unittest.main()
