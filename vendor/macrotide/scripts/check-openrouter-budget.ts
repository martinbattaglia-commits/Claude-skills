// Early-warning probe for OpenRouter ACCOUNT spend (issue #183).
//
// Reads the account key's live monthly limit + remaining from OpenRouter's
// `GET /api/v1/key`, classifies how close spend is to the cap, and signals the
// result — primarily by notifying an optional heartbeat, with the exit code as a
// fallback — for a server-side monitor to consume.
//
// Design — single source of truth, no local state:
//   The cap lives ONLY in the OpenRouter dashboard (the key's monthly limit).
//   This probe READS it live — it never re-declares the number, so nothing can
//   drift. Monthly usage only climbs until the calendar-month reset, so crossing
//   a threshold is a one-way trip within the month: no state file, no snapshot,
//   no manual reset, and it can't flap.
//
// Two independent spend guards, kept distinct:
//   - per-USER daily token/cents cap (lib/db/queries/usage.ts) — bounds one user.
//   - per-KEY account guard (THIS probe) — bounds total account spend before the
//     403 that would break ALL chat.
//
// Usage:
//   npm run jobs:check-budget [-- [--warn-pct=N] [--crit-pct=N]]
//
// Alerting — primary path is the heartbeat, exit code is the fallback:
//   • When OPENROUTER_BUDGET_HEARTBEAT_URL is set, the probe self-notifies via the
//     heartbeat and exits 0. It POSTs a one-line summary to the URL's /fail
//     sub-path on warn AND critical (distinct messages), and GETs the base URL (a
//     liveness ping) only on healthy/warn. So warn both /fails and pings → a
//     self-resolving recurring nudge; critical /fails but does NOT ping → a
//     sustained, escalatable incident until spend recovers.
//   • When NO heartbeat URL is set, the probe can't self-notify, so a CRITICAL
//     reading exits 10 (the only non-zero exit) to drive the server-side OnFailure
//     alert path. Warn / healthy / indeterminate always exit 0.
// The /key read is retried on a transient hiccup (network / timeout / 5xx); a 4xx
// (bad key) fails fast. If it's still unreadable the run is `indeterminate`: it
// neither /fails nor pings, so a one-off is absorbed by the monitor's grace while
// a SUSTAINED unreadable API (or a crashed probe) stops the heartbeat and the
// dead-man surfaces it. Size the monitor's grace to ≥ ~1.5× the run cadence so a
// single non-pinging run is tolerated but two-plus in a row fire. A bug here must
// never masquerade as a budget breach — any internal probe error exits 0.
//
// Loads .env.local via tsx's --env-file flag (configured in package.json). On the
// box it runs via scripts/run-job.sh against the same key the app uses.

import { fileURLToPath } from "node:url";

const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

// Generic best-practice defaults — NOT account-specific. The dollar cap is read
// from OpenRouter, never hard-coded here; only these percentages have defaults,
// overridable per-environment via flags on the job unit.
export const DEFAULT_WARN_PCT = 80;
export const DEFAULT_CRIT_PCT = 95;

/** Non-zero exit reserved for a critical (act-now) budget alert. */
export const CRITICAL_EXIT_CODE = 10;

export interface CliArgs {
  warnPct: number;
  critPct: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let warnPct = DEFAULT_WARN_PCT;
  let critPct = DEFAULT_CRIT_PCT;
  for (const arg of argv) {
    const warn = arg.match(/^--warn-pct=(\d+(?:\.\d+)?)$/);
    if (warn) {
      const n = Number.parseFloat(warn[1]);
      if (n > 0 && n <= 100) warnPct = n;
      continue;
    }
    const crit = arg.match(/^--crit-pct=(\d+(?:\.\d+)?)$/);
    if (crit) {
      const n = Number.parseFloat(crit[1]);
      if (n > 0 && n <= 100) critPct = n;
    }
  }
  return { warnPct, critPct };
}

/** The two fields the verdict depends on, normalized to number | null. */
export interface KeyUsage {
  limit: number | null;
  limitRemaining: number | null;
}

export type BudgetStatus = "healthy" | "warn" | "critical" | "indeterminate";

/**
 * Percent of the monthly limit consumed: `(limit - remaining) / limit * 100`.
 * Pure. Returns null when the limit isn't a usable positive number (no key limit
 * set, or a malformed/absent field) — the caller fails OPEN on null. Can exceed
 * 100 when the key is already over its limit (negative `remaining`).
 */
export function pctUsed(usage: KeyUsage): number | null {
  const { limit, limitRemaining } = usage;
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  if (limitRemaining === null || !Number.isFinite(limitRemaining)) return null;
  return ((limit - limitRemaining) / limit) * 100;
}

/**
 * Classify spend against the key's monthly limit. Pure. `indeterminate` (→ the
 * caller exits 0) when the limit can't be read, so a missing limit or a bad field
 * is never a false "critical". Boundaries are inclusive (`>=`).
 */
export function classify(usage: KeyUsage, warnPct: number, critPct: number): BudgetStatus {
  const pct = pctUsed(usage);
  if (pct === null) return "indeterminate";
  if (pct >= critPct) return "critical";
  if (pct >= warnPct) return "warn";
  return "healthy";
}

/**
 * Map a status to its process exit code. The exit code is only the FALLBACK alert
 * signal: when a heartbeat URL is configured the probe self-notifies via the
 * heartbeat `/fail` (see main), so it exits 0 and the exit code carries nothing.
 * Only when NO heartbeat URL is set does a critical reading exit non-zero, so the
 * server-side `OnFailure` path can still raise the alert. Never non-zero for
 * warn / healthy / indeterminate (fail open).
 */
export function exitCodeFor(status: BudgetStatus, hasAlertUrl: boolean): number {
  return status === "critical" && !hasAlertUrl ? CRITICAL_EXIT_CODE : 0;
}

const money = (v: number | null): string => (v === null ? "n/a" : `$${v.toFixed(2)}`);

/**
 * One-line human summary for a warn/critical heartbeat `/fail` body, e.g.
 * `"warn: OpenRouter spend 82.0% — $16.40/$20.00"`. Pure — safe to unit-test.
 */
export function alertMessage(status: BudgetStatus, usage: KeyUsage): string {
  const pct = pctUsed(usage);
  const pctStr = pct === null ? "n/a" : `${pct.toFixed(1)}%`;
  const used =
    usage.limit !== null && usage.limitRemaining !== null
      ? usage.limit - usage.limitRemaining
      : null;
  return `${status}: OpenRouter spend ${pctStr} — ${money(used)}/${money(usage.limit)}`;
}

/** Shape of the bits of `GET /api/v1/key` we read (everything else ignored). */
interface KeyResponse {
  data?: {
    limit?: number | null;
    limit_remaining?: number | null;
    usage_monthly?: number | null;
    label?: string | null;
  };
}

interface KeyReading {
  usage: KeyUsage;
  usageMonthly: number | null;
  label: string | null;
}

/** Attempts for the `/key` read. A transient hiccup (network / timeout / 5xx) is
 *  retried so it doesn't masquerade as a sustained outage; a 4xx is not. */
const MAX_FETCH_ATTEMPTS = 3;
/** Backoff before attempts 2 and 3 (ms). Short — this is an hourly job. */
const RETRY_BACKOFF_MS = [500, 1500];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A non-retryable read failure — a 4xx (bad/revoked key, bad request) that a
 *  retry can't fix. Marked so the retry loop fails fast on it. */
class NonRetryableKeyError extends Error {}

async function fetchKeyOnce(apiKey: string): Promise<KeyReading> {
  const res = await fetch(KEY_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.PUBLIC_APP_URL ?? "https://macrotide.local",
      "X-Title": "Macrotide",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status >= 400 && res.status < 500) {
    // Client error (bad/revoked key, bad request) — won't recover from a retry.
    throw new NonRetryableKeyError(`OpenRouter /key returned HTTP ${res.status}`);
  }
  if (!res.ok) {
    // 5xx or other non-OK — transient server-side; let the caller retry.
    throw new Error(`OpenRouter /key returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as KeyResponse;
  const d = json.data ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    usage: { limit: num(d.limit), limitRemaining: num(d.limit_remaining) },
    usageMonthly: num(d.usage_monthly),
    label: typeof d.label === "string" ? d.label : null,
  };
}

/** Read `/key`, retrying TRANSIENT failures (network / timeout / 5xx) so a
 *  momentary hiccup doesn't masquerade as a sustained outage. A 4xx fails fast.
 *  Throws the last error if every attempt fails — the caller treats that as
 *  `indeterminate`. */
async function fetchKeyReading(apiKey: string): Promise<KeyReading> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchKeyOnce(apiKey);
    } catch (err) {
      if (err instanceof NonRetryableKeyError) throw err;
      lastErr = err;
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1500);
    }
  }
  throw lastErr;
}

/** POST a one-line failure message to the heartbeat's `/fail` sub-path (the
 *  standard dead-man convention — same one scripts/heartbeat.sh uses). */
async function postFail(url: string, message: string): Promise<void> {
  await fetch(`${url}/fail`, {
    method: "POST",
    body: message,
    signal: AbortSignal.timeout(10_000),
  });
}

/** GET the heartbeat base URL — the dead-man liveness ping. No-ops if the URL is
 *  unset; a ping failure never changes the budget verdict. */
async function pingLiveness(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
  } catch {
    // A heartbeat-ping failure must not change the budget verdict.
  }
}

async function main(): Promise<void> {
  const { warnPct, critPct } = parseArgs(process.argv.slice(2));
  const heartbeatUrl = process.env.OPENROUTER_BUDGET_HEARTBEAT_URL;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Fail OPEN — a missing key is a config gap, not a budget breach: log + exit 0,
    // never page directly. DON'T ping: a one-off is absorbed by the monitor's
    // grace, but a persistently missing key stops the heartbeat and the dead-man
    // surfaces it ("budget monitoring degraded").
    console.log("budget: indeterminate (OPENROUTER_API_KEY unset) — exit 0");
    return;
  }

  let reading: KeyReading;
  try {
    reading = await fetchKeyReading(apiKey);
  } catch (err) {
    // Every retry failed → the API is unreadable right now. NOT a budget breach,
    // so exit 0 and never page on it directly. DON'T ping either: a one-off is
    // absorbed by the monitor's grace, but a SUSTAINED unreadable API stops the
    // heartbeat and the dead-man surfaces it.
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`budget: indeterminate (could not read OpenRouter /key: ${msg}) — exit 0`);
    return;
  }

  const status = classify(reading.usage, warnPct, critPct);
  const pct = pctUsed(reading.usage);
  const pctStr = pct === null ? "n/a" : `${pct.toFixed(1)}%`;
  const labelStr = reading.label ? ` key=${reading.label}` : "";

  // One greppable summary line, logged regardless of verdict.
  const line =
    `budget: ${status}${labelStr} used=${pctStr} limit=${money(reading.usage.limit)} ` +
    `remaining=${money(reading.usage.limitRemaining)} usage_monthly=${money(reading.usageMonthly)} ` +
    `(warn=${warnPct}% crit=${critPct}%)`;

  if (status === "critical") {
    console.error(line);
  } else if (status === "warn") {
    console.warn(line);
  } else {
    console.log(line);
    if (status === "indeterminate" && reading.usage.limit === null) {
      console.log(
        "budget: no monthly limit set on this key — set one in the OpenRouter " +
          "dashboard for this probe to track spend.",
      );
    }
  }

  // Budget heartbeat — alerting + dead-man liveness, gated by status:
  //   • warn/critical → POST a one-line spend summary to the heartbeat's /fail
  //     sub-path (opens a budget incident).
  //   • healthy/warn → GET the base URL (liveness ping). So WARN both /fails and
  //     pings → its incident self-resolves → a recurring nudge. CRITICAL /fails
  //     but does NOT ping → its incident stays open → a sustained, escalatable
  //     alert until spend recovers.
  //   • critical + indeterminate withhold the ping on purpose: a sustained
  //     over-budget-but-crashed probe, or a sustained unreadable API, then
  //     surfaces via the dead-man (missing pings). Size the monitor's grace to
  //     ≥ ~1.5× the run cadence so a single non-pinging run is absorbed but two
  //     or more in a row fire.
  if (heartbeatUrl && (status === "warn" || status === "critical")) {
    try {
      await postFail(heartbeatUrl, alertMessage(status, reading.usage));
    } catch {
      // A failed alert POST must not change the budget verdict.
    }
  }
  if (status === "healthy" || status === "warn") await pingLiveness(heartbeatUrl);

  process.exit(exitCodeFor(status, Boolean(heartbeatUrl)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    // Exit 0 on an unexpected crash: a bug here must never masquerade as a budget
    // breach (false page). The dead-man monitor catches a silent probe.
    console.error("budget: probe error —", err instanceof Error ? err.message : String(err));
  });
}
