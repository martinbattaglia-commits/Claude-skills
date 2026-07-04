import { describe, expect, it } from "vitest";
import { classifyBenchmarkString, deriveFundFacets } from "./fund-facets";

// Benchmark strings below are real shapes from the live SEC factsheet data
// (top-frequency rows), so the pattern table is asserted against reality.

describe("classifyBenchmarkString", () => {
  it("classifies Thai market benchmarks", () => {
    expect(
      classifyBenchmarkString("ดัชนีผลตอบแทนรวมตลาดหลักทรัพย์แห่งประเทศไทย (SET TRI)"),
    ).toMatchObject({ region: "thailand", indexFamily: "SET" });
    expect(classifyBenchmarkString("ดัชนีผลตอบแทนรวม SET 50 (SET50 TRI)")).toMatchObject({
      region: "thailand",
      indexFamily: "SET50",
    });
    expect(
      classifyBenchmarkString("ดัชนีผลตอบแทนรวม SET High Dividend 30 (SETHD TRI)"),
    ).toMatchObject({ region: "thailand", indexFamily: "SETHD" });
    expect(
      classifyBenchmarkString("ผลตอบแทนรวมสุทธิของดัชนีพันธบัตรรัฐบาลอายุ 1 - 3 ปี ของสมาคมตลาดตราสารหนี้ไทย"),
    ).toMatchObject({ region: "thailand" });
    expect(
      classifyBenchmarkString(
        "อัตราดอกเบี้ยเงินฝากประจำ 1 ปี วงเงินน้อยกว่า 5 ล้านบาท เฉลี่ยของ 3 ธนาคารพาณิชย์ขนาดใหญ่",
      ),
    ).toMatchObject({ region: "thailand" });
  });

  it("classifies Thai sector indices with region + sector", () => {
    expect(
      classifyBenchmarkString("ดัชนีผลตอบแทนรวมธุรกิจพลังงานและสาธารณูปโภค (ENERG TRI)"),
    ).toMatchObject({ region: "thailand", sector: "energy" });
    expect(
      classifyBenchmarkString("ดัชนีผลตอบแทนรวมธุรกิจเทคโนโลยีสารสนเทศและการสื่อสาร (ICT TRI)"),
    ).toMatchObject({ region: "thailand", sector: "technology" });
    expect(classifyBenchmarkString("ดัชนีผลตอบแทนรวมธุรกิจธนาคาร (BANK TRI)")).toMatchObject({
      region: "thailand",
      sector: "financials",
    });
  });

  it("classifies global / US / country index families", () => {
    expect(classifyBenchmarkString("ดัชนี S&P 500 Total Return")).toMatchObject({
      region: "us",
      indexFamily: "S&P 500",
    });
    expect(classifyBenchmarkString("ดัชนี NASDAQ-100 Total Return")).toMatchObject({
      region: "us",
      indexFamily: "NASDAQ-100",
    });
    expect(classifyBenchmarkString("ดัชนี MSCI ACWI Net Total Return USD")).toMatchObject({
      region: "global",
      indexFamily: "MSCI ACWI",
    });
    expect(classifyBenchmarkString("MSCI World Net Total Return USD Index")).toMatchObject({
      region: "global",
      indexFamily: "MSCI World",
    });
    expect(classifyBenchmarkString("TOPIX Total Return Index")).toMatchObject({
      region: "japan",
      indexFamily: "TOPIX",
    });
    expect(classifyBenchmarkString("ดัชนี MSCI Emerging Markets India Net TR (USD)")).toMatchObject({
      region: "india",
    });
    expect(classifyBenchmarkString("ดัชนี VN30 Total Return")).toMatchObject({
      region: "vietnam",
      indexFamily: "VN30",
    });
    expect(classifyBenchmarkString("ดัชนี MSCI AC Asia (ex Japan) net TR USD")).toMatchObject({
      region: "asia",
    });
    expect(
      classifyBenchmarkString("Bloomberg GLOBAL AGGREGATE Total RETURN INDEX VALUE Hedged USD"),
    ).toMatchObject({ region: "global", indexFamily: "Bloomberg Global Aggregate" });
  });

  it("classifies commodity benchmarks as sector-only (no region claim)", () => {
    const gold = classifyBenchmarkString("ดัชนีราคาทองคำในสกุลเงินดอลลาร์สหรัฐ (LBMA Gold Price AM)");
    expect(gold.sector).toBe("gold");
    expect(gold.region).toBeUndefined();
    expect(
      classifyBenchmarkString("ดัชนี DBIQ Optimum Yield Crude Oil Index Total Return").sector,
    ).toBe("commodities");
  });

  it("returns nothing for no-signal benchmarks", () => {
    expect(classifyBenchmarkString("ไม่มี")).toEqual({});
    expect(classifyBenchmarkString("ผลการดำเนินงานของกองทุนรวมหลัก")).toEqual({});
  });
});

describe("deriveFundFacets", () => {
  it("claims a region only when all benchmark rows agree", () => {
    const agree = deriveFundFacets({
      benchmarks: ["ดัชนี S&P 500 Total Return", "FTSE 3 Month US T-Bill Index"],
    });
    expect(agree.regionFocus).toBe("us");
    expect(agree.regionFocusSource).toBe("benchmark");

    // A 50/50 Thai + global blend claims NO region.
    const blend = deriveFundFacets({
      benchmarks: [
        "ดัชนีผลตอบแทนรวมตลาดหลักทรัพย์แห่งประเทศไทย (SET TRI)",
        "ดัชนี MSCI ACWI Net Total Return USD",
      ],
    });
    expect(blend.regionFocus).toBeNull();
  });

  it("falls back to the domestic invest flag, then the name gazetteer", () => {
    const domestic = deriveFundFacets({ benchmarks: [], investRegion: "domestic" });
    expect(domestic).toMatchObject({ regionFocus: "thailand", regionFocusSource: "invest-flag" });

    // Feeder benchmarked to "the master fund" → master name carries the region.
    const feeder = deriveFundFacets({
      benchmarks: ["ผลการดำเนินงานของกองทุนรวมหลัก"],
      englishName: "Example Equity Fund",
      feederMasterFund: "EXAMPLE JAPAN EQUITY UCITS",
      investRegion: "foreign",
    });
    expect(feeder).toMatchObject({ regionFocus: "japan", regionFocusSource: "name" });

    // Thai name carries the region too.
    const thaiName = deriveFundFacets({
      benchmarks: [],
      thaiName: "กองทุนเปิดตัวอย่าง หุ้นเวียดนาม",
      investRegion: "foreign",
    });
    expect(thaiName).toMatchObject({ regionFocus: "vietnam", regionFocusSource: "name" });
  });

  it("catches bare EURO index names but not a neuro thematic fund", () => {
    expect(
      deriveFundFacets({
        benchmarks: [],
        englishName: "EXAMPLE EURO 50 Fund",
        investRegion: "foreign",
      }),
    ).toMatchObject({ regionFocus: "europe", regionFocusSource: "name" });
    expect(
      deriveFundFacets({
        benchmarks: [],
        englishName: "Example Neuroscience Fund",
        investRegion: "foreign",
      }).regionFocus,
    ).toBeNull();
  });

  it("prefers a specific country over generic asia/global words in names", () => {
    const facets = deriveFundFacets({
      benchmarks: [],
      englishName: "Example India Asia Opportunities",
      investRegion: "foreign",
    });
    expect(facets.regionFocus).toBe("india");
  });

  it("derives sector from benchmarks first, names second; index family from benchmarks only", () => {
    const fromBench = deriveFundFacets({
      benchmarks: ["ดัชนีผลตอบแทนรวมธุรกิจพลังงานและสาธารณูปโภค (ENERG TRI)"],
      englishName: "Example Health Fund", // benchmark wins over the name
    });
    expect(fromBench.sectorFocus).toBe("energy");

    const fromName = deriveFundFacets({
      benchmarks: [],
      englishName: "Example Global Healthcare Fund",
      investRegion: "foreign",
    });
    expect(fromName.sectorFocus).toBe("healthcare");
    expect(fromName.indexFamily).toBeNull(); // never claimed from the fund's own name
  });

  it("claims the index family from the master fund's name — a feeder tracks its master", () => {
    // SEC profile master-fund field.
    const fromProfile = deriveFundFacets({
      benchmarks: ["ผลการดำเนินงานของกองทุนรวมหลัก"],
      englishName: "Example US Equity Index Fund", // own name names no index — by design
      feederMasterFund: "iShares Core S&P 500 ETF",
      investRegion: "foreign",
    });
    expect(fromProfile.indexFamily).toBe("S&P 500");

    // Curated look-through mapping fills in when the profile field is empty.
    const fromCurated = deriveFundFacets({
      benchmarks: [],
      englishName: "Example Nasdaq Tracker Fund",
      curatedMasterName: "Invesco NASDAQ 100 UCITS ETF",
      investRegion: "foreign",
    });
    expect(fromCurated.indexFamily).toBe("NASDAQ-100");

    // A declared benchmark still outranks the master name.
    const benchmarkWins = deriveFundFacets({
      benchmarks: ["ดัชนี MSCI World Net Total Return"],
      feederMasterFund: "iShares Core S&P 500 ETF",
      investRegion: "foreign",
    });
    expect(benchmarkWins.indexFamily).toBe("MSCI World");

    // The fund's OWN name still never claims a family, even with "S&P 500" in it.
    const ownName = deriveFundFacets({
      benchmarks: [],
      englishName: "Example S&P 500 Opportunity Fund",
      investRegion: "foreign",
    });
    expect(ownName.indexFamily).toBeNull();

    // A master that names no index claims nothing.
    const noSignal = deriveFundFacets({
      benchmarks: [],
      feederMasterFund: "Example Global Allocation Fund",
      investRegion: "foreign",
    });
    expect(noSignal.indexFamily).toBeNull();
  });

  it("claims nothing when there is no signal", () => {
    expect(deriveFundFacets({ benchmarks: ["ไม่มี"] })).toEqual({
      regionFocus: null,
      regionFocusSource: null,
      sectorFocus: null,
      indexFamily: null,
    });
  });

  it("uses the AIMC snapshot as a gap-filler — fresh signals always win", () => {
    // The snapshot never updates again (v1 retires mid-2026), so a fresh
    // benchmark MUST override a stale AIMC code after a mandate change.
    const benchmarkWins = deriveFundFacets({
      benchmarks: ["TOPIX Total Return Index"],
      aimcCategory: "USEQ", // stale: fund was US Equity at snapshot time
    });
    expect(benchmarkWins).toMatchObject({ regionFocus: "japan", regionFocusSource: "benchmark" });

    // AIMC beats the weakest source (names) when nothing fresh speaks.
    const fillsGap = deriveFundFacets({
      benchmarks: ["ผลการดำเนินงานของกองทุนรวมหลัก"],
      aimcCategory: "USEQ",
      englishName: "Example Asia Fund",
      investRegion: "foreign",
    });
    expect(fillsGap).toMatchObject({ regionFocus: "us", regionFocusSource: "aimc" });

    // AIMC sector codes carry sector; SET50 code carries the index family.
    expect(deriveFundFacets({ benchmarks: [], aimcCategory: "CPM" }).sectorFocus).toBe("gold");
    expect(
      deriveFundFacets({ benchmarks: [], aimcCategory: "SET50", investRegion: "domestic" }),
    ).toMatchObject({ regionFocus: "thailand", indexFamily: "SET50" });

    // Unknown / allocation codes claim nothing — fall through to other sources.
    const unknown = deriveFundFacets({
      benchmarks: ["ดัชนี S&P 500 Total Return"],
      aimcCategory: "MIS",
    });
    expect(unknown).toMatchObject({ regionFocus: "us", regionFocusSource: "benchmark" });
  });
});
