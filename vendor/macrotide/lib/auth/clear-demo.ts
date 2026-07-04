// Client-side helper: drop the in-memory demo DB and clear the
// `macrotide_demo` cookie. Used by sign-out (real auth doesn't know about
// the demo cookie), the demo banner's "Exit demo" button, and the login
// flow (so a demo-then-login user doesn't carry the cookie into the
// dashboard). Best-effort: never blocks, never throws — a stray demo
// cookie is harmless once a real session or a signed-out state takes
// precedence in `lib/api/with-db.ts`.
export async function clearDemoSession(): Promise<void> {
  try {
    await fetch("/api/demo", { method: "DELETE" });
  } catch {
    // ignore
  }
}
