"use client";

// A subtle "save this reply to your notes" affordance under a finished Advisor
// message — a muted bookmark icon (no label), a quiet per-message action.
// Deliberate user save, distinct from memory: it
// persists a journal note. It's a TOGGLE — click again to remove the note it
// created. Shown only once the message has finished streaming.
export interface SaveNoteButtonProps {
  saved?: boolean;
  onSave?: () => void;
}

export function SaveNoteButton({ saved = false, onSave }: SaveNoteButtonProps) {
  return (
    <button
      type="button"
      className="msg-save"
      data-active={saved}
      onClick={onSave}
      aria-label={saved ? "Saved — click to remove from your notes" : "Save"}
      title={saved ? "Saved" : "Save"}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
      </svg>
    </button>
  );
}
