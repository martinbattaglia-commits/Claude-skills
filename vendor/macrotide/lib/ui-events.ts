import type { KeyboardEvent } from "react";

/**
 * Make a non-button element (a clickable card or row) keyboard-operable without
 * changing its markup or styling. Spreads onto the element to add the same
 * activation affordance a native button has: click, Enter/Space, a button role,
 * and tab focus.
 *
 *   <div {...onActivate(() => open(id))}>…</div>
 *
 * Prefer a real <button> when the element's CSS allows it; reach for this only
 * when converting to a button would change the visual design.
 */
export function onActivate(handler: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    },
  };
}
