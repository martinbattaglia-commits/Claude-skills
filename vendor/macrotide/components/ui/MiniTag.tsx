// MiniTag — the compact mono tag (9.5px, radius 4) used for the fund-class tags
// in the Thai screener and the asset-type badge in the unified Explore list. One
// shared component so the badges look identical across tabs.

import type { ReactNode } from "react";

/** Compact colored label chip. Defaults to the accent ramp; pass color/bg to retint.
 *  An optional leading `icon` renders inside the chip (e.g. a lock for reserved cash),
 *  inheriting the chip's text color. */
export function MiniTag({
  label,
  title,
  color = "var(--accent)",
  bg = "var(--accent-soft)",
  clamp = false,
  icon,
}: {
  label: string;
  title?: string;
  color?: string;
  bg?: string;
  clamp?: boolean;
  icon?: ReactNode;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: icon ? 3 : 0,
        fontSize: 9.5,
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        color,
        background: bg,
        borderRadius: 4,
        padding: "1px 5px",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        // A long feeder master-fund name would otherwise overflow the card and
        // trigger a horizontal scrollbar. Clamp it with an ellipsis (the full
        // name stays in the title tooltip); minWidth:0 lets it shrink as a flex
        // item, and it wraps to its own line when it can't fit alongside others.
        ...(clamp ? { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } : null),
      }}
    >
      {icon}
      {label}
    </span>
  );
}
