// Pure display helpers for FundDetailSheet — period ordering, Thai→English
// performance-type labels, and the sheet's percentage formatters. Kept in lib
// (DB/network-free) so the component renders them and the unit tests import the
// SAME code, instead of re-implementing replicas that can't catch a regression.

// ─── performance type label map ───────────────────────────────────────────────
// Thai performance_type_desc → short English label.

const PERF_TYPE_LABELS: Record<string, string> = {
  ความผันผวนของกองทุนรวม: "Fund Volatility",
  ความผันผวนของดัชนีชี้วัด: "Benchmark Volatility",
  ผลการดำเนินงานของกองทุนรวม: "Fund Return",
  ผลการดำเนินงานของดัชนีชี้วัด: "Benchmark Return",
  ผลการดำเนินงานเฉลี่ยของกองทุนรวมในกลุ่ม: "Peer Avg Return",
  ความผันผวนเฉลี่ยของกองทุนรวมในกลุ่ม: "Peer Avg Volatility",
};

export function perfTypeLabel(raw: string): string {
  return PERF_TYPE_LABELS[raw] ?? raw;
}

// Period ordering — shorter periods first.
const PERIOD_ORDER: string[] = ["3M", "6M", "YTD", "1Y", "SI", "3Y", "5Y"];

export function periodSortKey(period: string): number {
  const idx = PERIOD_ORDER.indexOf(period.toUpperCase());
  return idx >= 0 ? idx : 99;
}

// Format a YYYYMM reporting period (stored as e.g. "202603" or "202603.0")
// as "2026/03". Strips any non-digits first so the API's trailing ".0" is gone.
export function formatYearMonth(period: string | null | undefined): string | null {
  if (!period) return null;
  const digits = period.replace(/\D/g, "");
  return digits.length >= 6 ? `${digits.slice(0, 4)}/${digits.slice(4, 6)}` : digits || null;
}

// ─── formatting helpers ───────────────────────────────────────────────────────

export function fmtPct(val: string | number | null | undefined, showSign = true): string {
  if (val == null) return "–";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (Number.isNaN(n)) return val as string;
  const sign = showSign && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtNavPct(val: number | null | undefined): string {
  if (val == null) return "–";
  return `${val.toFixed(2)}%`;
}
