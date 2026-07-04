import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Invariant guard (#194). `emailAndPassword` is enabled ONLY as the passkey-
// signup bootstrap: the password is random/unknowable, there is NO password-
// login UI, and NO reset flow — so the credential path is inert and harmless.
//
// Wiring a password-reset / "forgot password" flow while `emailAndPassword` is
// on would turn that inert path into a REAL credential login: an attacker could
// trigger a reset, set a password they know, and sign in by email+password —
// bypassing the passkey-only design (a takeover/hijack vector).
//
// This is an easy thing to add innocently later (a human or an AI agent: "users
// want password reset"). This test fails the moment such a flow is wired, forcing
// a conscious security decision (e.g. disable password sign-in first, or
// otherwise neutralize the credential path) instead of a silent hole.
describe("auth: no password-reset flow while credential sign-in is enabled (#194)", () => {
  const src = readFileSync(resolve("lib/auth/index.ts"), "utf8");

  it("emailAndPassword is still the config this guard protects", () => {
    expect(src).toMatch(/emailAndPassword:\s*\{/);
  });

  it("does not wire a reset / forgot-password flow", () => {
    const forbidden = [
      "sendResetPassword",
      "onPasswordReset",
      "resetPasswordTokenExpiresIn",
      "forgetPassword",
    ];
    for (const token of forbidden) {
      // Match the token used as a config KEY or CALL (`token:` / `token(`), so a
      // mention in a comment (like the one in lib/auth/index.ts) doesn't trip it.
      const wired = new RegExp(`\\b${token}\\s*[:(]`).test(src);
      expect(
        wired,
        `lib/auth/index.ts must not enable "${token}" while emailAndPassword is on — the ` +
          `credential path must stay inert (passkey-only). Disable password sign-in first, ` +
          `or neutralize the credential path. See lib/auth/no-reset-flow.test.ts.`,
      ).toBe(false);
    }
  });
});
