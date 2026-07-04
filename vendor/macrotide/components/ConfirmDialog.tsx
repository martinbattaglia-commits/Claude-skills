"use client";

import { Modal } from "@/components/Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body text explaining the consequence of confirming. */
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true (default) the confirm button reads as a dangerous action. */
  destructive?: boolean;
  /** Disable the buttons while the confirm action is in flight. */
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Reusable "Are you sure?" dialog for destructive actions. A thin preset over
 * <Modal variant="confirm">: it renders above form/detail modals (z 200) so it
 * can be invoked from within an open sheet, traps focus on the confirm button,
 * and cancels on Escape / backdrop click — all handled by the primitive.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} variant="confirm" labelledBy="confirm-dialog-title">
      <Modal.Header title={title} id="confirm-dialog-title" />
      {message && (
        <Modal.Body>
          <div className="modal-confirm-message">{message}</div>
        </Modal.Body>
      )}
      <Modal.Footer>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? "btn danger" : "btn primary"}
          onClick={onConfirm}
          disabled={busy}
          data-autofocus
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
