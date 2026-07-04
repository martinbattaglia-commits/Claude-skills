import { describe, expect, it } from "vitest";
import { idTokenEmail } from "./id-token";

// Build a fake JWT: header.payload.signature, payload base64url-encoded. The
// decoder never verifies the signature, so a placeholder one is fine.
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("idTokenEmail", () => {
  it("extracts a verified email", () => {
    expect(idTokenEmail(jwt({ email: "me@gmail.com", email_verified: true }))).toEqual({
      email: "me@gmail.com",
      verified: true,
    });
  });

  it("treats a string 'true' email_verified as verified (some IdPs stringify)", () => {
    expect(idTokenEmail(jwt({ email: "me@gmail.com", email_verified: "true" })).verified).toBe(
      true,
    );
  });

  it("does NOT mark verified when the claim is false or missing", () => {
    expect(idTokenEmail(jwt({ email: "me@gmail.com", email_verified: false })).verified).toBe(
      false,
    );
    expect(idTokenEmail(jwt({ email: "me@gmail.com" })).verified).toBe(false);
  });

  it("returns the email even when unverified so callers can decide", () => {
    expect(idTokenEmail(jwt({ email: "me@gmail.com", email_verified: false })).email).toBe(
      "me@gmail.com",
    );
  });

  it("is robust to malformed / missing tokens", () => {
    expect(idTokenEmail(null)).toEqual({ verified: false });
    expect(idTokenEmail(undefined)).toEqual({ verified: false });
    expect(idTokenEmail("")).toEqual({ verified: false });
    expect(idTokenEmail("not-a-jwt")).toEqual({ verified: false });
    expect(idTokenEmail("a.!!!notbase64json!!!.c")).toEqual({ verified: false });
  });

  it("ignores a non-string email claim", () => {
    expect(idTokenEmail(jwt({ email: 123, email_verified: true }))).toEqual({
      email: undefined,
      verified: true,
    });
  });
});
