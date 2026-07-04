// Pure share-class selection helpers — no DB/network, safe to unit-test and to
// import on either side. A fund (parent) has one or more priceable share
// classes; these pick a sensible default when the caller didn't specify one.

export interface ClassLike {
  ticker: string;
  className: string;
  investorType: string | null;
  distributionPolicy: string | null;
}

/** A class plus its latest AUM (net_asset), for popularity-ranked list ordering. */
export interface RankableClass extends ClassLike {
  /** Latest cached fund size (THB). Null when not yet warmed. */
  aum?: number | null;
}

/**
 * Order the share classes of ONE fund for the screener list (decision: most
 * popular first, with a deterministic fallback). The tiers, in order:
 *
 *  1. **audience tier** — explicit retail first, then unknown (likely retail —
 *     differs only by distribution/channel), then `restricted` (provident /
 *     private / special-group) and any other non-retail. A provident-only class
 *     never outranks a retail one. (institutional/insurance are hidden from the
 *     browse list upstream, so they surface here only via search.)
 *  2. **AUM (net_asset) descending** — the genuinely-popular class first. This is
 *     a no-op when AUM is missing (not yet warmed) OR identical across siblings
 *     (i.e. if the SEC reports net_asset per-fund rather than per-class), so the
 *     next tiers govern and the ordering stays sensible regardless.
 *  3. **flagship heuristic** — the class whose ticker is the parent abbr (usually
 *     the primary/oldest), then an accumulating class.
 *  4. **ticker** — stable, deterministic final tiebreak.
 *
 * Exact-query-match hoisting is handled by the caller (it spans the whole result
 * set, not one family), so this comparator does not see the query.
 */
export function compareClassesForList<T extends RankableClass>(
  abbr?: string | null,
): (a: T, b: T) => number {
  // Lower tier = shown higher: explicit retail → unknown (likely retail) →
  // restricted / other non-retail.
  const audienceTier = (c: T) => (c.investorType === "retail" ? 0 : c.investorType == null ? 1 : 2);
  const abbrRank = (c: T) => (abbr && c.ticker === abbr ? 0 : 1);
  const accRank = (c: T) => (c.distributionPolicy === "accumulating" ? 0 : 1);
  return (a, b) => {
    if (audienceTier(a) !== audienceTier(b)) return audienceTier(a) - audienceTier(b);
    const aa = a.aum ?? null;
    const ba = b.aum ?? null;
    if (aa !== ba) {
      if (aa == null) return 1; // nulls last
      if (ba == null) return -1;
      if (aa !== ba) return ba - aa; // larger AUM first
    }
    if (abbrRank(a) !== abbrRank(b)) return abbrRank(a) - abbrRank(b);
    if (accRank(a) !== accRank(b)) return accRank(a) - accRank(b);
    return a.ticker.localeCompare(b.ticker);
  };
}

/**
 * The default class to show when none is specified (decision D6). Per-class AUM
 * isn't pre-cached, so we approximate "flagship" with a retail-first heuristic:
 * prefer retail classes, then the one whose ticker is the parent abbr (usually
 * the primary/oldest class), then an accumulating class, else the first. Callers
 * that DO know the intended class (a click from the screener/search) pass it
 * directly and skip this.
 */
export function pickDefaultClass<T extends ClassLike>(
  classes: T[],
  abbr?: string | null,
): T | undefined {
  if (classes.length === 0) return undefined;
  const retail = classes.filter((c) => c.investorType === "retail");
  const pool = retail.length > 0 ? retail : classes;
  return (
    (abbr ? pool.find((c) => c.ticker === abbr) : undefined) ??
    pool.find((c) => c.distributionPolicy === "accumulating") ??
    pool[0]
  );
}
