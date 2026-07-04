import { describe, expect, it } from "vitest";
import {
  isPlaceholderEmail,
  PLACEHOLDER_EMAIL_DOMAIN,
  placeholderEmail,
} from "./placeholder-email";

describe("placeholder email", () => {
  it("mints a unique address on the reserved .invalid domain", () => {
    const a = placeholderEmail();
    const b = placeholderEmail();
    expect(a).not.toBe(b);
    expect(a.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)).toBe(true);
    expect(PLACEHOLDER_EMAIL_DOMAIN).toBe("passkey.invalid");
  });

  it("minted addresses pass a basic dotted-domain email shape", () => {
    // The domain must carry a dot + TLD, or better-auth's z.email() rejects it.
    expect(placeholderEmail()).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it("detects its own placeholders", () => {
    expect(isPlaceholderEmail(placeholderEmail())).toBe(true);
  });

  it("does not flag real addresses or empty input", () => {
    expect(isPlaceholderEmail("me@gmail.com")).toBe(false);
    expect(isPlaceholderEmail("user@passkey.invalid.example.com")).toBe(false);
    expect(isPlaceholderEmail("")).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
  });
});
