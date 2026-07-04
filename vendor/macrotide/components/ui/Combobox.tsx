"use client";

// Combobox — the app's one custom autocomplete dropdown. A text input with a
// styled suggestion list (NOT the native <datalist>, which can't show a second
// line, tags, or an in-input adornment). Generic over the suggestion type: the
// caller supplies the items, a key, and how to render each one. Ported from the
// original AddHoldingsSheet symbol field so every custom dropdown — symbol,
// source, anything future — shares this behavior and styling.

import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useClipEnd } from "@/lib/useClipEnd";
import { useFlipUp } from "@/lib/useFlipUp";

export interface ComboboxProps<T> {
  value: string;
  onChange: (value: string) => void;
  /** A suggestion was chosen (mousedown, before blur). */
  onPick: (item: T) => void;
  /** Suggestions to show while focused. Empty → no dropdown. */
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  placeholder?: string;
  /** aria-label for the input. */
  label?: string;
  title?: string;
  invalid?: boolean;
  autoComplete?: string;
  /** Right-edge adornment rendered inside the field (e.g. a price-source badge). */
  trailing?: ReactNode;
  /** Right padding reserved for `trailing`. */
  trailingPad?: number;
  /** Render the list upward (when the field sits near the bottom of a sheet). */
  openUp?: boolean;
  inputClassName?: string;
  inputStyle?: CSSProperties;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function Combobox<T>({
  value,
  onChange,
  onPick,
  items,
  getKey,
  renderItem,
  placeholder,
  label,
  title,
  invalid,
  autoComplete = "off",
  trailing,
  trailingPad = 42,
  openUp,
  inputClassName,
  inputStyle,
  onFocus,
  onBlur,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  // Measured fallback: if there isn't room below the input for the list, drop it
  // UPWARD instead. The floor is the nearest SCROLL CONTAINER's bottom (e.g. a
  // modal body, whose bottom edge is exactly where the sticky footer begins) —
  // not the viewport — so the list never hides under a sticky footer. `openUp`
  // forces it; otherwise we measure on focus.
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = open && items.length > 0;
  const { up: flipUp, measure: measureFlip } = useFlipUp(inputRef);
  const up = openUp || flipUp;

  // Keyboard nav: the highlighted option (−1 = none, so plain Enter keeps a typed
  // custom value instead of pulling in the top suggestion). Arrow keys move it, Enter
  // picks it, Escape closes.
  const [active, setActive] = useState(-1);
  // Keep the highlight in range as the filtered list changes; scroll it into view.
  useEffect(() => {
    if (active >= items.length) setActive(items.length - 1);
  }, [items.length, active]);
  useEffect(() => {
    if (!show || active < 0) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, show]);

  const move = (delta: number) => {
    if (!show) {
      setOpen(true);
      return;
    }
    const n = items.length;
    setActive((i) => (i < 0 ? (delta > 0 ? 0 : n - 1) : (i + delta + n) % n));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" && show && active >= 0 && active < items.length) {
      e.preventDefault();
      onPick(items[active]);
      setOpen(false);
      setActive(-1);
    } else if (e.key === "Escape" && show) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  // A trailing fade (the symbol field's `.field-fade`) cues "there's more to the
  // right", so it shows only while the value is clipped and not scrolled to its
  // end — tracked by the shared hook and surfaced as `data-clip-end`.
  const { clipEnd, recompute: updateClipEnd } = useClipEnd(inputRef, value);

  return (
    <div className="combobox" data-clip-end={clipEnd || undefined}>
      <input
        ref={inputRef}
        className={inputClassName}
        value={value}
        onChange={(e) => {
          setOpen(true);
          setActive(-1); // a fresh filter starts unhighlighted
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onScroll={updateClipEnd}
        onFocus={() => {
          measureFlip();
          updateClipEnd();
          setOpen(true);
          onFocus?.();
        }}
        onBlur={() => {
          // Delay so a mousedown on an option lands before the list unmounts.
          if (blurTimer.current) clearTimeout(blurTimer.current);
          blurTimer.current = setTimeout(() => setOpen(false), 120);
          onBlur?.();
        }}
        placeholder={placeholder}
        aria-label={label}
        title={title}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={show}
        aria-controls={listId}
        aria-invalid={invalid || undefined}
        autoComplete={autoComplete}
        style={{ ...(trailing ? { paddingRight: trailingPad } : null), ...inputStyle }}
      />
      {trailing}
      {show && (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          className="combobox__list"
          data-up={up || undefined}
        >
          {items.map((item, i) => (
            <button
              key={getKey(item)}
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active || undefined}
              className="combobox__option"
              // Sync the keyboard highlight to the pointer so the two don't fight.
              onMouseEnter={() => setActive(i)}
              // mousedown fires before blur — keeps the input focused so the
              // list doesn't unmount before the pick runs.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
                setOpen(false);
                setActive(-1);
              }}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
