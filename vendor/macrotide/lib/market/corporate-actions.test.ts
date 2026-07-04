import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDividends, trailingYield } from "./corporate-actions";

const page = (divs: unknown[], nextToken: string | null = null) =>
  new Response(
    JSON.stringify({ corporate_actions: { cash_dividends: divs }, next_page_token: nextToken }),
    { status: 200 },
  );

describe("fetchDividends", () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY_ID = "k";
    process.env.ALPACA_API_SECRET_KEY = "s";
  });
  afterEach(() => {
    process.env.ALPACA_API_KEY_ID = undefined;
    process.env.ALPACA_API_SECRET_KEY = undefined;
    vi.restoreAllMocks();
  });

  it("returns fetched:false with no creds (feature simply off)", async () => {
    process.env.ALPACA_API_KEY_ID = undefined;
    expect(await fetchDividends("AAPL")).toEqual({ dividends: [], fetched: false });
  });

  it("parses, sorts newest-first, and follows pagination", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            {
              ex_date: "2025-02-10",
              payable_date: "2025-02-16",
              record_date: "2025-02-13",
              rate: 0.24,
            },
          ],
          "tok",
        ),
      )
      .mockResolvedValueOnce(page([{ ex_date: "2025-05-12", rate: 0.25, special: true }]));
    const r = await fetchDividends("AAPL", { fetchImpl: f as unknown as typeof fetch });
    expect(r.fetched).toBe(true);
    expect(r.dividends.map((d) => d.exDate)).toEqual(["2025-05-12", "2025-02-10"]);
    expect(r.dividends[0].special).toBe(true);
    expect(r.dividends[1].cashAmount).toBe(0.24);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("returns fetched:false on an HTTP failure (don't cache)", async () => {
    const f = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    expect(await fetchDividends("AAPL", { fetchImpl: f as unknown as typeof fetch })).toEqual({
      dividends: [],
      fetched: false,
    });
  });

  it("fetched:true with an empty list is a genuine non-payer", async () => {
    const f = vi.fn().mockResolvedValue(page([]));
    expect(await fetchDividends("NVDA", { fetchImpl: f as unknown as typeof fetch })).toEqual({
      dividends: [],
      fetched: true,
    });
  });
});

describe("trailingYield", () => {
  const divs = [
    { exDate: "2026-05-10", cashAmount: 0.25 },
    { exDate: "2026-02-10", cashAmount: 0.25 },
    { exDate: "2025-11-10", cashAmount: 0.24 },
    { exDate: "2025-08-10", cashAmount: 0.24 },
    { exDate: "2024-05-10", cashAmount: 0.2 }, // older than ~1y → excluded
  ];

  it("sums the trailing-12-month dividends over price", () => {
    expect(trailingYield(divs, 200, "2026-06-01")).toBeCloseTo(0.98 / 200, 6);
  });

  it("is null without a price or without TTM dividends", () => {
    expect(trailingYield(divs, null, "2026-06-01")).toBeNull();
    expect(trailingYield([], 200, "2026-06-01")).toBeNull();
  });
});
