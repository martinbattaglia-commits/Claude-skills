import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSecThailandCache,
  __setSecThailandRetry,
  secThailandProvider,
} from "./sec-thailand";

// All test data is synthetic. No real Thai fund codes appear in this file.
const FAKE_PROJ_ID_MAIN = "proj-main-fund";
const FAKE_PROJ_ID_PARENT = "proj-parent-with-classes";

function envelope<T>(items: T[], next_cursor = ""): string {
  return JSON.stringify({
    message: "success",
    page_size: 100,
    next_cursor,
    items,
  });
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Stub a SEC API that knows two synthetic funds:
 *   EX-MAIN-FUND  — no share classes (fund_class_name === "main")
 *   EX-PARENT     — has two share classes: EX-CLASS-A, EX-CLASS-B
 */
function makeFetchStub() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);

    if (u.pathname === "/v2/fund/general-info/profiles") {
      const cls = u.searchParams.get("fund_class_name");
      const proj = u.searchParams.get("project_info");

      if (cls) {
        if (cls === "EX-CLASS-A") {
          return new Response(
            envelope([
              {
                unique_id: "amc-1",
                proj_id: FAKE_PROJ_ID_PARENT,
                proj_abbr_name: "EX-PARENT",
                proj_name_en: "Example Parent Fund",
                fund_class_name: "EX-CLASS-A",
                fund_status: "Registered",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (cls === "EX-CLASS-B") {
          return new Response(
            envelope([
              {
                unique_id: "amc-1",
                proj_id: FAKE_PROJ_ID_PARENT,
                proj_abbr_name: "EX-PARENT",
                proj_name_en: "Example Parent Fund",
                fund_class_name: "EX-CLASS-B",
                fund_status: "Registered",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(envelope([]), { status: 200 });
      }

      if (proj) {
        if (proj === "EX-MAIN-FUND") {
          return new Response(
            envelope([
              {
                unique_id: "amc-2",
                proj_id: FAKE_PROJ_ID_MAIN,
                proj_abbr_name: "EX-MAIN-FUND",
                proj_name_en: "Example Main Fund",
                fund_class_name: "main",
                fund_status: "Registered",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (proj === "EX-PARENT") {
          return new Response(
            envelope([
              {
                unique_id: "amc-1",
                proj_id: FAKE_PROJ_ID_PARENT,
                proj_abbr_name: "EX-PARENT",
                fund_class_name: "EX-CLASS-A",
              },
              {
                unique_id: "amc-1",
                proj_id: FAKE_PROJ_ID_PARENT,
                proj_abbr_name: "EX-PARENT",
                fund_class_name: "EX-CLASS-B",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(envelope([]), { status: 200 });
      }

      return new Response(envelope([]), { status: 200 });
    }

    if (u.pathname === "/v2/fund/daily-info/nav") {
      const projId = u.searchParams.get("proj_id");
      const className = u.searchParams.get("fund_class_name");
      const start = u.searchParams.get("start_nav_date") ?? "";
      const end = u.searchParams.get("end_nav_date") ?? "";
      const dates = dateRange(start, end);

      const matchesMainProject = projId === FAKE_PROJ_ID_MAIN && !className;
      const matchesClassA = projId === FAKE_PROJ_ID_PARENT && className === "EX-CLASS-A";

      if (!matchesMainProject && !matchesClassA) {
        return new Response(envelope([]), { status: 200 });
      }

      const items = dates
        .filter((d) => {
          const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
          return dow !== 0 && dow !== 6;
        })
        .map((d) => ({
          proj_id: projId,
          unique_id: matchesMainProject ? "amc-2" : "amc-1",
          fund_class_name: matchesMainProject ? "main" : className,
          nav_date: d,
          last_val: 10 + Number(d.slice(-2)) / 100,
          net_asset: 1_000_000,
        }));
      return new Response(envelope(items), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  });
}

describe("sec-thailand provider", () => {
  beforeEach(() => {
    __resetSecThailandCache();
    // Zero out throttle + backoff so the rate gate and retry loop don't incur
    // real-time waits during tests (Date is faked but setTimeout is not).
    __setSecThailandRetry({ minIntervalMs: 0, baseDelayMs: 0 });
    process.env.SEC_API_KEY = "test-key-synthetic";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-22T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.SEC_API_KEY;
  });

  it("matches only the thai_mutual_fund source", () => {
    expect(secThailandProvider.matches("thai_mutual_fund", "anything")).toBe(true);
    expect(secThailandProvider.matches("market", "AAPL")).toBe(false);
    expect(secThailandProvider.matches("", "EX-CLASS-A")).toBe(false);
  });

  it("resolves a share-class code via fund_class_name lookup", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    const result = await secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d");

    expect(result.quote.name).toBe("Example Parent Fund");
    expect(result.quote.ticker).toBe("EX-CLASS-A");
    expect(result.quote.currency).toBe("THB");
    expect(result.series.length).toBeGreaterThan(0);

    // resolveSymbol stopped at the class lookup; project_info was never called.
    const urls = fetchStub.mock.calls.map((c) => (c[0] as URL | string).toString());
    const projectInfoCalls = urls.filter((u) => u.includes("project_info="));
    expect(projectInfoCalls.length).toBe(0);
  });

  it("resolves a parent fund without share classes via project_info fallback", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    const result = await secThailandProvider.fetchSeries("EX-MAIN-FUND", "1mo", "1d");

    expect(result.quote.name).toBe("Example Main Fund");
    expect(result.series.length).toBeGreaterThan(0);

    const urls = fetchStub.mock.calls.map((c) => (c[0] as URL | string).toString());
    expect(urls.some((u) => u.includes("fund_class_name=EX-MAIN-FUND"))).toBe(true);
    expect(urls.some((u) => u.includes("project_info=EX-MAIN-FUND"))).toBe(true);
  });

  it("errors helpfully when a parent fund has multiple share classes", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    await expect(secThailandProvider.fetchSeries("EX-PARENT", "1mo", "1d")).rejects.toThrow(
      /parent fund with multiple share classes.*EX-CLASS-A.*EX-CLASS-B/s,
    );
  });

  it("is case-insensitive on the user-typed code", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    const result = await secThailandProvider.fetchSeries("ex-class-a", "1mo", "1d");
    expect(result.quote.name).toBe("Example Parent Fund");
  });

  it("throws a clear error when the fund code is unknown", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    await expect(secThailandProvider.fetchSeries("DOES-NOT-EXIST", "1mo", "1d")).rejects.toThrow(
      /Unknown Thai fund code/,
    );
  });

  it("throws when SEC_API_KEY is missing", async () => {
    delete process.env.SEC_API_KEY;
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    await expect(secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d")).rejects.toThrow(
      /SEC_API_KEY is not set/,
    );
  });

  it("propagates 401 as ProviderError", async () => {
    const fetchStub = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchStub);

    await expect(secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d")).rejects.toThrow(
      /rejected the subscription key/,
    );
  });

  it("retries a persistent 421 rate-limit then gives up after maxRetries", async () => {
    __setSecThailandRetry({ maxRetries: 3, baseDelayMs: 0, minIntervalMs: 0 });
    const fetchStub = vi.fn(async () => new Response("too many", { status: 421 }));
    vi.stubGlobal("fetch", fetchStub);

    await expect(secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d")).rejects.toThrow(
      /still failing after 3 retries \(421\)/,
    );
    // 1 initial attempt + 3 retries = 4 calls.
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it("recovers when a transient 429 is followed by success", async () => {
    const base = makeFetchStub();
    let firstCall = true;
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      if (firstCall) {
        firstCall = false;
        return new Response("rate limited", { status: 429 });
      }
      return base(input);
    });
    vi.stubGlobal("fetch", fetchStub);

    // The initial 429 is retried, then the request succeeds.
    const result = await secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d");
    expect(result.quote.name).toBe("Example Parent Fund");
    expect(firstCall).toBe(false); // the 429 path was exercised
  });

  it("caches resolved tickers across calls", async () => {
    const fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    await secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d");
    const callsAfterFirst = fetchStub.mock.calls.length;
    await secThailandProvider.fetchSeries("EX-CLASS-A", "1mo", "1d");
    const callsAfterSecond = fetchStub.mock.calls.length;

    // The second call should hit only the NAV endpoint (no re-resolution).
    expect(callsAfterSecond - callsAfterFirst).toBe(1);
  });
});
