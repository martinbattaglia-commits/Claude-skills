"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client. Use `authClient.signIn.passkey()` to authenticate
 * an existing passkey, `authClient.passkey.addPasskey()` to register a new
 * one after the user is signed in, and `authClient.signOut()` to log out.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;
