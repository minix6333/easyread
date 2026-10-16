"""peek.py：PDF 自己帶的連結（內部跳轉、網址）、參考文獻和附錄從哪裡開始、沒有連結時從文字找「Figure 2」。"""
import tempfile
import unittest
from pathlib import Path

from easyread import config  # noqa: F401  （先載 config 再載 store 相關的模組，見 memory 的 import 順序）
from easyread import peek, pdfwork


def _pdf(pages: list[list[tuple[float, float, int, str]]], annots: dict[int, list[str]]) -> bytes:
    """手寫一份小 PDF：pages[i] 是 (x, y, 字級, 字) 的清單；annots[i] 是那一頁的註記字典（字串，裡面可以用 {pN} 指到第 N 頁）。"""
    n = len(pages)
    page_ids = [4 + i * 2 for i in range(n)]
    objs: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: ("<< /Type /Pages /Kids [" + " ".join(f"{p} 0 R" for p in page_ids) + f"] /Count {n} >>").encode(),
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    next_id = 4 + n * 2
    for i, items in enumerate(pages):
        content = "".join(f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n" for x, y, size, text in items).encode()
        annot_refs = []
        for a in annots.get(i, []):
            for k, pid in enumerate(page_ids):
                a = a.replace("{p%d}" % (k + 1), f"{pid} 0 R")
            objs[next_id] = a.encode()
            annot_refs.append(f"{next_id} 0 R")
            next_id += 1
        objs[page_ids[i]] = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
                             f"/Contents {page_ids[i] + 1} 0 R" + (" /Annots [" + " ".join(annot_refs) + "]" if annot_refs else "") + " >>").encode()
        objs[page_ids[i] + 1] = b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream"
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for k in sorted(objs):
        offsets[k] = len(out)
        out += b"%d 0 obj\n" % k + objs[k] + b"\nendobj\n"
    xref = len(out)
    size = max(objs) + 1
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for k in range(1, size):
        out += b"%010d 00000 n \n" % offsets.get(k, 0) if k in offsets else b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)
    return bytes(out)


class PeekLinks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, data: bytes) -> tuple[Path, Path]:
        pdf = self.dir / "source.pdf"
        pdf.write_bytes(data)
        ex = self.dir / "extract"
        pdfwork.extract_text(pdf, ex)
        return pdf, ex

    def test_internal_links_uri_and_reference_section(self):
        body = [(72, 700, 12, "As shown in prior work [1], this holds."), (72, 680, 12, "Code at the project page.")]
        refs = [(72, 720, 16, "References"), (72, 690, 10, "[1] A. Author. A study of things. 2020."),
                (72, 400, 16, "A  Additional Experiments"), (72, 370, 10, "More results here for the appendix part of it.")]
        filler = [(72, 300 - 14 * k, 10, "This is a long line of ordinary body text used to measure the usual height.") for k in range(4)]
        annots = {0: ["<< /Type /Annot /Subtype /Link /Rect [205 695 222 712] /Border [0 0 0] /Dest [{p2} /XYZ 72 702 0] >>",
                      "<< /Type /Annot /Subtype /Link /Rect [72 675 220 692] /A << /S /URI /URI (https://example.org/code) >> >>"]}
        pdf, ex = self._write(_pdf([body + filler, refs + filler], annots))
        data = peek.compute(pdf, ex)
        links = data["pages"]["1"]
        internal = [x for x in links if "to" in x]
        self.assertEqual(len(internal), 1)
        self.assertEqual(internal[0]["to"], 2)
        self.assertAlmostEqual(internal[0]["y"], 1 - 702 / 792, places=3)
        self.assertAlmostEqual(internal[0]["x"], 72 / 612, places=3)
        x0, y0, x1, y1 = internal[0]["r"]
        self.assertAlmostEqual(x0, 205 / 612, places=3)
        self.assertAlmostEqual(y0, 1 - 712 / 792, places=3)
        self.assertEqual([x["u"] for x in links if "u" in x], ["https://example.org/code"])
        self.assertEqual(data["refs"]["page"], 2)
        self.assertLess(data["refs"]["y"], 0.12)
        self.assertEqual(data["appx"]["page"], 2)
        self.assertGreater(data["appx"]["y"], 0.45)

    def test_mentions_link_to_captions_when_the_pdf_has_no_links(self):
        p1 = [(72, 700, 11, "The results in Figure 2 and Table 1 are discussed below."), (72, 680, 11, "Nothing else to say here.")]
        p2 = [(72, 700, 11, "Figure 2: Accuracy over training steps."), (72, 500, 11, "Table 1: Main results.")]
        pdf, ex = self._write(_pdf([p1, p2], {}))
        data = peek.compute(pdf, ex)
        ms = sorted(data["pages"]["1"], key=lambda x: x["r"][0])
        self.assertEqual([m["m"] for m in ms], ["figure 2", "table 1"])
        self.assertTrue(all(m["to"] == 2 for m in ms))
        self.assertLess(ms[0]["y"], ms[1]["y"])
        self.assertNotIn("2", data["pages"])  # 題注自己不算提到

    def test_links_are_cached_beside_the_extracted_text_and_follow_the_pdf(self):
        root = self.dir / "paper"
        root.mkdir()
        (root / "source.pdf").write_bytes(_pdf([[(72, 700, 12, "Hello")]], {}))
        first = peek.links(root)
        self.assertEqual(first["pages"], {})
        cached = Path(peek.paths.derived(root, "extract")) / "links.json"
        self.assertTrue(cached.exists())
        (root / "source.pdf").write_bytes(_pdf([[(72, 700, 12, "Hello")]], {0: ["<< /Type /Annot /Subtype /Link /Rect [72 690 120 712] /A << /S /URI /URI (https://a.b/) >> >>"]}))
        self.assertEqual(peek.links(root)["pages"]["1"][0]["u"], "https://a.b/")


if __name__ == "__main__":
    unittest.main()
