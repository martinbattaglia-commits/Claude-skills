"use client";

// The "modal as page" host: ONE persistent Modal whose body is the top of the
// shared detail stack. A cross-link inside a sheet pushes a new level and the
// content swaps IN PLACE — the Modal shell (overlay, focus trap, scroll lock)
// never remounts, so a stock→ETF→fund drill is smooth with no flicker. The header
// Back chevron pops one level (shown once depth > 1); ✕ / overlay / Escape clears
// the whole stack; browser/hardware Back pops one level via the stack's per-level
// history layers. Each sheet renders in `asContent` mode (its header+body only,
// no Modal of its own).

import { FundDetailSheet } from "@/components/FundDetailSheet";
import { Modal } from "@/components/Modal";
import { UsSecurityDetailSheet } from "@/components/UsSecurityDetailSheet";
import { useDetailStack } from "@/lib/nav/detail-stack";
import type { Holding } from "@/lib/static/types";

export interface DetailSheetHostProps {
  /** Portfolio/Position: hand a holding view off to the edit form (clears the stack). */
  onEditHolding?: (h: Holding) => void;
  /** Portfolio/Position: open a holding's Position page (clears the stack). */
  onOpenPosition?: (ticker: string) => void;
}

export function DetailSheetHost({ onEditHolding, onOpenPosition }: DetailSheetHostProps = {}) {
  const { top, depth, push, pop, clear } = useDetailStack();
  const back = depth > 1 ? pop : undefined;

  let content: React.ReactNode = null;
  if (top?.kind === "us") {
    content = (
      <UsSecurityDetailSheet
        asContent
        symbol={top.symbol}
        onNavigate={push}
        onBack={back}
        onClose={clear}
      />
    );
  } else if (top?.kind === "fund") {
    content = (
      <FundDetailSheet
        asContent
        hosted
        projId={top.id}
        onBack={back}
        onOpenSymbol={(symbol) => push({ kind: "us", symbol })}
        onClose={clear}
      />
    );
  } else if (top?.kind === "holding") {
    const h = top.holding;
    content = (
      <FundDetailSheet
        asContent
        hosted
        holding={h}
        onBack={back}
        onOpenSymbol={(symbol) => push({ kind: "us", symbol })}
        onEdit={
          onEditHolding && h.id !== undefined
            ? () => {
                clear();
                onEditHolding(h);
              }
            : undefined
        }
        onHistory={
          onOpenPosition
            ? () => {
                clear();
                onOpenPosition(h.ticker);
              }
            : undefined
        }
        onClose={clear}
      />
    );
  }

  // One Modal for every level — keep it mounted across content swaps (open stays
  // true while the stack is non-empty), so navigating between levels doesn't
  // remount the overlay. manageBack=false: the stack owns per-level Back layers.
  return (
    <Modal
      open={top != null}
      onClose={clear}
      variant="detail"
      labelledBy="detail-sheet-title"
      manageBack={false}
    >
      {content}
    </Modal>
  );
}
