/* 間隔重複的排程（FSRS-4.5，Anki 現在用的那一套的公式和預設參數）：每張卡記穩定度 s（天）、難度 d（1–10），
   每次複習按「再一次／困難／良好／簡單」算出下一次什麼時候看。目標記得的機率 90%：這時下一次的間隔剛好就是 s 天。
   - 新卡：再一次 → 一分鐘後在這一輪再看一次；困難／良好／簡單 → 1／4／14 天左右（w1、w2、w3）。
   - 複習過的：答對照記得的程度把 s 拉長；忘了 → s 變短，十分鐘後在這一輪再看一次。
   卡片的 srs：{due, s, d, reps, lapses, last, state}（存在 cards.json，cards.py 只存不算）。 */
(function (PR) {
  "use strict";
  const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
  const DECAY = -0.5, FACTOR = 19 / 81, RETAIN = 0.9, MAX_DAYS = 36500, DAY = 86400000;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const d0 = (g) => clamp(W[4] - (g - 3) * W[5], 1, 10);
  const recall = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
  const interval = (s) => clamp(Math.round(s / FACTOR * (Math.pow(RETAIN, 1 / DECAY) - 1)), 1, MAX_DAYS);
  const nextD = (d, g) => clamp(W[7] * d0(3) + (1 - W[7]) * (d - W[6] * (g - 3)), 1, 10);  // FSRS-4.5：難度往 D0(3)＝w4 回歸（FSRS-5 才是 D0(4)，參數也不同）
  const sRecall = (d, s, r, g) => s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
  const sForget = (d, s, r) => Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
  const iso = (ms) => new Date(ms).toISOString();

  /* grade：1 再一次、2 困難、3 良好、4 簡單；now：毫秒 */
  function next(srs, grade, now) {
    now = now == null ? Date.now() : now;
    const g = clamp(Math.round(grade), 1, 4);
    if (!srs || !srs.last || !(srs.s > 0)) {  // 新卡（或還在第一次學的）
      const s = W[g - 1], d = d0(g);
      if (g === 1) return { due: iso(now + 60000), s, d, reps: (srs && srs.reps || 0) + 1, lapses: srs && srs.lapses || 0, last: iso(now), state: "learning" };
      return { due: iso(now + interval(s) * DAY), s, d, reps: (srs && srs.reps || 0) + 1, lapses: srs && srs.lapses || 0, last: iso(now), state: "review" };
    }
    const t = Math.max(0, (now - Date.parse(srs.last)) / DAY), r = recall(t, srs.s), d = nextD(srs.d || d0(3), g);
    if (g === 1) {
      const s = Math.max(0.1, sForget(srs.d || d0(3), srs.s, r));
      return { due: iso(now + 600000), s, d, reps: (srs.reps || 0) + 1, lapses: (srs.lapses || 0) + 1, last: iso(now), state: "relearning" };
    }
    const s = clamp(sRecall(srs.d || d0(3), srs.s, r, g), 0.1, MAX_DAYS);
    return { due: iso(now + interval(s) * DAY), s, d, reps: (srs.reps || 0) + 1, lapses: srs.lapses || 0, last: iso(now), state: "review" };
  }
  const isDue = (srs, now) => !srs || !srs.due || Date.parse(srs.due) <= (now == null ? Date.now() : now);
  /* 按鈕上寫的「1 分鐘」「4 天」：按下去之後多久再看到 */
  function span(ms) {
    const m = ms / 60000;
    if (m < 60) return PR.t("{n} 分鐘", { n: Math.max(1, Math.round(m)) });
    const h = m / 60;
    if (h < 22) return PR.t("{n} 小時", { n: Math.round(h) });  // 快一天的（排的是一天、時間已經過了一點）就說 1 天
    const dd = Math.max(1, h / 24);
    if (dd < 30) return PR.t("{n} 天", { n: Math.round(dd) });
    if (dd < 365) return PR.t("{n} 個月", { n: Math.round(dd / 30) });
    return PR.t("{n} 年", { n: Math.round(dd / 365 * 10) / 10 });
  }
  function preview(srs, now) {
    now = now == null ? Date.now() : now;
    return [1, 2, 3, 4].map((g) => span(Date.parse(next(srs, g, now).due) - now));
  }
  /* 卡片清單上的「到期」「3 天後」 */
  function when(srs, now) {
    now = now == null ? Date.now() : now;
    if (!srs || !srs.due) return PR.t("新卡");
    const left = Date.parse(srs.due) - now;
    return left <= 0 ? PR.t("到期") : PR.t("{span}後", { span: span(left) });
  }
  PR.srs = { next, isDue, preview, when, span, W };
})(window.PR);
