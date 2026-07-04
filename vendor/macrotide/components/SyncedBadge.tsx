// Compact marker shown beside a holding's ticker when it was imported from a
// connected broker. "Synced" is the reliable signal — set only when a holding
// has broker-imported ledger rows (Holding.syncedBroker), never from a
// hand-typed source.

import { Icon } from "@/components/Icon";

/** lucide icon name for the synced marker — single source so it's easy to swap. */
const SYNCED_ICON = "refresh-cw";

/** Small glyph shown beside a synced holding's ticker in the list. */
export function SyncedIcon({ broker, size = 11 }: { broker: string; size?: number }) {
  return (
    <span
      role="img"
      aria-label={`Synced from ${broker}`}
      title={`Synced from ${broker}`}
      // Optically center against the ticker text: box-centering leaves the glyph
      // sitting a hair low, so nudge it up ~1px.
      style={{
        display: "inline-flex",
        flexShrink: 0,
        position: "relative",
        top: -0.5,
        color: "var(--muted)",
      }}
    >
      <Icon name={SYNCED_ICON} size={size} />
    </span>
  );
}
