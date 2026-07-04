import type { Config } from "drizzle-kit";

// app.db — system of record. Migrations live in lib/db/migrations/app.
export default {
  schema: "./lib/db/schema/app.ts",
  out: "./lib/db/migrations/app",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DB_PATH ?? "data/app.db",
  },
} satisfies Config;
