"use client";

// The Portfolio chart's "VS" benchmark control, as removable pills.
//
// Off state is a single "+ Compare" chip; once a benchmark is chosen it becomes a
// pill (label + ✕ to clear, tap the label to change). The pill row is built to
// grow into MULTIPLE benchmarks later: render one pill per selected key plus a
// trailing "+ Add" chip, and lift `value`/`onChange` to an array. For now it's
// single-select (the chart overlays one benchmark line), so there's one pill at a
// time and the "+ Compare" chip stands in for the future "+ Add".
//
// The menu reuses the shared `.combobox__list` styling, but is placed with the
// global `usePopoverPlacement` (two-axis flip: down + left-aligned by default →
// right-aligned, then up, as space runs out — and fixed-positioned so the
// toolbar's overflow clip can't cut it off), matching the cash hint's behavior.

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BENCHMARK_TR_OPTIONS } from "@/lib/market/benchmark-options";
import { useListboxKeyboard } from "@/lib/useListboxKeyboard";
import { usePopoverPlacement } from "@/lib/usePopoverPlacement";

// Fixed height so the off chip and the active pill (which has an extra ✕ child)
// are exactly the same height — no jump on select.
const CONTROL: CSSProperties = { height: 28, boxSizing: "border-box" };

export function BenchmarkPicker({
  value,
  onChange,
}: {
  /** Selected benchmark key, or "none" when off. */
  value: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listStyle = usePopoverPlacement(triggerRef, listRef, { open });

  const active = BENCHMARK_TR_OPTIONS.find((b) => b.key === value);

  function toggle() {
    setOpen((o) => !o);
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      // The list is portaled to <body> (outside `ref`), so check it explicitly —
      // otherwise an option click reads as "outside" and closes before selecting.
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // On open, move focus into the list (the selected option, or the first).
  useEffect(() => {
    if (!open) return;
    const opts = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    const selected = opts.find((o) => o.getAttribute("aria-selected") === "true");
    (selected ?? opts[0])?.focus();
  }, [open]);

  const onKeyDown = useListboxKeyboard({
    open,
    setOpen,
    listRef,
    triggerRef,
  });

  return (
    // inline-flex so the wrapper hugs its content — a click to the right of the
    // control (empty chart row) lands outside it and closes the menu.
    <div
      ref={ref}
      onKeyDown={onKeyDown}
      style={{
        position: "relative",
        display: "inline-flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        // No own margin — the caller positions it (so it can sit flush-left under
        // the period pills). Spacing comes from the wrapper in PortfolioScreen.
        margin: 0,
      }}
    >
      {active ? (
        // Flat like the rest of the toolbar, carrying the same accent-soft highlight
        // every engaged control shows (so "active = green" stays uniform across the
        // bar) — including the accent-ink label, so it matches the period/mode/Scale
        // active text. The dashed swatch keeps the benchmark color (it matches the
        // chart line); the × stays muted as a secondary affordance. Span padding is 0
        // so the two inner buttons fill it: clicking the swatch or label opens the
        // menu, the × removes.
        <span
          className="chart-toolbtn"
          data-active="true"
          style={{ ...CONTROL, padding: 0, gap: 0 }}
        >
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`Comparing against ${active.label} — change`}
            onClick={toggle}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: "100%",
              padding: "0 4px 0 7px",
              background: "none",
              border: "none",
              cursor: "pointer",
              font: "inherit",
              color: "inherit",
            }}
          >
            {/* Dashed swatch in the benchmark color, matching its chart line. */}
            <span
              aria-hidden="true"
              style={{ width: 14, flex: "none", borderTop: "1.5px dashed var(--benchmark)" }}
            />
            {active.label}
          </button>
          <button
            type="button"
            aria-label="Remove benchmark"
            onClick={(e) => {
              e.stopPropagation();
              onChange("none");
              setOpen(false);
            }}
            style={{
              height: "100%",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted)",
              fontSize: 15,
              lineHeight: 1,
              padding: "0 8px 0 2px",
            }}
          >
            ×
          </button>
        </span>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="chart-toolbtn"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
        >
          + Compare
        </button>
      )}
      {open &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label="Benchmark"
            className="combobox__list"
            // Portaled to <body> so it escapes the scroll host's stacking context
            // and floats above the right detail panel. Fixed-positioned by
            // usePopoverPlacement; clear the shared class's `min-width: 100%`, which
            // under `position: fixed` would resolve against the viewport, not the trigger.
            style={{ ...listStyle, minWidth: "auto" }}
          >
            {BENCHMARK_TR_OPTIONS.map((b) => (
              <button
                key={b.key}
                type="button"
                role="option"
                aria-selected={b.key === value}
                className="combobox__option"
                style={b.key === value ? { background: "var(--accent-soft)" } : undefined}
                onClick={() => {
                  onChange(b.key);
                  setOpen(false);
                }}
              >
                {b.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
