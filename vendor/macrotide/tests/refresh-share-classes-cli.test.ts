// Tests for the share-class refresh CLI script.
//
// Coverage: the pure CLI-layer parseArgs helper. The refresh itself
// (refreshShareClasses) is covered in lib/jobs/refresh-share-classes.test.ts.

import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/refresh-share-classes";

describe("parseArgs", () => {
  it("defaults to no limit", () => {
    expect(parseArgs([])).toEqual({ limit: 0 });
  });

  it("parses --limit=N", () => {
    expect(parseArgs(["--limit=500"])).toEqual({ limit: 500 });
  });

  it("ignores malformed or non-positive limits", () => {
    expect(parseArgs(["--limit=abc"])).toEqual({ limit: 0 });
    expect(parseArgs(["--limit=0"])).toEqual({ limit: 0 });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["--dry-run", "--foo=1"])).toEqual({ limit: 0 });
  });
});
