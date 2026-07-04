// Deterministic gate: docs/reference/api.md must stay a complete, accurate
// catalog of the App Router HTTP routes. The doc is hand-maintained, so it drifts
// — whole route surfaces under app/api/** go missing as new ones land, or stale
// rows linger after a route is renamed/removed. This test turns the catalog into
// a lint-as-gate: it walks app/api/**/route.ts, derives each route path + its
// exported HTTP methods, parses the doc's route table, and fails on any
// divergence. Fix is always cheap: edit api.md.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "app", "api");
const DOC = join(ROOT, "docs", "reference", "api.md");

const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
type Verb = (typeof HTTP_VERBS)[number];

interface RouteFile {
  /** Doc-style path, e.g. "/api/holdings/[id]" (dynamic segments kept verbatim). */
  path: string;
  /** HTTP verbs the handler exports. */
  verbs: Verb[];
}

/** Every route.ts under app/api, with its derived path + exported verbs. */
function routeFiles(): RouteFile[] {
  const out: RouteFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "route.ts" || entry.name === "route.tsx") {
        // Dir relative to app/ → "/api/..." (POSIX separators, even on Windows).
        const dirRel = relative(join(ROOT, "app"), dir).split(/[/\\]/).join("/");
        const src = readFileSync(full, "utf8");
        // Catches all three export shapes used here: `export function GET`,
        // `export async function GET`, and `export const GET = …`.
        const verbs = HTTP_VERBS.filter((v) =>
          new RegExp(`export\\s+(?:async\\s+)?function\\s+${v}\\b|export\\s+const\\s+${v}\\b`).test(
            src,
          ),
        );
        out.push({ path: `/${dirRel}`, verbs });
      }
    }
  };
  walk(API_DIR);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Parse the doc's route tables: first column is `/api/...`, second is methods. */
function docEntries(): Map<string, string> {
  const map = new Map<string, string>();
  // A catalog row: `| `/api/x` | GET, POST | … |`. Anchored on the leading pipe so
  // an /api/… mention inside a description cell (column 3) is never miscounted.
  const row = /^\|\s*`(\/api\/[^`]+)`\s*\|\s*([^|]*)\|/;
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    const m = line.match(row);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

describe("api.md route catalog stays in sync with app/api/**", () => {
  const files = routeFiles();
  const doc = docEntries();

  it("finds routes on disk and entries in the doc (sanity)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(doc.size).toBeGreaterThan(0);
  });

  it("documents every route file (no undocumented routes)", () => {
    const undocumented = files.filter((f) => !doc.has(f.path)).map((f) => f.path);
    expect(
      undocumented,
      `Add these to ${relative(ROOT, DOC)}:\n${undocumented.join("\n")}`,
    ).toEqual([]);
  });

  it("has no stale entries (every documented route still exists on disk)", () => {
    const onDisk = new Set(files.map((f) => f.path));
    const stale = [...doc.keys()].filter((p) => !onDisk.has(p));
    expect(
      stale,
      `Remove these from ${relative(ROOT, DOC)} (no matching route.ts):\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("documents every exported HTTP method of each route", () => {
    const missing: string[] = [];
    for (const f of files) {
      const cell = doc.get(f.path);
      if (cell === undefined) continue; // covered by the undocumented-routes test
      // Skip rows whose method cell is prose, not a verb list (e.g. "(better-auth)").
      const cellHasVerbs = HTTP_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(cell));
      if (!cellHasVerbs) continue;
      for (const v of f.verbs) {
        if (!new RegExp(`\\b${v}\\b`).test(cell)) missing.push(`${f.path} → ${v}`);
      }
    }
    expect(
      missing,
      `These exported methods are missing from the Methods column in ${relative(ROOT, DOC)}:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
