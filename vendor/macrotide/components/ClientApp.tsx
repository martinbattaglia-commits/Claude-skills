"use client";

import dynamic from "next/dynamic";
import { SWRConfig } from "swr";

// The App reads window.innerWidth and switches between mobile / tablet / desktop
// shells. Skipping SSR keeps the viewport hook and SVG gradient ids simple and
// eliminates hydration-mismatch risk for a personal client app where SEO
// doesn't matter. ssr: false is only permitted inside a Client Component.
// The `loading` shell paints immediately so the bundle download isn't a blank
// page.
const App = dynamic(() => import("@/components/App").then((m) => m.App), {
  ssr: false,
  loading: () => <div className="app-boot" role="status" aria-label="Loading" />,
});

// Focus revalidation stays on for freshness but is throttled hard: a tab
// refocus otherwise refires every active SWR key at once (4–6 requests on
// Portfolio alone), and quotes/NAV come from a 24h server cache anyway, so
// sub-5-minute focus freshness buys nothing.
const swrConfig = {
  focusThrottleInterval: 5 * 60_000,
  dedupingInterval: 10_000,
};

export default function ClientApp({ isDemo }: { isDemo: boolean }) {
  return (
    <SWRConfig value={swrConfig}>
      <App isDemo={isDemo} />
    </SWRConfig>
  );
}
