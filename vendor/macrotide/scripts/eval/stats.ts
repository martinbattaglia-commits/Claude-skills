// Small, dependency-free statistics for the Advisor eval (issue #66). Two jobs:
//
//   - ci95(values): a 95% confidence interval on a mean, so every reported
//     quality number carries its uncertainty instead of pretending n runs are
//     the truth. With small n a single mean conflates model variance with
//     capability; the interval shows when "88% vs 78%" is actually noise.
//   - mcnemar(pairs): a PAIRED significance test on the SHARED question set —
//     the right test when the same questions are graded under two conditions
//     (before/after a change, or model A vs B). It looks only at the questions
//     where the two disagree, so an A/B declares a winner only when the
//     disagreements lean one way beyond chance.
//
// Pure functions over plain numbers/booleans — unit-tested token-free in
// tests/eval/stats.test.ts.

export interface Interval {
  mean: number;
  /** Half-width of the 95% interval (1.96·SE). NaN when n < 2. */
  margin: number;
  lo: number;
  hi: number;
  n: number;
}

/**
 * 95% confidence interval on the mean of `values` (normal approximation,
 * sample standard deviation). Returns margin = NaN and lo = hi = mean when
 * there are fewer than two values (no spread to estimate). Bounds are NOT
 * clamped — a proportion's interval can spill past [0,1]; clamp at display.
 */
export function ci95(values: number[]): Interval {
  const n = values.length;
  const mean = n ? values.reduce((s, v) => s + v, 0) / n : 0;
  if (n < 2) return { mean, margin: Number.NaN, lo: mean, hi: mean, n };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance) / Math.sqrt(n);
  const margin = 1.96 * se;
  return { mean, margin, lo: mean - margin, hi: mean + margin, n };
}

export interface McNemar {
  /** Discordant where A passed and B failed. */
  b: number;
  /** Discordant where A failed and B passed. */
  c: number;
  /** Discordant total (b + c) — the only pairs the test uses. */
  discordant: number;
  /** Two-sided exact (binomial) p-value. 1 when there are no discordant pairs. */
  pValue: number;
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * Exact two-sided McNemar test on paired pass/fail outcomes. Each pair is
 * [aPass, bPass] for the SAME question under the two conditions. Only the
 * discordant pairs (one passed, the other failed) carry signal; under the null
 * those split 50/50, so the two-sided p-value is the exact binomial tail. Use
 * the exact form (not the chi-square approximation) because an eval's question
 * set is small, where the approximation is unreliable.
 */
export function mcnemar(pairs: Array<[boolean, boolean]>): McNemar {
  let b = 0;
  let c = 0;
  for (const [a, d] of pairs) {
    if (a && !d) b++;
    else if (!a && d) c++;
  }
  const discordant = b + c;
  if (discordant === 0) return { b, c, discordant, pValue: 1 };
  const lo = Math.min(b, c);
  let tail = 0;
  for (let k = 0; k <= lo; k++) tail += binom(discordant, k) * 0.5 ** discordant;
  const pValue = Math.min(1, 2 * tail);
  return { b, c, discordant, pValue };
}

/** Conventional 5% significance helper. */
export function isSignificant(p: number, alpha = 0.05): boolean {
  return p < alpha;
}
