const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function markup(realKatex = false) {
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s, esc: text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/markup.js"), "utf8"), {
    window: { PR }, katex: realKatex ? require("../easyread/web/vendor/katex/katex.min.js") : { renderToString: tex => '<math>' + PR.esc(tex) + '</math>' },
  });
  return PR;
}

test("bilingual headings render without requiring blank lines before the answer", () => {
  const html = markup().mdBlocks("## English (ASD-STE100)\nThe device calculates $y=Wx$.\n## 中文解释\n器件计算 $y=Wx$。");
  assert.equal((html.match(/class="md-h"/g) || []).length, 2);
  assert.ok(!html.includes("##"));
  assert.ok(html.indexOf("English") < html.indexOf("中文解释"));
  assert.equal((html.match(/<math>y=Wx<\/math>/g) || []).length, 2);
});

test("both inline math delimiter styles render inside Chinese text and bold text", () => {
  const html = markup().md(String.raw`衰减常数 **\(\alpha\)**，相位常数 $\beta$，因子 \(\left|\frac{\sinh q}{q}\right|\)。`);
  assert.ok(html.includes(String.raw`<strong><math>\alpha</math></strong>`));
  assert.ok(html.includes(String.raw`<math>\beta</math>`));
  assert.ok(html.includes(String.raw`<math>\left|\frac{\sinh q}{q}\right|</math>`));
  assert.ok(!html.includes(String.raw`\(`));
});

test("display math is extracted before paragraph splitting, including blank lines within TeX", () => {
  const tex = String.raw`\frac{1}{L}\int_0^L e^{-(a+j\beta)z}\,dz`;
  for (const [left, right] of [["$$", "$$"], ["\\[", "\\]"]]) {
    const html = markup().mdBlocks("积分：\n" + left + "\n" + tex + "\n\n= I\n" + right + "\n\n取模后。\n" + left + String.raw`\left|\frac{\sinh q}{q}\right|` + right);
    assert.equal((html.match(/class="eq"/g) || []).length, 2);
    assert.ok(html.includes('<div class="eq"><math>' + tex + '\n\n= I</math></div>'));
    assert.ok(html.includes("<p>取模后。</p>"));
    assert.ok(!html.includes(left));
  }
});

test("table pipes inside parenthesized math or code do not create extra cells", () => {
  const html = markup().mdBlocks(String.raw`| 变量 | 定义 |
| --- | --- |
| \(q\) | \(\left|\frac{\sinh q}{q}\right|\) |
| 代码 | \`a|b\` |
| 文字 | a\|b |`.replace(/\\`/g, "`"));
  assert.equal((html.match(/<td/g) || []).length, 6);
  assert.ok(html.includes(String.raw`<math>\left|\frac{\sinh q}{q}\right|</math>`));
  assert.ok(html.includes("<code>a|b</code>"));
  assert.ok(html.includes("<td>a|b</td>"));
});

test("math delimiter examples inside code remain literal and HTML stays escaped", () => {
  const html = markup().mdBlocks("格式 `\\(x\\)` 或 `$x$`。\n\n```tex\n\\[x\\]\n\n$$<script>$$\n```\n\n正文 \\(y\\)。");
  assert.ok(html.includes("<code>\\(x\\)</code>"));
  assert.ok(html.includes("<code>$x$</code>"));
  assert.ok(html.includes("<pre><code>\\[x\\]\n\n$$&lt;script&gt;$$\n</code></pre>"));
  assert.equal((html.match(/<math>/g) || []).length, 1);
  assert.ok(!html.includes("<script>"));
});

test("unfinished streamed delimiters stay readable until the matching close arrives", () => {
  const PR = markup();
  const answer = "积分：\n\\[\n\\frac{1}{L}\\int_0^L e^{-(a+j\\beta)z}\\,dz\n\\]";
  for (let i = 0; i < answer.length; i++) {
    const html = PR.mdBlocks(answer.slice(0, i));
    assert.ok(!html.includes("<math>"));
  }
  assert.equal((PR.mdBlocks(answer).match(/<math>/g) || []).length, 1);
  assert.ok(!PR.md(String.raw`价格 \$5；未闭合 \(x；转义 \\(y\\)`).includes("<math>"));
});

test("the integral, logarithm and hyperbolic expressions use the bundled KaTeX renderer", () => {
  const html = markup(true).mdBlocks(String.raw`\(\alpha\) 与 $\beta$。
\[
20\lg\left\{e^{-\alpha L/4}R^{1/2}\right\}.
\]
\[
\frac{1}{L}\int_0^L e^{-(a+j\beta)z}\,dz
\]
$$\left|\frac{\sinh q}{q}\right|$$`);
  assert.equal((html.match(/class="katex"/g) || []).length, 5);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 3);
  assert.ok(!html.includes("katex-error"));
});

test("headings can precede tables and lists; their text still escapes HTML", () => {
  const html = markup().mdBlocks("## <script>unsafe</script>\n| Metric | Value |\n| --- | --- |\n| Error | 2% |\n## 中文解释\n- 误差为 **2%**。\n- 保留原值。");
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('<table class="tbl">'));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<strong>2%</strong>"));
  assert.equal((html.match(/class="md-h"/g) || []).length, 2);
});

test("blank lines between numbered steps do not reset each displayed number to one", () => {
  const html = markup().mdBlocks("1. 准备器件。\n\n2. 输入 $x$。\n\n3. 读取结果。");
  assert.ok(html.includes('<ol><li>准备器件。</li></ol>'));
  assert.ok(html.includes('<ol start="2"><li>输入 <math>x</math>。</li></ol>'));
  assert.ok(html.includes('<ol start="3"><li>读取结果。</li></ol>'));
});

test("links to another document or note in the library stay in the app; other local paths are not linkified", () => {
  const PR = markup();
  const html = PR.md("見 [標題，第 12 頁](/read/abc-1#page=12&find=hello%20world)、[另一份筆記](/note/0123456789ab)、[網站](https://x.y/z)、[不行](/api/notes)、[也不行](javascript:alert(1))");
  assert.match(html, /<a href="\/read\/abc-1#page=12&amp;find=hello%20world" class="doclink">標題，第 12 頁<\/a>/);
  assert.match(html, /<a href="\/note\/0123456789ab" class="doclink">另一份筆記<\/a>/);
  assert.match(html, /<a href="https:\/\/x\.y\/z" target="_blank" rel="noopener">網站<\/a>/);
  assert.ok(html.includes("[不行](/api/notes)") && !html.includes('href="javascript'));
});

test("page mentions become clickable only when the open document has that page; tags, links and code are left alone", () => {
  const PR = markup();
  assert.equal(PR.md("見第 3 頁"), "見第 3 頁");  // 沒有開著的文件（筆記頁）：不動
  PR.state = { paper: { meta: { pages: new Array(12).fill({}) } }, layout: { "p3-2": { page: 4 } } };
  PR.blockById = { "p3-2": { page: 3, type: "p" } };
  const html = PR.md("見第 3 頁、p. 7 和 Page 12；第 40 頁沒有。[p3-2] 講過。`p.2` [第 5 頁的圖](https://x.y/z)");
  assert.match(html, /見<a class="pgref" data-page="3">第 3 頁<\/a>/);
  assert.match(html, /<a class="pgref" data-page="7">p\. 7<\/a> 和 <a class="pgref" data-page="12">Page 12<\/a>/);
  assert.ok(html.includes("第 40 頁沒有"));  // 超出頁數：不連
  assert.match(html, /<a class="pgref" data-page="4" data-anchor="p3-2">（第 3 页）<\/a> 講過/);  // 段落代號：翻到它實際在的那一頁、帶著是哪一段
  assert.ok(!/<code[^>]*>[^<]*<a/.test(html));  // 程式碼裡的不動
  assert.match(html, /<a href="https:\/\/x\.y\/z"[^>]*>第 5 頁的圖<\/a>/);  // 連結的字裡面不再包一層
});
