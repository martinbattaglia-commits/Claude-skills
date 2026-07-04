import { describe, expect, it } from "vitest";
import { parseGicsCsv, splitCsvLine } from "./gics";

describe("splitCsvLine", () => {
  it("splits plain comma fields", () => {
    expect(splitCsvLine("A,B,C")).toEqual(["A", "B", "C"]);
  });

  it("keeps commas inside a quoted field", () => {
    expect(splitCsvLine('AAPL,"Apple, Inc.",Tech')).toEqual(["AAPL", "Apple, Inc.", "Tech"]);
  });

  it("unescapes doubled quotes", () => {
    expect(splitCsvLine('"a""b",c')).toEqual(['a"b', "c"]);
  });
});

describe("parseGicsCsv", () => {
  const csv = [
    "Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location",
    'AAPL,Apple Inc.,Information Technology,Technology Hardware Storage & Peripherals,"Cupertino, California"',
    'XOM,Exxon Mobil Corp,Energy,Integrated Oil & Gas,"Irving, Texas"',
    ",,,,", // junk row → skipped (no symbol/sector)
  ].join("\n");

  it("maps symbol → GICS sector/sub-industry, skipping junk and commas-in-HQ", () => {
    expect(parseGicsCsv(csv)).toEqual([
      {
        symbol: "AAPL",
        gicsSector: "Information Technology",
        gicsSubIndustry: "Technology Hardware Storage & Peripherals",
      },
      { symbol: "XOM", gicsSector: "Energy", gicsSubIndustry: "Integrated Oil & Gas" },
    ]);
  });

  it("returns [] for empty or header-only input", () => {
    expect(parseGicsCsv("")).toEqual([]);
    expect(parseGicsCsv("Symbol,Security,GICS Sector")).toEqual([]);
  });
});
