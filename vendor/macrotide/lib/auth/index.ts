import "server-only";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, inArray } from "drizzle-orm";
import { appDb, appSqlite, marketDb, marketSqlite } from "@/lib/db/client";
import { runWithDbContext } from "@/lib/db/context";
import {
  account as accountTable,
  passkey as passkeyTable,
  user as userTable,
} from "@/lib/db/schema";
import { shouldAdoptOnLink, shouldBlockUnlink, shouldResetEmailOnUnlink } from "./account-rules";
import { idTokenEmail } from "./id-token";
import { isPlaceholderEmail, placeholderEmail } from "./placeholder-email";
import { socialProvidersConfig } from "./providers";
import { provisionNewUser } from "./provision";

const SOCIAL_PROVIDERS = ["google"];

/** Count the user's linked OAuth accounts (excludes the `credential` bootstrap row). */
function socialAccountCount(userId: string): number {
  return appDb
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(and(eq(accountTable.userId, userId), inArray(accountTable.providerId, SOCIAL_PROVIDERS)))
    .all().length;
}

/** Count the user's registered passkeys. */
function passkeyCount(userId: string): number {
  return appDb
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .all().length;
}

function currentEmail(userId: string): string | undefined {
  return appDb
    .select({ email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .get()?.email;
}

/**
 * Make the account's email mirror its OAuth provider. Runs from the
 * `account.create` hook on every link. Adopts the provider's verified email
 * (from the Google id_token) onto the user row + marks it verified when this is
 * the account's **sole** OAuth provider — i.e. a passkey-first account linking
 * its first provider, OR a re-link after unlinking the previous one (the
 * unlink-A-then-link-B case). When a second provider is added alongside an
 * existing one, the first-adopted email stands.
 *
 * No-op for the `credential` bootstrap row. Email is unique, so a collision is
 * swallowed — the link still succeeds, the email just doesn't change.
 */
function adoptProviderEmail(account: {
  userId: string;
  providerId: string;
  idToken?: string | null;
}): void {
  const isSocial = SOCIAL_PROVIDERS.includes(account.providerId);
  const current = currentEmail(account.userId);
  const isSoleProvider = socialAccountCount(account.userId) === 1; // includes the just-created row
  if (
    !shouldAdoptOnLink({
      isSocial,
      currentIsPlaceholder: isPlaceholderEmail(current),
      isSoleProvider,
    })
  ) {
    return;
  }
  const { email, verified } = idTokenEmail(account.idToken);
  if (!email || !verified || isPlaceholderEmail(email)) return;
  if (current && email.toLowerCase() === current.toLowerCase()) return;
  try {
    appDb
      .update(userTable)
      .set({ email: email.toLowerCase(), emailVerified: true, updatedAt: new Date() })
      .where(eq(userTable.id, account.userId))
      .run();
  } catch (e) {
    // Unique-collision (the email already belongs to another account) or any
    // write error: leave the email unchanged. The provider is still linked and
    // usable for sign-in.
    console.warn("[auth] could not adopt provider email", e);
  }
}

/**
 * Lockout backstop for unlinking an OAuth provider (`account.delete.before`;
 * returning false blocks the deletion). Refuses to remove a social provider
 * when it would leave the user with NO usable sign-in method — no passkey and no
 * other OAuth provider. The `credential` bootstrap row (random password, no UI)
 * is not usable, so it's never counted. This makes both signup origins behave
 * the same: with `allowUnlinkingAll: true`, better-auth's own last-row guard is
 * off, and this enforces the real rule (and guards the raw API, not just the UI).
 */
function blocksUnlinkLockout(account: { userId: string; providerId: string }): boolean {
  return shouldBlockUnlink({
    isSocial: SOCIAL_PROVIDERS.includes(account.providerId),
    otherSocialCount: socialAccountCount(account.userId) - 1, // exclude the row being deleted
    passkeyCount: passkeyCount(account.userId),
  });
}

/**
 * Mirror an unlink: when the **last** OAuth provider is removed, the account has
 * no provider-backed email anymore, so reset it to an emailless placeholder
 * (`account.delete.after`). Keeps the displayed email honest — it always
 * reflects a currently-linked verified provider, or nothing.
 */
function resetEmailIfNoProvider(account: { userId: string; providerId: string }): void {
  const current = currentEmail(account.userId);
  if (
    !shouldResetEmailOnUnlink({
      isSocial: SOCIAL_PROVIDERS.includes(account.providerId),
      remainingSocialCount: socialAccountCount(account.userId),
      currentIsPlaceholder: isPlaceholderEmail(current),
    })
  ) {
    return;
  }
  try {
    appDb
      .update(userTable)
      .set({ email: placeholderEmail(), emailVerified: false, updatedAt: new Date() })
      .where(eq(userTable.id, account.userId))
      .run();
  } catch (e) {
    console.warn("[auth] could not reset email after unlinking last provider", e);
  }
}

function rpName(): string {
  return process.env.AUTH_RP_NAME ?? "Macrotide";
}

function rpId(): string | undefined {
  return process.env.AUTH_RP_ID;
}

function baseURL(): string {
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

function origins(): string[] {
  // Always allow the dev origin; production should set PUBLIC_APP_URL.
  const list = ["http://localhost:3000"];
  const prod = baseURL();
  if (prod !== "http://localhost:3000") list.push(prod);
  return list;
}

// Dev fallback so `npm run dev` works without setup. Long enough to clear
// better-auth's 32-char length warning, but still dictionary words so the
// entropy warning fires as a reminder. In production, AUTH_SECRET is required.
const DEV_FALLBACK_SECRET = "macrotide-dev-fallback-not-for-production-32chars-min";

function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET must be set in production. Generate with `openssl rand -base64 32`.",
    );
  }
  return DEV_FALLBACK_SECRET;
}

/**
 * better-auth singleton. Routes are exposed at `/api/auth/[...all]` via the
 * `auth.handler` re-export. The auth tables (user/session/account/…) live in
 * app.db, so the drizzle adapter points at the app handle.
 *
 * Auth is required by default. Set `AUTH_DISABLED=1` to opt out (single-user
 * dev only — see [SECURITY.md](../../SECURITY.md)).
 */
export const auth = betterAuth({
  appName: rpName(),
  baseURL: baseURL(),
  database: drizzleAdapter(appDb, { provider: "sqlite" }),
  secret: authSecret(),
  trustedOrigins: origins(),
  // Email/password is enabled ONLY to bootstrap passkey signup.
  // createAccountWithPasskey() in app/(auth)/login/page.tsx calls
  // authClient.signUp.email() to create the user record and obtain a session,
  // then immediately calls authClient.passkey.addPasskey() — passkey remains
  // the only real login method because no password sign-in UI is exposed and
  // the signup flow sets a random unknowable password.
  // This is a bootstrap stopgap: OAuth will eventually replace this
  // mechanism, at which point emailAndPassword can be disabled.
  //
  // INVARIANT (guarded by lib/auth/no-reset-flow.test.ts): do NOT wire a
  // password-reset / "forgot password" flow (sendResetPassword, etc.) while this
  // is enabled — the credential path is intentionally inert (random password, no
  // password-login UI), and a reset flow would make it a real, attacker-usable
  // login that bypasses passkeys. Disable password sign-in first.
  emailAndPassword: { enabled: true },
  // OAuth. Registered only when GOOGLE_CLIENT_ID/SECRET are both present;
  // otherwise this is `{}` and the app runs passkey-only.
  socialProviders: socialProvidersConfig(),
  account: {
    // Account linking, hardened against pre-registration takeover (#98).
    //
    // Implicit linking stays ON: a sign-in that matches an existing account by
    // email is auto-merged — but ONLY when BOTH sides are proven. So two
    // *verified* methods on the same address (e.g. Google and a future magic
    // link) unify into one account with no manual step.
    //
    // Two guards make "both sides proven" hold, and they are the whole security
    // story here:
    //   1. No `trustedProviders`. That list would bypass the *incoming*
    //      provider's `email_verified` requirement. We don't need it (Google
    //      asserts it) and omitting it means a future non-verifying IdP can
    //      never auto-link on an unproven email claim.
    //   2. better-auth's `requireLocalEmailVerified` guards the *local* side: a
    //      social sign-in is refused if it would link onto an existing
    //      UNVERIFIED account — exactly the pre-registration takeover vector
    //      (attacker pre-registers victim@ unverified, victim's real Google
    //      later tries to merge in). It defaults to `true` and is slated to
    //      become unconditional, so we rely on the default rather than pin the
    //      deprecated option. DO NOT set it to `false`, and DO NOT add
    //      `trustedProviders`, without re-reading docs/explanation/decisions/0001.
    //
    // This is safe because no signup path lets anyone claim an unproven email
    // (ADR 0001): passkey signup is emailless (synthetic placeholder), OAuth
    // signup proves the address — so there is no attacker-controllable,
    // email-bearing account for a victim's identity to merge into. The in-app
    // path for a logged-in user to attach another provider is
    // `authClient.linkSocial()`, which links into *their own* session account.
    //
    // `allowDifferentEmails` is required because a passkey-first account's email
    // is a synthetic placeholder (./placeholder-email): linking a real provider
    // necessarily means the emails differ. It only relaxes the *explicit*
    // session-scoped link, not the implicit merge. `adoptProviderEmail` then
    // mirrors the provider's verified email onto the row.
    //
    // `allowUnlinkingAll` turns OFF better-auth's last-account-row guard, which
    // counts the phantom `credential` bootstrap row and so blocks unlinking
    // inconsistently across signup origins. We enforce the real rule — never
    // leave the user with zero USABLE methods — in the `account.delete` hooks
    // (blocksUnlinkLockout), which also reset the email on the last unlink
    // (resetEmailIfNoProvider).
    accountLinking: {
      enabled: true,
      allowDifferentEmails: true,
      allowUnlinkingAll: true,
    },
  },
  // New-account provisioning: default tier='public' + one seeded
  // bucket. Runs in an owner DB context stamped with the new user's id so the
  // bucket's user_id is set correctly (the auth route is not withDb-wrapped, so
  // there is no ambient request context here).
  databaseHooks: {
    user: {
      create: {
        after: async (newUser: { id: string }) => {
          await runWithDbContext(
            {
              appDb,
              appSqlite,
              marketDb,
              marketSqlite,
              isDemo: false,
              sessionId: "owner",
              userId: newUser.id,
            },
            () => provisionNewUser(newUser.id),
          );
        },
      },
    },
    // Keep the account's email mirroring its OAuth provider, and keep unlinking
    // from locking anyone out. See adoptProviderEmail / blocksUnlinkLockout /
    // resetEmailIfNoProvider above.
    account: {
      create: {
        after: async (newAccount: {
          userId: string;
          providerId: string;
          idToken?: string | null;
        }) => {
          adoptProviderEmail(newAccount);
        },
      },
      delete: {
        // Backstop: refuse an unlink that would leave no usable sign-in method.
        before: async (acct: { userId: string; providerId: string }) => {
          if (blocksUnlinkLockout(acct)) return false;
        },
        // When the last provider goes, the email is no longer provider-backed —
        // reset it to an emailless placeholder.
        after: async (acct: { userId: string; providerId: string }) => {
          resetEmailIfNoProvider(acct);
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once per day
  },
  plugins: [
    passkey({
      rpName: rpName(),
      ...(rpId() ? { rpID: rpId() } : {}),
      origin: origins()[origins().length - 1],
    }),
  ],
});

export type Auth = typeof auth;
