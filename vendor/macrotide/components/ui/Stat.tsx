// Stat — a single KPI card: a mono label, a large tone-colored value, and an
// optional caption. Composed in a `.stat-cards` grid. Ported from the original
// activity recap so the History/Position performance summary reads richer than a
// bare strip (a caption can say "money-weighted", a tone can color a gain/loss).

import type { ReactNode } from "react";

export interface StatProps {
  label: string;
  // ReactNode so callers can wrap the value in PrivateAmount (privacy masking).
  value: ReactNode;
  tone?: "up" | "down" | "muted" | "neutral";
  caption?: string;
}

export function Stat({ label, value, tone = "neutral", caption }: StatProps) {
  const color =
    tone === "up"
      ? "var(--gain)"
      : tone === "down"
        ? "var(--loss)"
        : tone === "muted"
          ? "var(--muted)"
          : "var(--ink)";
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value" style={{ color }}>
        {value}
      </div>
      {caption && <div className="stat-card__caption">{caption}</div>}
    </div>
  );
}
