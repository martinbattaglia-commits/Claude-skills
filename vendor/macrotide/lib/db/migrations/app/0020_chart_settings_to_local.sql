-- Chart view settings (period, mode, scale, cash basis) moved to per-device
-- localStorage; the cash-note flag too. Only `cashReturnMode` ever reached prod
-- via /api/settings — the others are branch-only — but delete all four defensively
-- so no orphaned rows linger in the global `settings` store. Idempotent.
DELETE FROM `settings` WHERE `key` IN ('cashReturnMode', 'yAxisScale', 'chartMode', 'cashHintDismissed');
