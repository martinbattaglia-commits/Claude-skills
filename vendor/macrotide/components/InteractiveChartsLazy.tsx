"use client";

// Lazy boundary for the recharts charts. recharts is the heaviest client
// dependency and used to load in the initial app bundle for every screen,
// chart or no chart. These wrappers code-split it behind React.lazy and hold
// layout with a chart-sized skeleton while the chunk loads (once per session).
// Import charts from here, not from ./InteractiveCharts, in app code.

import { type ComponentType, lazy, Suspense } from "react";
import { NAV_CHART_HEIGHT } from "@/lib/portfolio/adapter";
import type {
  AllocationDonut as AllocationDonutImpl,
  BreakdownChart as BreakdownChartImpl,
  DriftBars as DriftBarsImpl,
  NavChart as NavChartImpl,
} from "./InteractiveCharts";

// A lazy chunk request can 404 after a deploy: hashed chunk files don't
// survive the image rebuild, so a tab still running the previous build asks
// for a file that no longer exists. Retry once (transient network blips),
// then reload the page a single time to pick up the new build — the
// sessionStorage guard stops a reload loop if the chunk is broken for a
// deeper reason, and is cleared on success so the next deploy gets its own
// reload. Runs client-side only (the whole app is behind ssr:false).
const RELOADED_KEY = "macrotide-chunk-reloaded";

// biome-ignore lint/suspicious/noExplicitAny: mirrors React.lazy's own constraint
function lazyChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await load().catch(load);
      sessionStorage.removeItem(RELOADED_KEY);
      return mod;
    } catch (err) {
      if (sessionStorage.getItem(RELOADED_KEY) == null) {
        sessionStorage.setItem(RELOADED_KEY, "1");
        window.location.reload();
        // Stay suspended (skeleton showing) while the reload takes over.
        return new Promise<never>(() => {});
      }
      throw err;
    }
  });
}

const LazyNavChart = lazyChunk(() =>
  import("./InteractiveCharts").then((m) => ({ default: m.NavChart })),
);
const LazyAllocationDonut = lazyChunk(() =>
  import("./InteractiveCharts").then((m) => ({ default: m.AllocationDonut })),
);
const LazyDriftBars = lazyChunk(() =>
  import("./InteractiveCharts").then((m) => ({ default: m.DriftBars })),
);
const LazyBreakdownChart = lazyChunk(() =>
  import("./InteractiveCharts").then((m) => ({ default: m.BreakdownChart })),
);

function ChartFallback({ height }: { height?: number }) {
  return <div className="skeleton" aria-hidden style={{ height: height ?? NAV_CHART_HEIGHT }} />;
}

export function NavChart(props: Parameters<typeof NavChartImpl>[0]) {
  return (
    <Suspense fallback={<ChartFallback height={props.height} />}>
      <LazyNavChart {...props} />
    </Suspense>
  );
}

export function AllocationDonut(props: Parameters<typeof AllocationDonutImpl>[0]) {
  return (
    <Suspense fallback={<ChartFallback height={props.height} />}>
      <LazyAllocationDonut {...props} />
    </Suspense>
  );
}

export function DriftBars(props: Parameters<typeof DriftBarsImpl>[0]) {
  return (
    <Suspense fallback={<ChartFallback height={props.height} />}>
      <LazyDriftBars {...props} />
    </Suspense>
  );
}

export function BreakdownChart(props: Parameters<typeof BreakdownChartImpl>[0]) {
  return (
    <Suspense fallback={<ChartFallback height={props.height} />}>
      <LazyBreakdownChart {...props} />
    </Suspense>
  );
}
