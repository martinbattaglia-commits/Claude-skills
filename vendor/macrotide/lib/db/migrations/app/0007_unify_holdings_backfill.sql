-- ADR 0004 — make the ledger the source of truth for positions.
-- Backfill an `opening` anchor for every existing snapshot holding so `holdings`
-- becomes a projection of the ledger. Only buckets with NO ledger yet are
-- touched (a bucket already carrying transactions keeps its ledger as-is). A
-- holding with no avg_cost becomes an UNCOSTED opening (cost unknown; gains
-- degrade gracefully — amount 0 so it is not a phantom cash flow).
INSERT INTO transactions (
  bucket_id, ticker, english_name, quote_source, kind, trade_date,
  units, price_per_unit, amount, fee, trade_currency, fx_to_thb,
  note, source, import_batch_id, created_at, updated_at
)
SELECT
  h.bucket_id, h.ticker, h.english_name, h.quote_source, 'opening',
  COALESCE(h.acquired_on, substr(h.created_at, 1, 10)),
  h.units, h.avg_cost,
  CASE WHEN h.avg_cost IS NULL THEN 0 ELSE -(h.units * h.avg_cost) END,
  NULL, 'THB', 1,
  NULL, h.source, 'backfill-opening', h.created_at, h.updated_at
FROM holdings h
WHERE NOT EXISTS (
  SELECT 1 FROM transactions t WHERE t.bucket_id = h.bucket_id
);
