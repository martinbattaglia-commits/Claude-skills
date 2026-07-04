"use client";

// ExploreFilterBar — the shared search box + one filter row used by every Explore
// screener (All / Thai / US ETFs / US stocks). One wrapper means identical
// spacing across tabs, so the asset-type segment never shifts when you switch.
// `children` is the filter row's content: the asset-type segment, then (for Thai)
// a divider + the facet pills.

import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";

export function ExploreFilterBar({
  placeholder,
  value,
  onChange,
  children,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  children?: ReactNode;
}) {
  return (
    <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--line-soft)" }}>
      <div style={{ position: "relative", marginBottom: children ? 8 : 0 }}>
        <span
          style={{
            position: "absolute",
            left: 10,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--muted)",
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="search" size={13} />
        </span>
        <input
          className="sheet-input"
          type="search"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ paddingLeft: 30, width: "100%", boxSizing: "border-box" }}
        />
      </div>
      {children && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {children}
        </div>
      )}
    </div>
  );
}
