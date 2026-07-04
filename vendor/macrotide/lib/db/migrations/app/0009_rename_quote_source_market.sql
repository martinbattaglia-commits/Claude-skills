-- Rename the `quote_source` value "yahoo" → "market".
-- The value names the ASSET CLASS (stocks / ETFs / indices / FX), not the
-- provider: that bucket is served by a chain (FMP → EODHD → Twelve Data →
-- Frankfurter → Yahoo-fallback), so "yahoo" mislabelled the class by one of its
-- providers. Forward-only data rename for both ledger sources of truth; the new
-- code default is "market" (lib/market/sources.ts, lib/db/schema/app.ts).
UPDATE holdings SET quote_source = 'market' WHERE quote_source = 'yahoo';--> statement-breakpoint
UPDATE transactions SET quote_source = 'market' WHERE quote_source = 'yahoo';
