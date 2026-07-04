// Position projection — pure, deterministic, DB- and network-free.
//
// Turns a bucket's ledger events into the derived `holdings` rows the whole app
// reads (see ADR 0004: the ledger is the source of truth; holdings is a
// projection of it). This module owns ONLY the position math + identity fields
// derivable from the ledger (ticker, quoteSource, englishName, source, units,
// avgCost). Instrument METADATA that has no home in the ledger (thaiName,
// category, assetClass, region, ter, color) is preserved by the query layer,
// which merges it onto these rows before writing. Keep the DB I/O out of here.
//
// Currency note: avgCost is THB cost basis per unit (the ledger's signed THB
// `amount` is the authoritative money field). For THB-denominated funds — the
// overwhelming majority here — this equals the historical native avg cost. A
// directly-held foreign ticker carries the same native-vs-THB display nuance the
// snapshot adapter already had; the analytics path (transaction-analytics) does
// the proper FX conversion.

import { type CostBasisMethod, foldTickerCase, type LedgerTxn, reduceLots } from "./lots";

/** The ledger fields the projection reads to build a holding row. */
export interface ProjectionEvent extends LedgerTxn {
  quoteSource?: string | null;
  englishName?: string | null;
  source?: string | null;
}

/** A derived position — the ledger-owned subset of a `holdings` row. */
export interface ProjectedPosition {
  ticker: string;
  quoteSource: string;
  englishName: string | null;
  source: string | null;
  units: number;
  /** THB cost basis per unit, or null when the cost is unknown (graceful degradation). */
  avgCost: number | null;
  /** False when the position is held but its cost basis is unknown. */
  costKnown: boolean;
  /** Earliest event date for the ticker (ISO), for `holdings.acquiredOn`. */
  acquiredOn: string | null;
}

const DEFAULT_QUOTE_SOURCE = "market";

/**
 * Project a bucket's ledger events into derived positions (one row per held
 * ticker, units > 0). Identity fields take the most-recent non-empty value the
 * ledger carries for that ticker; the position math comes from {@link reduceLots}.
 */
export function projectPositions(
  events: readonly ProjectionEvent[],
  method: CostBasisMethod = "average",
): ProjectedPosition[] {
  // Collapse case-variant tickers to one display case first (#235), so the
  // identity pass keys line up with reduceLots's (which folds case internally).
  const folded = foldTickerCase(events);
  const lots = reduceLots(folded, method);

  // Identity + earliest-date pass, in chronological order so "latest non-empty"
  // is simply last-write-wins.
  const identity = new Map<
    string,
    { quoteSource: string; englishName: string | null; source: string | null; acquiredOn: string }
  >();
  const ordered = [...folded].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );
  for (const e of ordered) {
    const prev = identity.get(e.ticker);
    identity.set(e.ticker, {
      quoteSource: e.quoteSource || prev?.quoteSource || DEFAULT_QUOTE_SOURCE,
      englishName: e.englishName || prev?.englishName || null,
      source: e.source || prev?.source || null,
      acquiredOn: prev?.acquiredOn ?? e.tradeDate,
    });
  }

  return lots.positions
    .filter((p) => p.units > 0)
    .map((p) => {
      const id = identity.get(p.ticker);
      return {
        ticker: p.ticker,
        quoteSource: id?.quoteSource ?? DEFAULT_QUOTE_SOURCE,
        englishName: id?.englishName ?? null,
        source: id?.source ?? null,
        units: p.units,
        avgCost: p.avgCost,
        costKnown: p.avgCost !== null,
        acquiredOn: id?.acquiredOn ?? null,
      };
    });
}
