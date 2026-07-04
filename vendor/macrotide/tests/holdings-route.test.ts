import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/holdings/[id]/route";
import { runWithDbContext } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import type { Holding } from "@/lib/db/queries/holdings";
import { getHolding } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger } from "@/lib/db/queries/project-holdings";
import { fundCatalog, fundShareClasses, holdings as holdingsTable } from "@/lib/db/schema";
import { makeTestDbContext } from "@/tests/db-helpers";

const h = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function ctx() {
  if (!h.ctx) throw new Error("test DB context not set");
  return h.ctx;
}

vi.mock("@/lib/api/with-db", () => ({
  withDb: async <T>(fn: (c: unknown) => T | Promise<T>) => {
    const { runWithDbContext } = await import("@/lib/db/context");
    const c = ctx();
    return runWithDbContext(c, () => fn(c));
  },
}));

const BUCKET = {
  id: "b1",
  name: "Core",
  typeLabel: "Free",
  icon: "○",
  color: "#3b82f6",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

function seedCatalogFund(ticker: string) {
  ctx()
    .marketDb.insert(fundCatalog)
    .values({
      projId: `proj-${ticker}`,
      abbrName: ticker,
      thaiName: "Catalog Thai",
      englishName: "Catalog English",
      policyDescTh: "Catalog category",
      assetClass: "bond",
      investRegion: "domestic",
      currentTer: 0.25,
    })
    .run();
  ctx()
    .marketDb.insert(fundShareClasses)
    .values({ projId: `proj-${ticker}`, className: "main", ticker, currentTer: 0.25 })
    .run();
}

async function patch(id: number, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/holdings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: String(id) }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  h.ctx = makeTestDbContext();
  runWithDbContext(h.ctx, () => createBucket(BUCKET));
});

describe("PATCH /api/holdings/[id]", () => {
  it("ignores catalog-owned metadata fields for known funds", async () => {
    seedCatalogFund("EXAMPLE-FUND-A");
    const holding = runWithDbContext(ctx(), () =>
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "EXAMPLE-FUND-A",
        englishName: "App English",
        quoteSource: "thai_mutual_fund",
        units: 10,
        assetClass: "equity",
        ter: 1.5,
      }),
    ) as Holding | undefined;

    const { status, body } = await patch(holding?.id as number, {
      englishName: "User overwrite",
      thaiName: "User Thai",
      category: "User category",
      assetClass: "cash",
      region: "User region",
      ter: 9,
      source: "Broker A",
    });

    expect(status).toBe(200);
    expect(body.englishName).toBe("Catalog English");
    expect(body.assetClass).toBe("bond");
    expect(body.ter).toBe(0.25);
    expect(body.source).toBe("Broker A");

    const raw = ctx()
      .appDb.select()
      .from(holdingsTable)
      .where(eq(holdingsTable.id, holding?.id as number))
      .get();
    expect(raw?.englishName).toBe("App English");
    expect(raw?.assetClass).toBe("equity");
    expect(raw?.ter).toBe(1.5);
  });

  it("allows metadata fields for unknown custom holdings", async () => {
    const holding = runWithDbContext(ctx(), () =>
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "CUSTOM-1",
        englishName: "Custom",
        quoteSource: "manual",
        units: 10,
      }),
    ) as Holding | undefined;

    const { status, body } = await patch(holding?.id as number, {
      englishName: "Custom edited",
      thaiName: "Custom Thai",
      category: "Custom category",
      assetClass: "alternative",
      region: "Custom region",
      ter: 1.2,
    });

    expect(status).toBe(200);
    expect(body.englishName).toBe("Custom edited");
    expect(body.thaiName).toBe("Custom Thai");
    expect(body.category).toBe("Custom category");
    expect(body.assetClass).toBe("alternative");
    expect(body.region).toBe("Custom region");
    expect(body.ter).toBe(1.2);

    const read = runWithDbContext(ctx(), () => getHolding(holding?.id as number)) as
      | Holding
      | undefined;
    expect(read?.assetClass).toBe("alternative");
  });
});
