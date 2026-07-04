// Smoke-test the Thai SEC Open API provider against a real subscription key.
//
// Usage:
//   1. Subscribe at https://secopendata.sec.or.th/sec-open-apis (one
//      subscription covers all six product groups).
//   2. Paste either the Primary or Secondary key into .env.local:
//        SEC_API_KEY=...
//   3. Run:
//        npm run smoke:sec -- <FUND-CODE>
//
// Loads .env.local via tsx's `--env-file` flag (configured in package.json).
//
// Typical end-to-end latency is ~2 s (share-class lookup + date-range NAV
// fetch, each one paginated v2 call).

import { secThailandProvider } from "../lib/market/providers/sec-thailand";

async function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error("Usage: npm run smoke:sec -- <FUND-CODE>");
    console.error("Example: npm run smoke:sec -- K-FIXED-A");
    process.exit(2);
  }

  console.log(`Resolving "${ticker}" via Thai SEC Open API…`);

  const start = Date.now();
  try {
    const result = await secThailandProvider.fetchSeries(ticker, "1mo", "1d");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✓ Success in ${elapsed}s`);
    console.log(`  Name:     ${result.quote.name}`);
    console.log(`  Ticker:   ${result.quote.ticker}`);
    console.log(`  Currency: ${result.quote.currency}`);
    console.log(`  Latest:   ${result.quote.price}`);
    console.log(`  As of:    ${new Date(result.quote.asOfUnix * 1000).toISOString()}`);
    console.log(`  Series:   ${result.series.length} data points`);
    if (result.series.length > 0) {
      const first = result.series[0];
      const last = result.series[result.series.length - 1];
      console.log(
        `            ${new Date(first.t * 1000).toISOString().slice(0, 10)} → ${first.close.toFixed(4)}`,
      );
      console.log(
        `            ${new Date(last.t * 1000).toISOString().slice(0, 10)} → ${last.close.toFixed(4)}`,
      );
    }
  } catch (err) {
    console.error(`\n✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

void main();
