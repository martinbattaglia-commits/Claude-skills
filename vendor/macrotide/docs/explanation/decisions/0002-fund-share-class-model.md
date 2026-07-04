# ADR 0002 — Fund share-class model: parent catalog + per-class child table

**Status:** Accepted.

## The mismatch

A Thai mutual fund is *browsed* as one thing (a strategy — "MoneyDIVA Fund"), but
*held and priced* as a specific **share class** (`MDIVA-A`, `MDIVA-D`, `MDIVA-IA`,
…). The classes of one fund differ in ways the app cares about: each has its own
**NAV series**, **fees (TER)**, **distribution policy** (accumulating vs dividend),
**tax wrapper** (SSF/RMF/ThaiESG), and **investor audience** (retail vs
institutional vs insurance-linked).

The catalog, though, was **parent-level**: one `fund_catalog` row per SEC
`proj_id`, keyed by the parent abbreviation. NAV (`nav_history` / `fund_quotes`)
and holdings were already **per class** (the cache key is `${source}:${ticker}`),
but nothing connected the two. Two bugs fell out of that gap:

- **The fund-detail chart was empty for multi-class funds.** Opening "MDIVA" from
  Explore asked the SEC provider for a bare parent code; it has no NAV of its own,
  so `resolveSymbol` threw *"parent fund with multiple share classes"* and the
  chart showed nothing. Single-class funds (`1DIV`) worked by luck.
- **A latent portfolio bug:** the fund finder indexed parent abbreviations, so
  picking "MDIVA" and adding it created a holding with a parent ticker that has no
  resolvable NAV — a position that silently never priced.

So the real question wasn't "how do we chart NAV" — it was **how to represent
share classes** so the screener, the detail view, holdings, and pricing all agree.

## The options

- **A — parent-only (status quo).** No class data. ✗ NAV undefined for multi-class
  funds; chart empty; parent-coded holdings never price; fees/tax imprecise.
- **B — classes as catalog rows.** Make `fund_catalog` one row per (fund × class);
  the screener lists classes directly. ✓ Every entry is priceable. ✗ Browse becomes
  noisy (near-duplicate `-A/-D/-IA` rows), users don't think in classes, and the
  parent-level enrichment (performance, allocation, top-holdings, feeder
  look-through — all keyed by `proj_id`) has to fan out or be duplicated.
- **C — parent + class child-list.** Keep `fund_catalog` parent-level for browse
  and enrichment; add a **`fund_share_classes`** child table (one row per
  priceable class). Browse by parent; price/hold/chart by class.

## Decision

**C.** The catalog stays the parent/browse/enrichment unit; `fund_share_classes`
holds the priceable units. Enrichment stays naturally parent-level; class-specific
facts (distribution, tax, ISIN, investor type, TER) live on the child rows.

The load-bearing rule: **a holding/chart references a *priceable unit*, never a
bare parent.** The priceable id is the child's **`ticker`**:

- the **share-class code** for multi-class funds (`MDIVA-A`), or
- the **parent abbreviation** for single-class funds, whose SEC `fund_class_name`
  is the non-unique literal `"main"` (so `"1DIV"`, not `"main"`).

`ticker` is globally `UNIQUE`, equals `holdings.ticker`, and is the
`${source}:${ticker}` NAV cache-key tail. The table PK is the composite
`(proj_id, class_name)` because `"main"` repeats across every single-class fund.

### Per-surface calls

These follow from C and were settled alongside it:

- **D2 — the Explore screener lists priceable *classes*, not parents.** Rationale:
  tax-saving classes (RMF/SSF) differ per class and we have a tax filter, and a
  searcher should see every real, buyable choice. Institutional/insurance classes
  are hidden by default (they have NAV but individuals can't subscribe — feeds the
  retail-availability work).
- **D3 — the fund detail opens on the class the user clicked** (from list or
  search), with a class picker to switch siblings. A deep-link with no class
  context falls back to **D6 — the flagship default** (retail-first, then
  accumulating; `pickDefaultClass`). Per-class AUM isn't pre-cached, so "flagship"
  is a heuristic, not a true largest-by-AUM pick.
- **D4 — add/import validates the ticker is a priceable class** and blocks bare
  parents ("pick one of …"), surfacing the resolver's existing message at
  add-time instead of failing later as a no-price holding.
- **D5 — no migration of existing holdings.** Pre-release, test data only.
- **D7 — fees and distribution policy are per class** (`fund_fees` was already
  keyed by `fund_class_name`).

## Consequences & the rules that follow

- **`fund_share_classes` populates from the *same* SEC enumeration as the catalog
  crawl** (`general-info/profiles` returns one row per class; the catalog crawl
  de-dupes them away by `proj_id`). A dedicated `jobs:refresh-share-classes` reads
  the same pages de-duped per class — **zero extra API calls.** Runs after the
  catalog crawl (FK dependency on `fund_catalog`).
- **Browse parent, act per class** is the durable invariant. Anything that needs
  NAV/fees/tax — the chart, a holding, the screener row — keys on the class
  `ticker`. Parent is purely a catalog/browse concept; you can't transact it.
- **Returns warm lazily.** A class's 1-year return / deep history fills in when its
  series is fetched (a detail open fetches 1y); the broad pre-warm of the whole
  registered universe is deferred — see board issue for the all-funds NAV/AUM
  crawler, which rides the scheduler issue.
- **Enrichment keys stay `proj_id`.** Don't move performance/allocation/
  top-holdings/feeder data to the class grain; it's a fund-level fact.
- **This ADR is the definition of "model C"** referenced in the shipping work and
  commit history.

## Updates

The decision above stands; these note where reality has moved since it was
written. (New decisions live in the [Picks table](./README.md#picks), not here.)

- **2026-06 — per-class AUM is now cached.** The deferred all-funds NAV/AUM
  pre-warm (above) shipped: a daily job warms NAV/AUM across the registered
  universe. So per-class AUM *is* pre-cached and now drives the screener's size
  tie-break and within-family order — the D6 "flagship isn't a largest-by-AUM
  pick" caveat applies only to the fund-detail default (`pickDefaultClass`), which
  deliberately stays a retail/accumulating heuristic.
- **2026-06 — screener ordering settled.** Browse ranks each class by its *own*
  TER (cheapest first; ties by fund size, then retail before restricted); search
  ranks by name relevance with the exact-ticker match floated first. Recorded in
  Picks → "Explore screener ordering"; the fund-level `current_ter` it reads
  follows the representative retail class, not a fee-waived sibling.
