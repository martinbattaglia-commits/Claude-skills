-- #134: re-key the NAV/quote cache to the canonical `${source}:${TICKER}` form.
--
-- Writers used the catalog's NATIVE ticker case while the value-ledger fold looks
-- the key up UPPER-cased, so lowercase-cataloged funds (e.g. the ttb SSF/RMF
-- family) wrote keys the fold could never find — their value-only Balances never
-- derived units and silently dropped from holdings. Every key is now built
-- through quoteCacheKey() (upper-cased ticker, source left as-is); this brings the
-- existing rows to the same form so they're visible immediately rather than
-- waiting for the nightly re-crawl to overwrite them.
--
-- Only the ticker portion (after the first ':') is upper-cased — the source is a
-- fixed lowercase taxonomy value. `updated_at` is intentionally NOT touched, so
-- the 24h freshness TTL still holds and the re-key triggers no cold-cache refetch
-- stampede against the tight provider quotas (FMP 250/day, EODHD 20/day).
-- `OR REPLACE` guards the (theoretical) case where both casings already exist:
-- the stale duplicate is dropped rather than aborting the migration. market.db is
-- regenerable, so dropping a duplicate cache row is safe.
UPDATE OR REPLACE `fund_quotes`
SET `ticker` = substr(`ticker`, 1, instr(`ticker`, ':')) || upper(substr(`ticker`, instr(`ticker`, ':') + 1))
WHERE instr(`ticker`, ':') > 0
  AND substr(`ticker`, instr(`ticker`, ':') + 1) <> upper(substr(`ticker`, instr(`ticker`, ':') + 1));
--> statement-breakpoint
UPDATE OR REPLACE `nav_history`
SET `ticker` = substr(`ticker`, 1, instr(`ticker`, ':')) || upper(substr(`ticker`, instr(`ticker`, ':') + 1))
WHERE instr(`ticker`, ':') > 0
  AND substr(`ticker`, instr(`ticker`, ':') + 1) <> upper(substr(`ticker`, instr(`ticker`, ':') + 1));
