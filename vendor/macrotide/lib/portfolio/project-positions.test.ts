import { describe, expect, it } from "vitest";
import { type ProjectionEvent, projectPositions } from "./project-positions";

// Synthetic data only (EXAMPLE-FUND-*), never real fund codes.
const A = "EXAMPLE-FUND-A";
const B = "EXAMPLE-FUND-B";

function ev(
  p: Partial<ProjectionEvent> & Pick<ProjectionEvent, "kind" | "amount">,
): ProjectionEvent {
  return { ticker: A, tradeDate: "2024-01-01", ...p };
}

describe("projectPositions — the three user flows", () => {
  it("flow #1 — full transaction history derives units + avg cost", () => {
    const rows = projectPositions([
      ev({
        kind: "buy",
        units: 100,
        amount: -1000,
        tradeDate: "2024-01-01",
        englishName: "Fund A",
      }),
      ev({ kind: "buy", units: 100, amount: -3000, tradeDate: "2024-02-01" }),
      ev({ kind: "sell", units: 50, amount: 1200, tradeDate: "2024-03-01" }),
    ]);
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a.ticker).toBe(A);
    expect(a.units).toBeCloseTo(150, 6);
    expect(a.avgCost).toBeCloseTo(20, 6); // (1000+3000)/200
    expect(a.costKnown).toBe(true);
    expect(a.englishName).toBe("Fund A"); // carried from the first event
    expect(a.acquiredOn).toBe("2024-01-01"); // earliest event
  });

  it("flow #2 — opening balance then forward", () => {
    const rows = projectPositions([
      ev({ kind: "opening", units: 100, pricePerUnit: 10, amount: -1000, tradeDate: "2024-01-01" }),
      ev({ kind: "buy", units: 50, amount: -750, tradeDate: "2024-04-01" }),
    ]);
    expect(rows[0].units).toBeCloseTo(150, 6);
    expect(rows[0].avgCost).toBeCloseTo(11.6667, 3); // (1000+750)/150
    expect(rows[0].costKnown).toBe(true);
    expect(rows[0].acquiredOn).toBe("2024-01-01");
  });

  it("flow #3 — periodic snapshots; the latest restatement wins", () => {
    const rows = projectPositions([
      ev({ kind: "snapshot", units: 100, pricePerUnit: 10, amount: 0, tradeDate: "2024-01-01" }),
      ev({ kind: "snapshot", units: 130, amount: 0, tradeDate: "2024-06-01" }), // value-only
    ]);
    expect(rows[0].units).toBeCloseTo(130, 6); // latest snapshot
    expect(rows[0].avgCost).toBeCloseTo(10, 6); // cost carried forward
    expect(rows[0].costKnown).toBe(true);
  });
});

describe("projectPositions — derived-row hygiene", () => {
  it("drops fully-exited positions (no zero-unit holding rows)", () => {
    const rows = projectPositions([
      ev({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      ev({ kind: "sell", units: 100, amount: 1200, tradeDate: "2024-02-01" }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("a units-but-no-cost position projects with avgCost null + costKnown false", () => {
    const rows = projectPositions([
      ev({ kind: "opening", units: 100, amount: 0, tradeDate: "2024-01-01" }),
    ]);
    expect(rows[0].units).toBeCloseTo(100, 6);
    expect(rows[0].avgCost).toBeNull();
    expect(rows[0].costKnown).toBe(false);
  });

  it("keeps positions independent and carries each ticker's identity", () => {
    const rows = projectPositions([
      ev({ ticker: A, kind: "buy", units: 10, amount: -100, quoteSource: "thai_mutual_fund" }),
      ev({
        ticker: B,
        kind: "buy",
        units: 5,
        amount: -250,
        quoteSource: "market",
        source: "Broker X",
      }),
    ]);
    const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));
    expect(byTicker[A].quoteSource).toBe("thai_mutual_fund");
    expect(byTicker[B].quoteSource).toBe("market");
    expect(byTicker[B].source).toBe("Broker X");
  });

  it("identity takes the latest non-empty value across events", () => {
    const rows = projectPositions([
      ev({
        kind: "buy",
        units: 10,
        amount: -100,
        tradeDate: "2024-01-01",
        englishName: "Old Name",
      }),
      ev({
        kind: "buy",
        units: 10,
        amount: -120,
        tradeDate: "2024-02-01",
        englishName: "New Name",
      }),
    ]);
    expect(rows[0].englishName).toBe("New Name");
  });
});
