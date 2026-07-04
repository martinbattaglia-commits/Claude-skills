import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.local.test.ts"],
    environment: "node",
    globals: false,
    // Isolate each worker's DB_PATH before any module (esp. lib/db/client.ts,
    // which migrates at import time) loads — see tests/setup-db.ts.
    setupFiles: ["tests/setup-db.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      "@macrotide/connector-sdk": resolve(__dirname, "packages/connector-sdk/src/index.ts"),
      "server-only": resolve(__dirname, "tests/shims/server-only.ts"),
    },
  },
});
