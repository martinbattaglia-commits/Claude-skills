import { Icon } from "@/components/Icon";

// One "Show N more ⌄ / Show less ⌃" toggle for every expandable list inside a
// detail modal (holdings, look-through, portfolio, related-fund groups, dividends),
// so they read and toggle identically everywhere. Renders nothing when there's
// nothing more to show.

export function ShowMoreToggle({
  expanded,
  moreCount,
  onToggle,
}: {
  expanded: boolean;
  /** How many additional rows expanding reveals (the collapsed "Show N more" count).
   *  A stable value (independent of `expanded`) so the toggle can also collapse. */
  moreCount: number;
  onToggle: () => void;
}) {
  if (moreCount <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        marginTop: 6,
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "none",
        border: "none",
        padding: "4px 2px",
        fontSize: 11.5,
        fontWeight: 500,
        color: "var(--accent)",
        cursor: "pointer",
      }}
    >
      {expanded ? "Show less" : `Show ${moreCount} more`}
      <Icon name={expanded ? "chevron-up" : "chevron-down"} size={13} />
    </button>
  );
}
