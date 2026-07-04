-- Facts-only ledger (ADR 0004): a value-only Balance stores its stated current ฿
-- VALUE as a fact; units are derived from value ÷ NAV(tradeDate) at the projection
-- fold, never frozen at save. Nullable additive column — a plain ADD COLUMN (not a
-- table rebuild) so existing rows are untouched and the change is forward-only.
ALTER TABLE `transactions` ADD COLUMN `value` real;
