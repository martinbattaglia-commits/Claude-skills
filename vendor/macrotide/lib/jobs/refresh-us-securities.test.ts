import { describe, expect, it } from "vitest";
import { withFreshContext } from "@/tests/db-helpers";
import {
  bumpUsSymbolDemand,
  countUsSecurities,
  findUsSecurities,
  getUsSecurity,
} from "../db/queries/us-securities";
import { parseNasdaqDirectory, refreshUsSecurities } from "./refresh-us-securities";

// Synthetic directory fixture in the real nasdaqtraded.txt shape (pipe-delimited).
const FIXTURE = [
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
  "Y|AAPL|Apple Inc. - Common Stock|Q| |N|100|N||AAPL|AAPL|N",
  "Y|VOO|Vanguard S&P 500 ETF|P| |Y|100|N||VOO|VOO|N",
  "Y|MSFT|Microsoft Corporation - Common Stock|Q| |N|100|N||MSFT|MSFT|N",
  // test issue → skipped
  "Y|ZTEST|Nasdaq Test Issue|Q| |N|100|Y||ZTEST|ZTEST|N",
  // malformed (too few cols) → skipped
  "Y|BAD|Broken row",
  "File Creation Time: 0623202601:02|||||||||||",
].join("\n");

describe("parseNasdaqDirectory", () => {
  it("parses stocks and ETFs, mapping the ETF flag + exchange code", () => {
    const rows = parseNasdaqDirectory(FIXTURE);
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "VOO", "MSFT"]);
    const voo = rows.find((r) => r.symbol === "VOO");
    expect(voo?.securityType).toBe("etf");
    expect(voo?.exchange).toBe("NYSE Arca");
    const aapl = rows.find((r) => r.symbol === "AAPL");
    expect(aapl?.securityType).toBe("stock");
    expect(aapl?.exchange).toBe("Nasdaq");
  });

  it("skips the header, the footer, test issues, and malformed lines", () => {
    const rows = parseNasdaqDirectory(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.symbol === "ZTEST")).toBeUndefined();
    expect(rows.find((r) => r.symbol === "BAD")).toBeUndefined();
  });

  it("returns no rows for an empty / header-only input", () => {
    expect(parseNasdaqDirectory("")).toHaveLength(0);
    expect(parseNasdaqDirectory(FIXTURE.split("\n")[0])).toHaveLength(0);
  });
});

describe("refreshUsSecurities", () => {
  it("upserts the parsed universe and resolves a symbol case-insensitively", async () => {
    await withFreshContext(async () => {
      const res = await refreshUsSecurities({
        fetchText: async () => FIXTURE,
        seenAt: "2026-06-25T00:00:00Z",
      });
      expect(res.parsed).toBe(3);
      expect(res.upserted).toBe(3);
      expect(res.delisted).toBe(0);

      expect(getUsSecurity("aapl")?.name).toContain("Apple");
      const etfs = findUsSecurities({ securityType: "etf" });
      expect(etfs.items.map((r) => r.symbol)).toEqual(["VOO"]);
    });
  });

  it("delists symbols a later directory no longer lists, then re-lists them on return", async () => {
    await withFreshContext(async () => {
      await refreshUsSecurities({ fetchText: async () => FIXTURE, seenAt: "2026-06-25T00:00:00Z" });

      // Second run drops MSFT from the directory.
      const SHRUNK = [
        FIXTURE.split("\n")[0],
        "Y|AAPL|Apple Inc. - Common Stock|Q| |N|100|N||AAPL|AAPL|N",
        "Y|VOO|Vanguard S&P 500 ETF|P| |Y|100|N||VOO|VOO|N",
      ].join("\n");
      const res2 = await refreshUsSecurities({
        fetchText: async () => SHRUNK,
        seenAt: "2026-06-26T00:00:00Z",
      });
      expect(res2.delisted).toBe(1);
      expect(getUsSecurity("MSFT")?.status).toBe("delisted");
      // Active-only search no longer surfaces MSFT.
      expect(findUsSecurities({ query: "MSFT" }).items).toHaveLength(0);

      // Third run: MSFT returns → back to active.
      await refreshUsSecurities({ fetchText: async () => FIXTURE, seenAt: "2026-06-27T00:00:00Z" });
      expect(getUsSecurity("MSFT")?.status).toBe("active");
      const counts = countUsSecurities();
      expect(counts.active).toBe(3);
      expect(counts.delisted).toBe(0);
    });
  });

  it("aborts rather than delisting the whole catalog on an empty parse", async () => {
    await withFreshContext(async () => {
      await refreshUsSecurities({ fetchText: async () => FIXTURE, seenAt: "2026-06-25T00:00:00Z" });
      await expect(
        refreshUsSecurities({
          fetchText: async () => "garbage header only",
          seenAt: "2026-06-26T00:00:00Z",
        }),
      ).rejects.toThrow(/zero rows/);
      // Catalog untouched — nothing delisted.
      expect(countUsSecurities().active).toBe(3);
    });
  });

  it("ranks an exact symbol hit above name-contains matches", async () => {
    await withFreshContext(async () => {
      await refreshUsSecurities({ fetchText: async () => FIXTURE, seenAt: "2026-06-25T00:00:00Z" });
      // "VOO" matches the VOO symbol exactly; nothing else contains it.
      const hits = findUsSecurities({ query: "VOO" });
      expect(hits.items[0].symbol).toBe("VOO");
    });
  });
});

describe("bumpUsSymbolDemand", () => {
  it("increments view_count and stamps last_viewed_at (case-insensitive)", async () => {
    await withFreshContext(async () => {
      await refreshUsSecurities({ fetchText: async () => FIXTURE, seenAt: "2026-06-25T00:00:00Z" });
      expect(getUsSecurity("AAPL")?.viewCount).toBe(0);

      bumpUsSymbolDemand("aapl", "2026-06-26T10:00:00Z"); // lowercase resolves
      bumpUsSymbolDemand("AAPL", "2026-06-26T11:00:00Z");

      const row = getUsSecurity("AAPL");
      expect(row?.viewCount).toBe(2);
      expect(row?.lastViewedAt).toBe("2026-06-26T11:00:00Z");
    });
  });

  it("is a no-op for an uncatalogued symbol", async () => {
    await withFreshContext(async () => {
      await refreshUsSecurities({ fetchText: async () => FIXTURE, seenAt: "2026-06-25T00:00:00Z" });
      expect(() => bumpUsSymbolDemand("NOTLISTED")).not.toThrow();
      expect(countUsSecurities().active).toBe(3);
    });
  });
});
