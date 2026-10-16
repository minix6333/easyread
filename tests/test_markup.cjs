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

test("an unfinished figure block shows the drawing placeholder only while streaming; a stopped answer renders what it has", () => {
  const PR = markup();
  PR.vizHtml = (src) => "<viz>" + PR.esc(src.trim()) + "</viz>";
  const fence = "\x60\x60\x60";
  const half = "開頭一句。\n\n" + fence + "viz\n<div class=\"viz\"><h4>半張圖";
  const live = PR.mdBlocks(half, { live: true });
  assert.ok(live.includes("md-drawing") && live.includes("開頭一句") && !live.includes("半張圖"), "streaming: placeholder, no half-written source");
  const stopped = PR.mdBlocks(half + "\n\n（已停止）");
  assert.ok(!stopped.includes("md-drawing"), "a finished answer never keeps saying it is drawing");
  assert.ok(stopped.includes("md-viz") && stopped.includes("半張圖"));
  assert.ok(stopped.includes("（已停止）") && !/<viz>[^]*已停止[^]*<\/viz>/.test(stopped), "the stop note is not part of the figure");
  assert.ok(!PR.mdBlocks(half).includes("md-drawing"));
  const whole = "A\n\n" + fence + "viz\n<div class=\"viz\">好</div>\n" + fence + "\n\nB";
  assert.equal(PR.mdBlocks(whole, { live: true }), PR.mdBlocks(whole), "complete blocks render the same either way");
});

test("a pic block becomes a figure that asks for a Wikipedia picture; it never carries a URL from the answer", () => {
  const PR = markup();
  const fence = "\x60\x60\x60";
  assert.deepEqual({ ...PR.picParse("條目：Support vector machine\n找：maximum margin hyperplane\n說明：實線是決策邊界，\n兩條虛線之間就是 margin。") },
    { article: "Support vector machine", file: "", q: "maximum margin hyperplane", cap: "實線是決策邊界，兩條虛線之間就是 margin。" });
  assert.equal(PR.picParse("article: K-means clustering\nq: convergence\ncaption: one step").cap, "one step");
  assert.equal(PR.picParse("条目：Normal distribution\n说明：钟形曲线").article, "Normal distribution", "Simplified labels are accepted too");
  assert.equal(PR.picParse("Normal distribution\n鐘形曲線：中間最高。").article, "Normal distribution", "no labels: first line is the article");
  assert.equal(PR.picParse("檔名：`SVM margin.png`").file, "SVM margin.png");
  const html = PR.mdBlocks("前面。\n\n" + fence + "pic\n條目：Support vector machine\n找：margin\n說明：看 $w$ 的方向\n" + fence + "\n\n後面。");
  assert.match(html, /<figure class="md-pic" data-article="Support vector machine" data-file="" data-q="margin">/);
  assert.match(html, /<figcaption>看 <math>w<\/math> 的方向<\/figcaption>/);
  assert.ok(html.indexOf("前面") < html.indexOf("md-pic") && html.indexOf("md-pic") < html.indexOf("後面"));
  assert.ok(!/<img|https?:/.test(html), "the page asks the backend; nothing in the answer is loaded directly");
  const evil = PR.mdBlocks(fence + "pic\n條目：\"><img src=x onerror=alert(1)>\n說明：<script>x</script>\n" + fence);
  assert.ok(!/<img|<script/.test(evil), "what the model wrote is escaped");
  assert.equal(PR.mdBlocks(fence + "pic\n\n" + fence).trim(), "", "an empty block shows nothing");
  assert.ok(PR.mdBlocks("x\n\n" + fence + "pic\n條目：Sup", { live: true }).includes("md-drawing"), "half-written while streaming: placeholder");
  assert.ok(!PR.mdBlocks("![圖](https://example.com/a.png)").includes("<img"), "plain Markdown images with remote URLs are still not loaded");
  // 這張圖已經問回來了（webimg.js 記著）：重排時直接排進去，不用再等一次——回答還在寫的時候整段會重排很多次
  PR.picCached = (p) => (p.article === "Support vector machine" && p.q === "margin" ? { i: 1, slot: '<a class="pic-img"><img src="/webimg?u=x"></a>', src: "SVM margin · 維基共享資源" } : null);
  const again = PR.mdBlocks(fence + "pic\n條目：Support vector machine\n找：margin\n說明：看這裡\n" + fence + "\n\n" + fence + "pic\n條目：Kernel method\n" + fence);
  assert.match(again, /<figure class="md-pic ready" data-article="Support vector machine" data-file="" data-q="margin" data-asked="1" data-i="1"><div class="pic-slot"><a class="pic-img"><img src="\/webimg\?u=x"><\/a><\/div><figcaption>看這裡<\/figcaption><div class="pic-src">SVM margin · 維基共享資源<\/div><\/figure>/);
  assert.match(again, /<figure class="md-pic" data-article="Kernel method" data-file="" data-q=""><div class="pic-slot"><\/div><\/figure>/, "one that was not asked yet still waits");
});


test("notes saved by the WYSIWYG editor render the way they were written", () => {
  const P = markup();
  // 斜體貼著粗體時存成 _斜體_
  assert.equal(P.md("**粗_粗斜_**_斜_"), "<strong>粗<em>粗斜</em></strong><em>斜</em>");
  assert.equal(P.md("**_又粗又斜_**"), "<strong><em>又粗又斜</em></strong>");
  // snake_case、網址裡的底線不是斜體
  assert.ok(!P.md("my_file_name 和 [x](https://e.com/a_b_c)").includes("<em>"));
  // 跳脫的 1\. 和 \[x\](…) 照字面
  assert.equal(P.md("1\\. Introduction"), "1. Introduction");
  assert.ok(!P.md("見 \\[x\\](https://e.com)").includes("<a "));
  // 網址裡的括號編碼過
  assert.ok(P.md("[T](https://en.wikipedia.org/wiki/Transformer_%28deep_learning_architecture%29)").includes('href="https://en.wikipedia.org/wiki/Transformer_%28deep_learning_architecture%29"'));
});
