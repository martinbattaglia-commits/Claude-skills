# Vendored third-party code

This directory holds external projects vendored (snapshotted) into this
repository. Vendored code is a point-in-time copy of an upstream project's
source, checked in directly rather than pulled as a dependency or git submodule.

## macrotide

| | |
|---|---|
| **Path** | `vendor/macrotide/` |
| **Upstream** | https://github.com/Sitthinut/macrotide |
| **Commit** | `ff0354837a50d16adbe04b2ce5d049584c8b532a` |
| **Upstream commit date** | 2026-07-03 |
| **Vendored on** | 2026-07-04 |
| **License** | MIT (see `vendor/macrotide/LICENSE`) |
| **Method** | `git archive HEAD` from a clean clone — a source snapshot only, no upstream git history |

Macrotide is a standalone Next.js 16 web application ("an honest mirror for your
index portfolio" — an AI investment companion for Thai index investors). It is
**not** a Claude Code skill or plugin; it is an independent app that happens to
live here as vendored source.

### What was and wasn't copied

Only upstream-tracked files were vendored. Build/runtime artifacts that upstream
already gitignores were **not** copied: `node_modules/`, `.env.local`, the
runtime `data/` SQLite databases, and `.next/` build output. The upstream
`.env.example` template **is** included (it contains placeholders only, no
secrets).

### Running it

macrotide is self-contained under `vendor/macrotide/`:

```bash
cd vendor/macrotide
npm install
npm run dev        # http://localhost:3000
```

Requires Node >= 20. Copy `.env.example` to `.env.local` and set
`AUTH_DISABLED=1` for solo local dev; set `OPENROUTER_API_KEY` to enable the AI
advisor chat (otherwise it returns a friendly stub). See
`vendor/macrotide/README.md` for full details.

### Updating the vendored copy

Re-run the snapshot from a fresh clone at the desired upstream commit and
replace the tree, then update the commit hash in this file:

```bash
git clone https://github.com/Sitthinut/macrotide.git /tmp/macrotide
git -C /tmp/macrotide archive HEAD | tar -x -C vendor/macrotide
```
