import { redirect } from "next/navigation";
import { getSessionUser, isAuthRequired } from "@/lib/auth/session";
import LoginClient from "./LoginClient";

// Server-side guard: a signed-in user hitting /login is bounced to the app
// before any login UI renders (no client-side flash). The post-OAuth passkey
// prompt is the one exception — that flow lands on /login?passkey=prompt while
// already authenticated, and must be allowed through to offer passkey setup.
// Demo sessions are intentionally NOT redirected: demo is a cookie, not an auth
// session, and /login is the path to convert a demo user into a real account.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passkey?: string }>;
}) {
  const { passkey } = await searchParams;
  if (isAuthRequired() && passkey !== "prompt") {
    const user = await getSessionUser();
    if (user) redirect("/");
  }
  return <LoginClient />;
}
