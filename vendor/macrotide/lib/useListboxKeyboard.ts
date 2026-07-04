"use client";

import type { KeyboardEvent, RefObject } from "react";

// Shared keyboard behavior for a button-triggered `role="listbox"` popover (the
// custom dropdowns: the benchmark picker, the fund-detail class switcher). Pairs
// with `useFlipUp` for placement. Returns an `onKeyDown` to put on the wrapper:
//   - closed: ↑/↓ opens (after `onBeforeOpen`, e.g. measure placement)
//   - open:   ↑/↓ move focus across options, Home/End jump, Esc closes + restores
//             focus to the trigger, Tab closes. Enter/Space activate the focused
//             option natively (they're <button>s).
// Move focus into the list on open with a small effect in the component (focus
// the [aria-selected] option, or the first), so arrows have a starting point.
export function useListboxKeyboard({
  open,
  setOpen,
  listRef,
  triggerRef,
  onBeforeOpen,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  listRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onBeforeOpen?: () => void;
}) {
  return function onKeyDown(e: KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        onBeforeOpen?.();
        setOpen(true);
      }
      return;
    }
    const opts = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );
    const idx = opts.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        opts[Math.min(idx + 1, opts.length - 1)]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        opts[Math.max(idx - 1, 0)]?.focus();
        break;
      case "Home":
        e.preventDefault();
        opts[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        opts[opts.length - 1]?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };
}
