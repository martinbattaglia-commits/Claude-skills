"use client";

import { Icon } from "@/components/Icon";

/**
 * The currency SYMBOL of a money field, a left-edge prefix ($ / ฿). Two forms,
 * one look:
 *   • `onCycle` given → an interactive pill (button + chevron cue), tap to switch ฿⇄$ —
 *     used where the user picks the currency (cash, a custom asset).
 *   • no `onCycle` → a read-only symbol, used where the currency is derived (a Thai fund
 *     is ฿, a US Stock/ETF is $) and echoed on the row's other money fields.
 * Both render at the same weight — a step below the black value, but darker than the
 * faded placeholder, so it never reads as one.
 * Shared by the Add/Record modal, the History editor, and the Edit-holding sheet.
 */
export function CurrencyPrefix({ code, onCycle }: { code: string; onCycle?: () => void }) {
  if (onCycle) {
    return (
      <button
        type="button"
        className="cur-prefix cur-prefix--toggle"
        title="Currency — tap to switch (฿ ⇄ $)"
        // Keep focus on the input so a tap doesn't blur mid-entry.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCycle}
      >
        {code}
        <Icon name="chevron-down" size={9} />
      </button>
    );
  }
  return <span className="cur-prefix">{code}</span>;
}
