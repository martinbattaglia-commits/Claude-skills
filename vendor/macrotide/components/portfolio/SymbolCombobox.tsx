"use client";

// SymbolCombobox — the fund/ticker autocomplete, composed from the shared
// Combobox. The user's own holdings surface first, then live priceable SHARE
// CLASSES from the central catalog (GET /api/fund-classes, ≥2 chars), each tagged
// "· YOURS" / "· ACC" / "· DIV" so sibling classes are distinguishable. There is NO
// static seed: the catalog is the single authority for what exists and how it's
// priced. The in-input price-source badge (Fund ⇄ Custom) rides along.

import { useEffect, useMemo, useState } from "react";
import { Combobox } from "@/components/ui/Combobox";
import { filterKnownTickers, type TickerSuggestion } from "@/lib/data/known-holdings";
import type { ShareClassListItem } from "@/lib/db/queries/funds";
import type { UsSecurity } from "@/lib/db/queries/us-securities";
import { useResource } from "@/lib/fetchers/swr";
import type { QuoteSource } from "@/lib/market/sources";
import { cleanUsSecurityName } from "@/lib/market/us-security-name";

// Short labels for the in-input price-source badge — the asset class, not the
// provider. "Fund" reads clearer than "TH" for a Thai mutual fund. `market` covers
// both US stocks and ETFs, so its badge resolves to "Stock"/"ETF" from the matched
// security (below); "US" is the fallback before that resolves.
const TYPE_BADGE_CODES: Record<QuoteSource, string> = {
  thai_mutual_fund: "Fund",
  market: "US",
  manual: "Custom",
  cash: "Cash",
};

// One dropdown row — a holdings suggestion, a live Thai catalog class, or a US
// stock/ETF. `distributionPolicy` is Thai-only (Acc/Div tag); `securityType` US-only.
interface SymbolSuggestion {
  ticker: string;
  name: string;
  quoteSource: QuoteSource;
  fromHoldings?: boolean;
  distributionPolicy?: string | null;
  securityType?: "stock" | "etf";
}

export interface SymbolPick {
  ticker: string;
  name?: string;
  quoteSource: QuoteSource;
}

export interface SymbolComboboxProps {
  value: string;
  /** Explicit per-row source (a user toggle); when set, the badge reads "overridden". */
  quoteSource?: QuoteSource;
  /** Marks `quoteSource` as a deliberate choice (badge highlight) vs. an inference. */
  sourceLocked?: boolean;
  /** Local suggestion pool — the user's own holdings (live catalog merged in below). */
  pool: TickerSuggestion[];
  onChange: (ticker: string) => void;
  onPick: (s: SymbolPick) => void;
  /** Flip the price source (Thai fund ⇄ Stock / ETF). */
  onToggleSource: () => void;
  openUp?: boolean;
}

export function SymbolCombobox({
  value,
  quoteSource,
  sourceLocked,
  pool,
  onChange,
  onPick,
  onToggleSource,
  openUp,
}: SymbolComboboxProps) {
  // Debounce the query so the filter + catalog fetch don't refire on every key.
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 120);
    return () => clearTimeout(t);
  }, [value]);
  const query = debounced.trim();

  const local = useMemo(() => (query ? filterKnownTickers(pool, query) : []), [pool, query]);

  // Live catalog autocomplete — real priceable share classes, ≥2 chars only.
  const { data: catalog } = useResource<{ items: ShareClassListItem[]; total: number }>(
    query.length >= 2 ? `/api/fund-classes?query=${encodeURIComponent(query)}&limit=8` : null,
  );

  // US stocks & ETFs — so a US ticker (AAPL, QQQ, GOOG) is discoverable in the same
  // dropdown, priced through the market chain rather than falling through to custom.
  const { data: usCatalog } = useResource<{ items: UsSecurity[]; total: number }>(
    query.length >= 2 ? `/api/us-securities?query=${encodeURIComponent(query)}&limit=6` : null,
  );

  // Merge local + catalog, deduped by ticker (local wins so the "YOURS" tag holds).
  const items = useMemo<SymbolSuggestion[]>(() => {
    const seen = new Set<string>();
    const out: SymbolSuggestion[] = [];
    for (const s of local) {
      const key = s.ticker.trim().toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticker: s.ticker,
        name: s.name,
        quoteSource: s.quote_source,
        fromHoldings: s.fromHoldings,
      });
    }
    for (const c of catalog?.items ?? []) {
      const key = c.ticker.trim().toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticker: c.ticker,
        name: c.englishName ?? c.thaiName ?? c.abbrName ?? c.ticker,
        quoteSource: "thai_mutual_fund",
        distributionPolicy: c.distributionPolicy,
      });
    }
    for (const u of usCatalog?.items ?? []) {
      const key = u.symbol.trim().toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticker: u.symbol,
        name: cleanUsSecurityName(u.name),
        quoteSource: "market",
        securityType: u.securityType,
      });
    }
    return out;
  }, [local, catalog, usCatalog]);

  // Unknown until the catalog resolver confirms it — custom by default, no shape guess.
  const effective = quoteSource ?? "manual";
  const hasTicker = value.trim().length > 0;
  // A `market` badge resolves to the actual type (Stock/ETF) of the matched US
  // security; "US" until the lookup lands.
  const usType = useMemo(() => {
    const v = value.trim().toUpperCase();
    return (usCatalog?.items ?? []).find((u) => u.symbol.toUpperCase() === v)?.securityType;
  }, [usCatalog, value]);
  const badgeCode =
    effective === "market"
      ? usType === "etf"
        ? "ETF"
        : usType === "stock"
          ? "Stock"
          : TYPE_BADGE_CODES.market
      : TYPE_BADGE_CODES[effective];

  return (
    <Combobox<SymbolSuggestion>
      value={value}
      onChange={onChange}
      onPick={(s) => onPick({ ticker: s.ticker, name: s.name, quoteSource: s.quoteSource })}
      items={items}
      getKey={(s) => `${s.quoteSource}:${s.ticker}`}
      label="Symbol"
      placeholder="Symbol"
      openUp={openUp}
      trailing={
        hasTicker ? (
          <>
            <span className="field-fade" aria-hidden="true" />
            <button
              type="button"
              className="type-badge"
              data-overridden={Boolean(sourceLocked)}
              title="Price source — tap to switch (Thai fund ⇄ Stock / ETF)"
              // Keep the input focused so the dropdown doesn't close on the tap.
              onMouseDown={(e) => e.preventDefault()}
              onClick={onToggleSource}
            >
              {badgeCode}
            </button>
          </>
        ) : undefined
      }
      renderItem={(s) => (
        <>
          <div className="combobox__option-ticker">
            {s.ticker}
            {s.fromHoldings && (
              <span className="combobox__option-tag" data-tone="muted">
                · YOURS
              </span>
            )}
            {s.distributionPolicy === "accumulating" && (
              <span className="combobox__option-tag" data-tone="accent">
                · ACC
              </span>
            )}
            {s.distributionPolicy === "dividend" && (
              <span className="combobox__option-tag" data-tone="accent">
                · DIV
              </span>
            )}
            {s.securityType === "etf" && (
              <span className="combobox__option-tag" data-tone="accent">
                · ETF
              </span>
            )}
            {s.securityType === "stock" && (
              <span className="combobox__option-tag" data-tone="muted">
                · STOCK
              </span>
            )}
          </div>
          <div className="combobox__option-name">{s.name}</div>
        </>
      )}
    />
  );
}
