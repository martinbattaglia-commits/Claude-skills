import { cookies } from "next/headers";
import ClientApp from "@/components/ClientApp";
import { DemoBanner } from "@/components/DemoBanner";
import Landing from "@/components/Landing";
import { DEMO_COOKIE } from "@/lib/api/with-db";
import { getSessionUser, isAuthRequired } from "@/lib/auth/session";

export default async function Home() {
  const store = await cookies();
  const hasDemoCookie = !!store.get(DEMO_COOKIE)?.value;

  // An authenticated session always wins over a stale demo cookie: resolve the
  // user first and only treat the request as demo when there's a demo cookie
  // AND no logged-in user.
  //
  // Modes:
  //  - AUTH_DISABLED=1: open access (single-user / dev). Render the owner app.
  //  - auth required + valid session: render as the owner (no banner), even if
  //    a demo cookie lingers.
  //  - auth required + demo cookie + no session: render as a demo session.
  //  - auth required + neither: show the public landing page.
  let isDemo = false;
  if (isAuthRequired()) {
    const user = await getSessionUser();
    if (!user) {
      if (!hasDemoCookie) return <Landing />;
      isDemo = true;
    }
  }

  return (
    <>
      {isDemo && <DemoBanner />}
      <ClientApp isDemo={isDemo} />
    </>
  );
}
