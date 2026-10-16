const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// peek.js 的純函式：參考文獻那一筆怎麼收、標題怎麼抓、對不對得到文獻庫、連結是什麼、要截哪一塊
function load() {
  const PR = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    state: { paper: { meta: {} } }, pid: "me", store: { mode: "server" },
    api: () => Promise.resolve({ pages: {} }), on() {}, $: () => null, icon: () => "", esc: (s) => String(s),
  };
  const doc = { body: { classList: { contains: () => false } }, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/peek.js"), "utf8"),
    { window: { PR }, document: doc, requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {}, getSelection: () => "" });
  return PR;
}
const L = (t, x0, y0, x1, y1) => ({ t, x0, y0, x1, y1, h: y1 - y0, items: [] });

test("a hanging-indent reference entry stops at the next entry", () => {
  const PR = load();
  const lines = [
    L("References", 0.17, 0.08, 0.3, 0.095),
    L("Aravind Gollakota, Parikshit Gopalan. Loss prediction: Evaluating loss pre-", 0.176, 0.095, 0.82, 0.106),
    L("dictors for learning. arXiv:2502.20375, 2025.", 0.193, 0.109, 0.7, 0.12),
    L("Daya Guo, Dejian Yang, Haowei Zhang, et al. Deepseek-r1: Incentivizing reasoning capability", 0.176, 0.148, 0.82, 0.159),
    L("in LLMs via reinforcement learning. arXiv preprint arXiv:2501.12948, 2025. 1, 3", 0.193, 0.162, 0.82, 0.173),
    L("WKeith Hastings. Monte carlo sampling methods. 5", 0.176, 0.202, 0.82, 0.213),
  ];
  const text = PR.peekRefEntry(lines, { to: 13, y: 0.1433, x: 0.1358 });
  assert.match(text, /^Daya Guo/);
  assert.match(text, /arXiv:2501\.12948, 2025\. 1, 3$/);
  assert.doesNotMatch(text, /Hastings/);
  // 第一筆：跳過標題那一行；行尾斷字接回來
  assert.equal(PR.peekRefEntry(lines, { to: 13, y: 0.09, x: 0.1358 }), "Aravind Gollakota, Parikshit Gopalan. Loss prediction: Evaluating loss predictors for learning. arXiv:2502.20375, 2025.");
});

test("a numbered entry is found even when the anchor sits above the previous entry's last line", () => {
  const PR = load();
  const lines = [
    L("on Computer Vision and Pattern Recognition (CVPR), pages", 0.551, 0.497, 0.904, 0.511),
    L("3208–3218, 2023. 1, 3", 0.551, 0.511, 0.684, 0.524),
    L("[25] Shervin Minaee, Tomas Mikolov, Narjes Nikzad, Meysam", 0.518, 0.525, 0.904, 0.539),
    L("Chenaghlu, Richard Socher. Large language models: A survey, 2024.", 0.551, 0.539, 0.904, 0.553),
    L("[26] OpenAI. Gpt-4 technical report, 2023.", 0.518, 0.556, 0.904, 0.57),
  ];
  const text = PR.peekRefEntry(lines, { to: 9, y: 0.5218, x: 0.5184 });
  assert.match(text, /^\[25\] Shervin Minaee/);
  assert.match(text, /A survey, 2024\.$/);
});

test("title, arXiv id and DOI come out of a reference entry", () => {
  const PR = load();
  const a = PR.peekRefInfo("Daya Guo, Dejian Yang, Haowei Zhang, et al. Deepseek-r1: Incentivizing reasoning capability in LLMs via reinforcement learning. arXiv preprint arXiv:2501.12948, 2025. 1, 3");
  assert.equal(a.title, "Deepseek-r1: Incentivizing reasoning capability in LLMs via reinforcement learning");
  assert.equal(a.arxiv, "2501.12948");
  const b = PR.peekRefInfo("[7] Smith, J., Doe, A. (2020). Learning to read papers. Nature, 581, 12–19. doi:10.1038/s41586-020-1234-5.");
  assert.equal(b.title, "Learning to read papers");
  assert.equal(b.doi, "10.1038/s41586-020-1234-5");
});

test("a reference matches a library paper by arXiv id or by title, never the open paper itself", () => {
  const PR = load();
  const items = [
    { id: "me", title_en: "Finetuning with Sampling: SFT Learns Better Than You Think" },
    { id: "r1", title_en: "DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning", arxiv: "" },
    { id: "ax", title_en: "Something else", arxiv: "arXiv:2310.06825v2" },
  ];
  const entry = "Daya Guo, et al. Deepseek-r1: Incentivizing reasoning capability in LLMs via reinforcement learning. arXiv preprint, 2025.";
  assert.equal(PR.peekLibMatch(items, entry).id, "r1");
  assert.equal(PR.peekLibMatch(items, "Albert Q. Jiang. Mistral 7b. arXiv:2310.06825, 2023.").id, "ax");
  assert.equal(PR.peekLibMatch(items, "Aayush Karan. Finetuning with sampling: SFT learns better than you think. 2026."), null);
});

test("link kinds come from the word before the link, then from where it lands", () => {
  const PR = load();
  const d = { refs: { page: 12, y: 0.43 }, appx: { page: 15, y: 0.09 } };
  const k = (l, inside, before) => PR.peekKind(l, { inside, before }, d);
  assert.equal(k({ to: 10, y: 0.4 }, "3", "as shown in Figure "), "figure");
  assert.equal(k({ to: 9, y: 0.1 }, "1", "results in Table "), "table");
  assert.equal(k({ to: 7, y: 0.1 }, "1", "described in Algorithm "), "algorithm");
  assert.equal(k({ to: 5, y: 0.6 }, "5", "we can rewrite ("), "equation");
  assert.equal(k({ to: 4, y: 0.5 }, "4.1", "see Section "), "section");
  assert.equal(k({ to: 13, y: 0.14 }, "Guo et al.", "language models (LLMs) ["), "ref");
  assert.equal(k({ to: 16, y: 0.3 }, "B", "details in "), "spot");  // 附錄裡：不是參考文獻
  assert.equal(k({ u: "https://x.org" }, "", ""), "url");
  assert.equal(k({ to: 3, y: 0.2, m: "figure 3" }, "Figure 3", ""), "figure");
});

test("a figure peek spans from the figure's top to the end of its caption", () => {
  const PR = load();
  const lines = [
    L("Dataset likelihoods. We can directly observe the effect projection sampling has on expert traces.", 0.176, 0.43, 0.82, 0.441),
    L("Chemistry", 0.3, 0.47, 0.36, 0.48), L("Math", 0.62, 0.47, 0.66, 0.48),
    L("0.0 0.5 1.0", 0.2, 0.68, 0.5, 0.69),
    L("Figure 3: Dataset likelihoods for projection sampling. We plot likelihoods of the boosted", 0.176, 0.71, 0.82, 0.72),
    L("dataset traces for both tasks under their corresponding base models.", 0.176, 0.722, 0.82, 0.732),
    L("Figure 3 plots histograms of the sequence log-likelihoods under the base model of both traces.", 0.176, 0.741, 0.82, 0.752),
    L("of both the expert traces and the boosted traces for both science and math reasoning tasks here.", 0.176, 0.754, 0.82, 0.765),
  ];
  // 錨點在圖的頂端（hypcap）
  const a = PR.peekRegion(lines, { to: 10, y: 0.4454 }, "figure", "3");
  assert.ok(a[1] >= 0.441 && a[1] < 0.45, "top " + a[1]);
  assert.ok(a[3] > 0.732 && a[3] < 0.741, "bottom " + a[3]);
  // 錨點在題注：圖在上面，從上面那一行內文的下面開始
  const b = PR.peekRegion(lines, { to: 10, y: 0.709 }, "figure", "3");
  assert.ok(b[1] > 0.441 && b[1] < 0.45, "top " + b[1]);
  // 只說跳到哪一頁：整頁
  assert.deepEqual(Array.from(PR.peekRegion(lines, { to: 10 }, "spot", "")), [0, 0, 1, 1]);
});
