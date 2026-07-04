// Unit tests for lib/market/providers/edgar-nport.ts
//
// Covers the pure logic: NPORT-P XML parsing (the part that historically broke
// when only synthetic data was tested) and the conservative master-name matcher.
// The network fetch (fetchNportHoldings) is validated by live integration check,
// not unit-mocked here.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetMfTickerMapCache,
  EDGAR_FUNDS,
  fetchEtfHoldings,
  loadMfTickerMap,
  matchEdgarFund,
  parseNportXml,
  resolveEtfFund,
} from "./edgar-nport";

// A trimmed but structurally-faithful NPORT-P primary_doc.xml: a header with
// repPdDate, then three holdings — deliberately out of weight order, one
// without an ISIN, one cash-like with cusip N/A — to exercise sort, top-N,
// the isin attribute, and the N/A cusip guard.
const SAMPLE_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <formData>
    <genInfo>
      <repPdDate>2026-01-31</repPdDate>
      <seriesId>S000004310</seriesId>
    </genInfo>
    <invstOrSecs>
      <invstOrSec>
        <name>Apple Inc.</name>
        <title>Apple Inc.</title>
        <cusip>037833100</cusip>
        <identifiers><isin value="US0378331005"/></identifiers>
        <valUSD>500000000.00</valUSD>
        <pctVal>7.25</pctVal>
        <assetCat>EC</assetCat>
        <invCountry>US</invCountry>
      </invstOrSec>
      <invstOrSec>
        <name>NVIDIA Corp</name>
        <title>NVIDIA Corp</title>
        <cusip>67066G104</cusip>
        <identifiers><isin value="US67066G1040"/></identifiers>
        <valUSD>900000000.00</valUSD>
        <pctVal>9.04</pctVal>
        <assetCat>EC</assetCat>
      </invstOrSec>
      <invstOrSec>
        <name>Cash Collateral USD</name>
        <title>Cash Collateral</title>
        <cusip>N/A</cusip>
        <valUSD>1000000.00</valUSD>
        <pctVal>0.02</pctVal>
        <assetCat>STIV</assetCat>
      </invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>`;

describe("edgar-nport", () => {
  describe("parseNportXml", () => {
    it("extracts the report-period date", () => {
      expect(parseNportXml(SAMPLE_XML).asOfDate).toBe("2026-01-31");
    });

    it("sorts holdings by weight descending", () => {
      const { holdings } = parseNportXml(SAMPLE_XML);
      expect(holdings.map((h) => h.name)).toEqual([
        "NVIDIA Corp",
        "Apple Inc.",
        "Cash Collateral USD",
      ]);
      expect(holdings[0].weightPct).toBe(9.04);
    });

    it("reads the ISIN attribute and maps the asset-category code", () => {
      const apple = parseNportXml(SAMPLE_XML).holdings.find((h) => h.name === "Apple Inc.");
      expect(apple?.isin).toBe("US0378331005");
      expect(apple?.cusip).toBe("037833100");
      expect(apple?.assetClass).toBe("Equity (common)");
      expect(apple?.country).toBe("US");
    });

    it("identifies a derivative by its underlying, keeping the counterparty separate", () => {
      // A leveraged single-stock ETF's swap: NPORT names it by the COUNTERPARTY in
      // the top-level <name> ("Cowen Group"), while the UNDERLYING lives nested in
      // <derivativeInfo>…<descRefInstrmnt>. Verbatim shape from a real AAPB filing.
      const SWAP_XML = `<edgarSubmission><formData><invstOrSec>
        <name>Cowen Group</name>
        <title>AAPL EQUITY SWAP 1</title>
        <cusip>N/A</cusip>
        <identifiers><other otherDesc="INTERNAL IDENTIFIER" value="AAPL_TRSL_1"/></identifiers>
        <pctVal>199.7316726511</pctVal>
        <assetCat>DE</assetCat>
        <invCountry>US</invCountry>
        <derivativeInfo><swapDeriv derivCat="SWP">
          <counterparties>
            <counterpartyName>Cowen Group</counterpartyName>
            <counterpartyLei>549300UTZB77CD3NCJ97</counterpartyLei>
          </counterparties>
          <descRefInstrmnt><otherRefInst>
            <issuerName>Apple, Inc.</issuerName>
            <issueTitle>Apple, Inc.</issueTitle>
            <identifiers><isin value="US0378331005"/></identifiers>
          </otherRefInst></descRefInstrmnt>
        </swapDeriv></derivativeInfo>
      </invstOrSec></formData></edgarSubmission>`;
      const [swap] = parseNportXml(SWAP_XML).holdings;
      expect(swap.name).toBe("Apple, Inc."); // the underlying, not "Cowen Group"
      expect(swap.isin).toBe("US0378331005"); // the underlying's ISIN → resolves to AAPL
      expect(swap.counterparty).toBe("Cowen Group"); // kept as a separate fact
      expect(swap.assetClass).toBe("Equity derivative");
      expect(swap.weightPct).toBeCloseTo(199.73, 1);
    });

    it("labels a multi-name basket swap instead of passing off its first leg", () => {
      // A basket swap references several <otherRefInst>; the flat tag/isin regexes
      // only see the first, so it must read as a basket (with its leg count), not as
      // just "Apple, Inc.", and must not resolve to leg #1's ISIN.
      const BASKET = `<edgarSubmission><formData><invstOrSec>
        <name>Goldman Sachs</name><cusip>N/A</cusip>
        <pctVal>50.0</pctVal><assetCat>DE</assetCat>
        <derivativeInfo><swapDeriv derivCat="SWP">
          <counterparties><counterpartyName>Goldman Sachs</counterpartyName></counterparties>
          <descRefInstrmnt>
            <otherRefInst><issueTitle>Apple, Inc.</issueTitle>
              <identifiers><isin value="US0378331005"/></identifiers></otherRefInst>
            <otherRefInst><issueTitle>Microsoft Corp</issueTitle>
              <identifiers><isin value="US5949181045"/></identifiers></otherRefInst>
            <otherRefInst><issueTitle>NVIDIA Corp</issueTitle>
              <identifiers><isin value="US67066G1040"/></identifiers></otherRefInst>
          </descRefInstrmnt>
        </swapDeriv></derivativeInfo>
      </invstOrSec></formData></edgarSubmission>`;
      const [b] = parseNportXml(BASKET).holdings;
      expect(b.name).toBe("Basket (3 holdings)");
      expect(b.isin).toBeNull(); // don't mis-resolve a basket to one leg
      expect(b.counterparty).toBe("Goldman Sachs");
    });

    it("names an index swap by its index (not a constituent)", () => {
      const IDX = `<edgarSubmission><formData><invstOrSec>
        <name>Citibank</name><pctVal>300.0</pctVal><assetCat>DE</assetCat>
        <derivativeInfo><swapDeriv derivCat="SWP">
          <counterparties><counterpartyName>Citibank</counterpartyName></counterparties>
          <descRefInstrmnt><indexBasketInfo>
            <indexName>NASDAQ-100 Index</indexName><indexIdentifier>NDX</indexIdentifier>
          </indexBasketInfo></descRefInstrmnt>
        </swapDeriv></derivativeInfo>
      </invstOrSec></formData></edgarSubmission>`;
      expect(parseNportXml(IDX).holdings[0].name).toBe("NASDAQ-100 Index");
    });

    it("decodes XML entities in names (S&P, AT&T)", () => {
      const XML = `<edgarSubmission><formData><invstOrSec>
        <name>S&amp;P Global Inc.</name><title>S&amp;P Global Inc.</title>
        <pctVal>1.0</pctVal><assetCat>EC</assetCat>
      </invstOrSec></formData></edgarSubmission>`;
      expect(parseNportXml(XML).holdings[0].name).toBe("S&P Global Inc.");
    });

    it("leaves counterparty unset for a direct (non-derivative) holding", () => {
      const apple = parseNportXml(SAMPLE_XML).holdings.find((h) => h.name === "Apple Inc.");
      expect(apple?.counterparty ?? null).toBeNull();
    });

    it("nulls a missing ISIN and an N/A cusip", () => {
      const cash = parseNportXml(SAMPLE_XML).holdings.find((h) => h.name.startsWith("Cash"));
      expect(cash?.isin).toBeNull();
      expect(cash?.cusip).toBeNull();
      expect(cash?.assetClass).toBe("Short-term investment");
    });

    it("honors topN but reports the full totalCount", () => {
      const full = parseNportXml(SAMPLE_XML).holdings.length;
      const capped = parseNportXml(SAMPLE_XML, 1);
      expect(capped.holdings).toHaveLength(1);
      expect(capped.holdings[0].name).toBe("NVIDIA Corp");
      // Truncated for storage, but the total (used by tracks_index) is preserved.
      expect(capped.totalCount).toBe(full);
      expect(full).toBeGreaterThan(1);
    });

    it("returns an empty result for non-NPORT junk", () => {
      const r = parseNportXml("<html>not a filing</html>");
      expect(r.holdings).toEqual([]);
      expect(r.asOfDate).toBeNull();
    });
  });

  describe("resolveEtfFund (any-ETF ticker → EDGAR series)", () => {
    const MF_TICKERS = {
      fields: ["cik", "seriesId", "classId", "symbol"],
      data: [
        [36405, "S000002839", "C000092055", "VOO"],
        [1067839, "S000101292", "C000271435", "QQQ"],
      ],
    };

    afterEach(() => {
      __resetMfTickerMapCache();
      vi.restoreAllMocks();
    });

    function mockMfFetch() {
      vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
        if (String(url).includes("company_tickers_mf.json")) {
          return new Response(JSON.stringify(MF_TICKERS), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch);
    }

    it("maps any ETF ticker (case-insensitive) to its registrant CIK + seriesId", async () => {
      mockMfFetch();
      expect(await resolveEtfFund("voo")).toEqual({
        cik: "36405",
        seriesId: "S000002839",
        isin: "",
        displayName: "VOO",
      });
      expect((await loadMfTickerMap()).get("QQQ")?.seriesId).toBe("S000101292");
    });

    it("resolves to null for a non-fund / UIT ticker (e.g. SPY) and returns empty holdings", async () => {
      mockMfFetch();
      expect(await resolveEtfFund("SPY")).toBeNull();
      // Unresolvable → empty result, flagged "unresolved" (cacheable), no archives hit.
      expect(await fetchEtfHoldings("SPY")).toEqual({
        asOfDate: null,
        holdings: [],
        totalCount: 0,
        status: "unresolved",
      });
    });

    it("reports a failed ticker-directory fetch as 'error', not 'unresolved' (so it isn't cached as empty)", async () => {
      // SEC outage/rate-limit → the directory fetch fails → the map is empty. A real
      // ETF like VOO must NOT be flagged "unresolved" (which the job caches as empty,
      // wiping real holdings); it must be transient "error" so the next run retries.
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      );
      expect(await fetchEtfHoldings("VOO")).toEqual({
        asOfDate: null,
        holdings: [],
        totalCount: 0,
        status: "error",
      });
    });
  });

  describe("matchEdgarFund", () => {
    it("maps an S&P 500 master name to IVV", () => {
      expect(matchEdgarFund("iShares Core S&P 500 ETF")).toBe("US4642872265");
    });

    it("maps an MSCI ACWI master to ACWI (distinct keyword)", () => {
      expect(matchEdgarFund("iShares MSCI ACWI ETF")).toBe("US4642863926");
    });

    it("maps Invesco QQQ Trust to QQQ but Invesco NASDAQ 100 ETF to QQQM", () => {
      expect(matchEdgarFund("Invesco QQQ Trust, Series 1")).toBe("US46090E1038");
      expect(matchEdgarFund("Invesco NASDAQ 100 ETF")).toBe("US46138G6492");
    });

    it("returns null for masters not in the registry", () => {
      expect(matchEdgarFund("SPDR Gold Trust")).toBeNull();
      expect(matchEdgarFund("iShares Expanded Tech Sector ETF")).toBeNull();
      expect(matchEdgarFund("PIMCO GIS Income Fund")).toBeNull();
    });

    it("is case-insensitive", () => {
      expect(matchEdgarFund("ISHARES MSCI ACWI ETF")).toBe("US4642863926");
    });
  });

  describe("EDGAR_FUNDS registry", () => {
    it("every entry is keyed by its own isin and has a primaryKeyword + ids", () => {
      for (const [key, ref] of Object.entries(EDGAR_FUNDS)) {
        expect(ref.isin, `${key} isin mismatch`).toBe(key);
        expect(ref.primaryKeyword, `${key} missing primaryKeyword`).toBeTruthy();
        expect(ref.cik, `${key} missing cik`).toBeTruthy();
        expect(ref.seriesId, `${key} missing seriesId`).toMatch(/^S\d+$/);
      }
    });
  });
});
