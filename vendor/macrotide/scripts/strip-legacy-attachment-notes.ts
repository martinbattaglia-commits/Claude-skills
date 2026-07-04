// One-time data cleanup: strip the legacy "(Attached files: …)" note that older
// image-turn rows baked into `chat_messages.content`.
//
// Before the attachment-metadata refactor, the chat route persisted the model-
// facing note INTO the user message: `content` became
//   <prompt>\n\n(Attached files: "name" saved DATE)\n\n[N images attached]
// so on reload the internal note leaked into the user's bubble. New rows now
// store only the raw prompt (the note is recomposed from the structured
// `attachments` column at model-build time and never persisted), but rows
// written before the change still carry the note. This script removes just the
// `\n\n(Attached file(s): …)` segment from those rows, leaving the user's text
// and any trailing `[N images attached]` marker intact (the client still strips
// that marker on display when it has the thumbnails).
//
// SQLite has no regex UPDATE, so we do it in JS (precedent: backfill-owner.ts).
// Pure data fix on the precious app.db — no schema change. BACK UP app.db first.
// Idempotent: a second run reports 0 rows changed.
//
// ── HOW TO RUN (once, after deploying the refactor) ─────────────────────────
//   npx tsx --tsconfig tsconfig.scripts.json scripts/strip-legacy-attachment-notes.ts
// Set DB_PATH to point at a non-default app.db location. Demo DBs are in-memory
// and ephemeral, so they need nothing.

import { resolve } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = resolve(process.env.DB_PATH ?? "data/app.db");

// The legacy note segment: a leading blank line then "(Attached file(s): …)" up
// to the closing paren. Non-greedy and newline-free (the note was one line), so
// it can't swallow a following "[N images attached]" marker on the next line.
const NOTE_RE = /\n\n\(Attached files?:[^)\n]*\)/g;

function main(): void {
  const sqlite = new Database(DB_PATH);
  const rows = sqlite
    .prepare(
      "SELECT id, content FROM chat_messages WHERE role = 'user' AND content LIKE '%(Attached file%'",
    )
    .all() as { id: number; content: string }[];

  const update = sqlite.prepare("UPDATE chat_messages SET content = ? WHERE id = ?");
  let changed = 0;
  const tx = sqlite.transaction((items: { id: number; content: string }[]) => {
    for (const { id, content } of items) {
      const cleaned = content.replace(NOTE_RE, "");
      if (cleaned !== content) {
        update.run(cleaned, id);
        changed += 1;
      }
    }
  });
  tx(rows);

  console.log(
    `[strip-legacy-attachment-notes] scanned ${rows.length} candidate row(s), cleaned ${changed}.`,
  );
  sqlite.close();
}

main();
