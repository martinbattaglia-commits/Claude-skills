// Pure helpers for the holding "view details" fallback — used when a held
// position isn't a fund in the SEC catalog (a stock, index, or cash position),
// so there's no enrichment to show. We render the holding's own stored data
// instead. Kept DB/network-free so it can be unit-tested in isolation.

import type { AssetClass, Holding } from "@/lib/static/types";

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity: "Equity",
  bond: "Bond",
  mixed: "Mixed",
  alternative: "Alternative",
  cash: "Cash",
  unknown: "Unclassified",
};

/** Human label for an asset class, falling back to the raw value. */
export function assetClassLabel(cls: string): string {
  return ASSET_CLASS_LABELS[cls as AssetClass] ?? cls;
}

export interface HoldingDetailRow {
  label: string;
  /** Pre-formatted display value, or null when the holding has no value here. */
  value: string | null;
}

/**
 * Build the labelled rows shown in the holding-detail fallback view. Pure:
 * formats numbers/percentages but reads nothing outside the holding. Rows whose
 * value is absent are still returned (value: null) so the caller can render an
 * em dash consistently.
 */
export function buildHoldingDetailRows(h: Holding): HoldingDetailRow[] {
  // Cost unknown (an uncosted opening/snapshot — ADR 0004): show a quiet nudge
  // instead of a bogus ฿0 avg cost, so gains stay honestly hidden until set.
  const costUnknown = h.costKnown === false;
  const avgCost = h.units > 0 ? h.cost / h.units : null;
  return [
    { label: "Name", value: h.name || h.ticker },
    { label: "Asset class", value: assetClassLabel(h.class) },
    { label: "Region", value: h.region || null },
    { label: "Category", value: h.category || null },
    {
      label: "Units",
      value: Number.isFinite(h.units) ? h.units.toLocaleString("en-US") : null,
    },
    {
      label: "Market value",
      value: `฿${Math.round(h.value).toLocaleString("en-US")}`,
    },
    {
      label: "Avg cost",
      value: costUnknown
        ? "Not set — add to see gains & return"
        : avgCost != null
          ? `฿${avgCost.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
          : null,
    },
    { label: "TER", value: h.ter != null ? `${h.ter.toFixed(2)}%` : null },
    { label: "Source", value: h.source || null },
  ];
}
