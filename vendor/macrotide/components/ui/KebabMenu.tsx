"use client";

// KebabMenu — a ⋮ button that opens a small action menu. Replaces ambiguous
// single-purpose icons (a pencil that sometimes edits, sometimes opens history)
// with an explicit labelled menu. Closes on outside-click or after a pick;
// stops propagation so it works inside a clickable row.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

export interface KebabItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export interface KebabMenuProps {
  items: KebabItem[];
  /** aria-label / tooltip for the trigger. */
  label?: string;
  size?: number;
  /** Trigger button class — default is the quiet (borderless) icon button; pass
   * "icon-btn" to match a bordered icon button next to it. */
  triggerClassName?: string;
}

export function KebabMenu({
  items,
  label = "More actions",
  size = 16,
  triggerClassName = "icon-btn quiet",
}: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="kebab" ref={ref} style={{ flexShrink: 0, alignSelf: "center" }}>
      <button
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Icon name="ellipsis-vertical" size={size} />
      </button>
      {open && (
        <div className="kebab__menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="kebab__item"
              data-danger={it.danger || undefined}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
