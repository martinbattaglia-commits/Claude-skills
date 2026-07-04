// Compare two Advisor eval result files (issue #67) so a before/after check is
// mechanical, not eyeballed. Given two `eval-results/*.json` files it reports,
// per (model, question): the score delta, which questions newly FAIL or got
// FIXED (pass^k flips), and a PAIRED McNemar significance test on the shared
// question set so a "winner" is only declared when the flips lean one way beyond
// chance (issue #66).
//
//   npm run eval:diff -- eval-results/<before>.json eval-results/<after>.json
//
// "before"/"after" = first arg is the baseline, second is the candidate; a
// positive delta means the candidate scored higher. Pure diff logic lives in
// `diffRuns` (token-free tested in tests/eval/diff.test.ts); this file adds the
// file I/O + formatting around it.

import { readFileSync } from "node:fs";
import { type McNemar, mcnemar } from "./stats";

export interface DiffRow {
  model: string;
  qid: string;
  tier: string;
  score: number;
  pass: boolean;
  ok: boolean;
  err: boolean;
}

export interface ResultFile {
  gitSha?: string | null;
  ranAt?: string;
  models?: string[];
  tier?: string;
  n?: number;
  reasoning?: string | null;
  shaping?: boolean;
  rows: DiffRow[];
}

interface Agg {
  model: string;
  qid: string;
  tier: string;
  avgScore: number;
  allPass: boolean; // pass^k: every run of this question passed
  dead: number;
  runs: number;
}

function aggregate(rows: DiffRow[]): Map<string, Agg> {
  const groups = new Map<string, DiffRow[]>();
  for (const r of rows) {
    const key = `${r.model}::${r.qid}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, Agg>();
  for (const [key, rs] of groups) {
    out.set(key, {
      model: rs[0].model,
      qid: rs[0].qid,
      tier: rs[0].tier,
      avgScore: rs.reduce((s, r) => s + r.score, 0) / rs.length,
      allPass: rs.every((r) => r.pass),
      dead: rs.filter((r) => !r.err && !r.ok).length,
      runs: rs.length,
    });
  }
  return out;
}

export interface DiffEntry {
  key: string;
  model: string;
  qid: string;
  tier: string;
  before: number;
  after: number;
  delta: number;
}

export interface DiffResult {
  /** Mean avgScore over the questions present in BOTH files (like-for-like). */
  beforeMean: number;
  afterMean: number;
  meanDelta: number;
  /** Shared questions whose score moved, by direction (largest move first). */
  regressions: DiffEntry[];
  improvements: DiffEntry[];
  /** pass^k flips on shared questions. */
  newFailures: DiffEntry[]; // were all-pass, now not
  newFixes: DiffEntry[]; // were failing, now all-pass
  /** Questions present in only one file (set changed between runs). */
  addedKeys: string[];
  removedKeys: string[];
  /** Paired test over shared questions' pass^k outcome. */
  mcnemar: McNemar;
}

const EPS = 1e-9;

/**
 * Pure diff of two parsed result files. Pairs questions by `model::qid`,
 * compares mean score and pass^k, and runs McNemar over the shared set.
 */
export function diffRuns(before: ResultFile, after: ResultFile): DiffResult {
  const a = aggregate(before.rows ?? []);
  const b = aggregate(after.rows ?? []);
  const shared = [...a.keys()].filter((k) => b.has(k));

  const regressions: DiffEntry[] = [];
  const improvements: DiffEntry[] = [];
  const newFailures: DiffEntry[] = [];
  const newFixes: DiffEntry[] = [];
  const pairs: Array<[boolean, boolean]> = [];

  for (const key of shared) {
    const av = a.get(key) as Agg;
    const bv = b.get(key) as Agg;
    const delta = bv.avgScore - av.avgScore;
    const entry: DiffEntry = {
      key,
      model: av.model,
      qid: av.qid,
      tier: av.tier,
      before: av.avgScore,
      after: bv.avgScore,
      delta,
    };
    if (delta < -EPS) regressions.push(entry);
    else if (delta > EPS) improvements.push(entry);
    if (av.allPass && !bv.allPass) newFailures.push(entry);
    else if (!av.allPass && bv.allPass) newFixes.push(entry);
    pairs.push([av.allPass, bv.allPass]);
  }

  regressions.sort((x, y) => x.delta - y.delta); // most negative first
  improvements.sort((x, y) => y.delta - x.delta); // most positive first

  const mean = (keys: string[], m: Map<string, Agg>) =>
    keys.length ? keys.reduce((s, k) => s + (m.get(k) as Agg).avgScore, 0) / keys.length : 0;
  const beforeMean = mean(shared, a);
  const afterMean = mean(shared, b);

  return {
    beforeMean,
    afterMean,
    meanDelta: afterMean - beforeMean,
    regressions,
    improvements,
    newFailures,
    newFixes,
    addedKeys: [...b.keys()].filter((k) => !a.has(k)),
    removedKeys: [...a.keys()].filter((k) => !b.has(k)),
    mcnemar: mcnemar(pairs),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function load(path: string): ResultFile {
  return JSON.parse(readFileSync(path, "utf8")) as ResultFile;
}

function pctDelta(d: number): string {
  const sign = d > 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(0)}pp`;
}

function header(label: string, f: ResultFile): string {
  return (
    `${label}: ${f.rows?.length ?? 0} runs · ${(f.models ?? []).join(",") || "?"}` +
    ` · tier=${f.tier ?? "?"} reasoning=${f.reasoning ?? "default"}` +
    `${f.shaping ? " shaping=on" : ""} · sha=${f.gitSha ?? "?"}`
  );
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("usage: npm run eval:diff -- <before.json> <after.json>");
    process.exit(1);
  }
  const before = load(beforePath);
  const after = load(afterPath);
  const d = diffRuns(before, after);

  console.log("═══ EVAL DIFF (before → after) ═══");
  console.log(`  ${header("before", before)}`);
  console.log(`  ${header("after ", after)}\n`);

  console.log(
    `quality (shared questions): ${(d.beforeMean * 100).toFixed(0)}% → ` +
      `${(d.afterMean * 100).toFixed(0)}%  (${pctDelta(d.meanDelta)})`,
  );
  const m = d.mcnemar;
  console.log(
    `pass^k flips: ${d.newFixes.length} fixed, ${d.newFailures.length} newly failing  ` +
      `· McNemar b=${m.b} c=${m.c} p=${m.pValue.toFixed(3)}` +
      `${m.pValue < 0.05 ? " (significant)" : " (not significant)"}`,
  );

  const list = (title: string, entries: DiffEntry[]) => {
    if (!entries.length) return;
    console.log(`\n${title}`);
    for (const e of entries) {
      console.log(
        `  ${e.qid.padEnd(20)} ${e.model.padEnd(34)} ` +
          `${(e.before * 100).toFixed(0)}%→${(e.after * 100).toFixed(0)}% (${pctDelta(e.delta)})`,
      );
    }
  };
  list("✗ newly failing (was pass^k, now not):", d.newFailures);
  list("✓ fixed (now pass^k):", d.newFixes);
  list("↓ regressions (score down):", d.regressions);
  list("↑ improvements (score up):", d.improvements);

  if (d.addedKeys.length || d.removedKeys.length) {
    console.log(
      `\nset changed: +${d.addedKeys.length} question(s) only in after, ` +
        `−${d.removedKeys.length} only in before (not compared)`,
    );
  }
}

// Run only as a CLI, not when imported by the test.
if (process.argv[1]?.endsWith("diff.ts")) main();
