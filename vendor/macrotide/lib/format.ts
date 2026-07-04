// Number formatting helpers

export function fmtTHBClean(n: number, decimals = 0): string {
  const v = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(n));
  return `${n < 0 ? "-" : ""}฿${v}`;
}

/**
 * Format a percentage with a leading sign. Precision is ADAPTIVE by magnitude
 * unless the caller pins `decimals`: values under 1% keep 2dp (a 0.2% gain reads
 * as 0.24%, not a rounded 0.2%), 1–100% keep 1dp, and 100%+ drop to 0dp (no
 * false precision on a +240% return). One rule, applied everywhere, keeps the
 * app's percentages consistent without forcing a uniform digit count.
 */
export function fmtPct(n: number, decimals?: number): string {
  const abs = Math.abs(n);
  const d = decimals ?? (abs < 1 ? 2 : abs < 100 ? 1 : 0);
  return `${(n >= 0 ? "+" : "") + n.toFixed(d)}%`;
}

export function fmtNum(n: number, d = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(n);
}

/** ฿ gain/loss with an explicit sign — true minus (−), plus for gains. */
export function fmtTHBSigned(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtTHBClean(Math.abs(n))}`;
}

/** Return RATIO (0.034 → "+3.4%"), fixed 1dp. For percentage-point inputs use fmtPct. */
export function fmtRatioPct(r: number): string {
  return `${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)}%`;
}

/** Compact token counts for usage meters: 1234 → "1.2K", 2500000 → "2.5M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Calendar date "2026-06-05" (or any ISO string) → "Jun 5, 2026". Parses the
 * date part as UTC so a bare date never shifts a day in negative-offset
 * timezones. Returns the input back if it isn't ISO-shaped.
 */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const DAY_MS = 86_400_000;

export function fmtRelativeDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const days = Math.max(0, Math.floor((now.getTime() - then.getTime()) / DAY_MS));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "1 month ago";
  return `${Math.floor(days / 30)} months ago`;
}
