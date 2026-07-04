import type { Config } from "drizzle-kit";

// market.db — regenerable market data. Migrations live in lib/db/migrations/market.
export default {
  schema: "./lib/db/schema/market.ts",
  out: "./lib/db/migrations/market",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.MARKET_DB_PATH ?? "data/market.db",
  },
} satisfies Config;
