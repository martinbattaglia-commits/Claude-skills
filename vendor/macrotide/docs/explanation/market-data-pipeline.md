# Market data pipeline

*Last updated: 2026-06-26*

How market data gets into `market.db` and stays fresh — the **Thai fund catalog
crawl** (SEC reference data), the **US securities catalog** (Nasdaq directory +
FIGI identity), and the shared **NAV/quote series cache** (prices over time), the
jobs that drive them, and the limits that bound them. This is the mental model for
anyone touching classification, instrument metadata, or historical price/return
charts.

It's an *understanding* doc: it links out to where each fact actually lives
rather than copying it, so the numbers don't drift. The authoritative homes —

- **Provider chain + free-tier quotas + cache-TTL rationale** →
  [auth-and-providers.md § Market data providers](../reference/auth-and-providers.md#market-data-providers-indices--fx--stocks)
  and [§ Cache freshness](../reference/auth-and-providers.md#cache-freshness).
- **Job roster + schedules (UTC) + crawl sizing** →
  [deploy.md § Scheduled jobs](../how-to/deploy.md#scheduled-jobs-systemd-timers).
- **Why market.db is split from app.db, and the two-clock cache** →
  [architecture.md](./architecture.md).
- **Why systemd timers, not in-process cron** →
  [decisions log § Picks](./decisions/README.md#picks) ("Background job
  scheduling").

## Two kinds of flow, one database

`market.db` is fed by **catalog** flows (what instruments exist + what they are)
and one shared **series cache** (how a price moved over time). They share a
database and a nightly cadence but nothing else — different sources, tables, shapes.

```text
                         ┌─────────────────────────────────────────────┐
  Thai SEC Open Data ───▶│  Thai catalog crawl (ELT)                    │
  (mutual-fund API)      │  sec_raw  ──transform──▶  fund_catalog,       │
                         │  (verbatim)               fees, share_classes │
                         └─────────────────────────────────────────────┘
  Nasdaq directory  ────▶┌─────────────────────────────────────────────┐
  (nasdaqtraded.txt)     │  US catalog (parse → upsert) + FIGI identity │
  OpenFIGI (ticker→FIGI) │  us_securities (symbol, figi, popularity…)   │
                         └─────────────────────────────────────────────┘
                         ┌─────────────────────────────────────────────┐
  SEC NAV / TwelveData / │  series cache (write-through, SHARED)        │
  Alpaca / Frankfurter / │  getCachedSeries() ──▶ nav_history,           │
  Yahoo                  │                        fund_quotes            │
                         └─────────────────────────────────────────────┘
```

1. **Thai catalog crawl — *what funds exist and what they are.*** The fund
   universe, fees/TER, AUM, asset-class/risk classification, share classes. Thai
   SEC mutual-fund API only.
2. **US securities catalog — *what's US-listed and its stable identity.*** The
   US stock/ETF universe, exchange, popularity, and the rename-persistent FIGI.
   Nasdaq directory + OpenFIGI.
3. **Series cache — *how a price moved over time.*** Daily NAV (funds), index/FX/
   commodity levels and US stock/ETF closes (`market` symbols), plus the latest
   quote per series. Multi-provider; shared by Thai and US.

Keep them straight: a classification or wrong-name bug is a **catalog** problem; a
short or stale chart is a **series-cache** problem.

## Pipeline 1 — the fund catalog (ELT)

The crawl is **ELT, not ETL**: it lands verbatim SEC payloads in `sec_raw`,
then a separate transform derives the catalog columns.

- `jobs:refresh-catalog` (`refresh-fund-catalog.ts`) — the nightly crawl. Lands
  raw → transforms → `fund_catalog` + fees + AUM. ~10,000–15,000 SEC calls,
  ~15–30 min at the 5,000-calls/300s budget.
- `jobs:transform-catalog` (`transform-catalog.ts`) — re-derive the catalog from
  *already-landed* `sec_raw`. **API-free, runs in seconds, needs no SEC key.**

Why this matters: changing a derived field (a new asset-class rule, a fee fix)
is a **seconds-long transform re-run**, not an 80-minute re-crawl, and endpoints
we don't read yet are still captured in `sec_raw` for later. Asset class /
money-market detection is driven by the SEC `risk-spectrum` RS-code, not
fund-name matching. The catalog of landable endpoints/fields lives in the
[SEC spec repo](https://github.com/Sitthinut/sec-open-data-api-spec).

`jobs:refresh-share-classes` runs after the catalog (FK dependency) to populate
the priceable share-class tickers the series cache keys on.

## The US securities catalog (+ FIGI identity)

US stocks & ETFs get their own flat catalog (`us_securities`) — they have no AIMC
peer group, tax wrapper, or share-class structure, so they don't fit the Thai
`fund_catalog`. Fed by two nightly jobs; both are bounded and **non-destructive**
(a delisted symbol is kept, never deleted).

- `jobs:refresh-us-securities` (`refresh-us-securities.ts`) — fetch the official,
  keyless **Nasdaq Trader directory** (`nasdaqtraded.txt`: one flat file, ~12.9k
  symbols with name / exchange / ETF flag), parse → upsert. A `seen_at`
  run-marker flips any symbol the latest directory dropped to `delisted` (kept for
  held history); a returning symbol re-lists. One file, not 20 endpoints — so no
  `sec_raw`-style raw landing.
- **FIGI identity (same job).** Each run also enriches a bounded batch of
  still-unmapped symbols with their **composite FIGI** from OpenFIGI — the
  rename-persistent, openly-licensed (MIT) security id. A held US holding anchors
  on it (`holdings.catalog_figi`), so a ticker rename (FB→META) resolves to the
  current symbol/name at read while the ledger keeps the old code — the US
  analogue of the Thai ISIN/`(proj_id, class_name)` anchor (#235). A delisted
  symbol whose FIGI now belongs to an active one IS a rename: the job bridges the
  NAV cache old→new (`repointUsNav`). OpenFIGI works keyless; `OPENFIGI_API_KEY`
  (free) just makes the backfill faster.
- `jobs:refresh-popular` (`refresh-popular.ts`) — keeps the *popular* US set warm
  so its chart opens instantly. The set is **derived, not hardcoded**: Alpaca's
  most-actives screener → ranked by dollar volume (leveraged/inverse name-filtered)
  → blended with a per-symbol demand counter (real detail opens) → top-N warmed
  nightly, stale scores decayed.

US **prices** ride the shared series cache below (not a US store): a held US
ticker prices through `market:${symbol}` via the Twelve Data → Alpaca → Yahoo
chain. Held US holdings + the demand/popular set warm through it; there is
deliberately **no whole-US-catalog NAV prewarm** (12.9k symbols would blow the
free quotas and bloat the append-only `nav_history`).

## Pipeline 2 — the NAV/quote series cache

Every price series flows through **`getCachedSeries(source, ticker, range)`**
([lib/market/cache.ts](../../lib/market/cache.ts)) — the single read/write-
through path shared by fund-detail charts, the screener, the portfolio
value/return chart, and the prewarm job. Its behaviour:

- **24h freshness TTL** (`CACHE_TTL_MS`). A symbol refetches at most once a day.
  The window is set by **provider quotas, not how often prices move** — FMP
  ~250/day, EODHD ~20/day, and keyless Yahoo 429s from datacenter IPs, so a
  shorter TTL would blow the quotas. (See the linked § Cache freshness for the
  full rationale; this is load-bearing — don't shorten the TTL without a
  higher-quota provider.)
- **Depth-aware.** Each key records the deepest range fetched
  (`fund_quotes.deepest_range`). A request *wider* than what's stored (e.g.
  "All" on a fund only ever pulled at 6mo) falls through to a refetch and
  deepens the series, even while the quote is still fresh.
- **Provider fallback** per the chain in auth-and-providers — keyed real-index
  source first, keyless fallback next — so one upstream's outage doesn't blank a
  symbol. A failed upstream is negatively cached for 3 min (`FAIL_BACKOFF_MS`)
  and the last good value is served stale rather than blanked.

### Invariant: `nav_history` is upsert-only, never time-pruned

Writes upsert on `(ticker, date)`. A refetch fetches a *window* and corrects
those days in place; older rows outside the window stay. **Never add a
time-based retention sweep or a delete-then-replace** — that destroys history
the depth-aware path worked to accumulate. AUM (`net_asset`) rides in the same
SEC NAV row, so it costs no extra fetch.

### Freshness vs coverage — two jobs, kept distinct

The cache is filled lazily on first open, plus two background jobs that exist
for **different reasons** (don't merge them):

| Job | Reason | Scope |
|---|---|---|
| `jobs:refresh-market` | **Freshness** | NAV for *held* positions + tracked indicators only. Small daily timer. |
| `jobs:prewarm-nav` | **Coverage** | NAV/AUM for *every registered fund* (~2,300), at `range: "max"`. Heavy one-off backfill + optional daily append. |

Prewarm is why the screener's return/size columns and a cold fund-detail open
read deep history instantly instead of paying an ~8s cold fetch. It reuses `getCachedSeries`, so re-runs are cheap (fresh+deep keys serve
from cache) and the daily append uses `range: "1mo"` while keeping prior depth.

## Coverage limits — what is and isn't deep

Knowing the *gaps* matters as much as the mechanics, especially for anything
touching the portfolio "All" chart:

- **Thai mutual funds → deep.** `prewarm-nav` warms the whole registered
  universe to **SEC's depth cap of ~5.4 years** (~1,310 daily points; this is
  the SEC daily-NAV floor, not fund inception). For funds, ~5.4y is effectively
  the ceiling without another source.
- **Held non-fund positions → deep, proactively.** A `market`-sourced holding
  (a foreign ETF, gold, an index held as a position) has no coverage job of its
  own (prewarm is Thai-fund-only), so the **freshness** job (`refresh-market`)
  warms *held* `market` refs to `max` — distinct from indicators and held funds,
  which stay shallow. The portfolio "All" chart is then deep on first open with
  no cold on-demand backfill, bounded only by that provider's free-tier history.
  This doesn't breach the freshness/coverage boundary: the boundary is *scope*
  (never enumerate the catalog), not depth — held refs are still only what's
  tracked.
- **US stocks & ETFs → held + popular deep, long tail lazy.** Held US positions
  warm to `max` via `refresh-market` (they're `market`-sourced) like any held
  non-fund ref; the *popular* set (most-traded + demanded) is warmed nightly by
  `refresh-popular` so a common chart opens instantly; the ~12.9k-symbol long tail
  fills lazily on first open (one ~1–2s cold fetch, then cached). There is no
  whole-US-catalog prewarm — the free quotas and the append-only `nav_history`
  rule it out.
- **ETF holdings + "held via" → widen over nights, not instant.** An ETF's SEC
  N-PORT constituents — and the reverse "which ETFs hold this stock" list plus the
  derived asset-class / exposure-region it powers — come from a bounded nightly
  holdings pass (`refresh-etf-holdings`, most-popular ETFs first, advancing through
  the catalog on successive runs); a cold ETF also JIT-fills its own holdings on
  first detail open. So a popular stock's held-via lands within a night or two, but
  a stock held *only* by ETFs not yet ingested shows none until coverage reaches
  them — there's no per-stock on-demand fetch (the reverse index is a byproduct of
  ingesting ETFs forward, then resolving each constituent's CUSIP/ISIN→ticker via
  `resolve-etf-tickers`; see the data model).
- **FX rides the held-NAV warm.** THB↔USD conversion history comes from Frankfurter
  (keyless, ECB-backed, deep to 1999), so it never bottlenecks a blended "All" chart.
  The `refresh-market` freshness job warms each held foreign currency's `=X` series to
  `max` alongside the held NAV — so a foreign holding's baht chart and its trade-date
  cost-basis conversion are a cache hit on first open (not a cold FX fetch), and a
  Frankfurter blip serves the last-good rate instead of dropping the holding. A USD
  position needs only USD→THB (`THB=X`); a non-USD currency adds its USD cross series.
- **Benchmark comparison → deep, total-return.** Comparing the portfolio against
  an index needs a purpose-built **total-return** series, not the display-only
  price indices above: a price index would understate the benchmark and flatter
  the dividend-reinvesting portfolio line. A small curated set of tracking-ETF
  proxies (global / US / developed-ex-US / EM, plus a Thai proxy) is warmed under
  the dedicated **`benchmark_tr`** source as dividend-reinvested **adjusted
  close** (Twelve Data `adjust=all`, ~20y deep) by `jobs:prewarm-benchmark`, so a
  comparison overlay can render like-for-like across the full "All" range. The
  source is deliberately not a holdable `quote_source` — it only namespaces the
  cache rows (`benchmark_tr:ACWI`) and routes the adjusted provider.

The demo is exempt from this gap: it ships a self-contained committed history
fixture and never depends on the crawl. A real account must never be shown
synthetic data as its own returns.

## Where to look

| You're changing… | Start in |
|---|---|
| Fund classification / fees / metadata | the transform (`transform-catalog.ts`), then re-run `jobs:transform-catalog` |
| The US securities catalog / FIGI identity / ticker renames | `refresh-us-securities.ts`, [lib/market/figi.ts](../../lib/market/figi.ts), `lib/db/queries/us-securities.ts` |
| The instant-popular US warm set | `refresh-popular.ts`, [lib/market/screener.ts](../../lib/market/screener.ts) |
| A new SEC field not yet landed | the crawl's `sec_raw` landing (`refresh-fund-catalog.ts`) |
| Price-series freshness, depth, or fallback | [lib/market/cache.ts](../../lib/market/cache.ts) |
| Provider chain / a new market provider | [lib/market/providers/](../../lib/market/providers), then [auth-and-providers.md](../reference/auth-and-providers.md#market-data-providers-indices--fx--stocks) |
| Coverage backfill (NAV history depth) | `jobs:prewarm-nav` (`prewarm-nav.ts`); held non-fund positions self-heal on demand — [#141](https://github.com/Sitthinut/macrotide/issues/141) |
| Benchmark comparison series (total-return) | not built — [#81](https://github.com/Sitthinut/macrotide/issues/81) |
| Job schedules / one-shot containers | [deploy.md § Scheduled jobs](../how-to/deploy.md#scheduled-jobs-systemd-timers) |
