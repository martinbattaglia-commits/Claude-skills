import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOwnerUser, ownerEmail } from "./owner";

const ORIGINAL = process.env.OWNER_EMAIL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OWNER_EMAIL;
  else process.env.OWNER_EMAIL = ORIGINAL;
});

describe("ownerEmail()", () => {
  it("normalises to trimmed lowercase", () => {
    process.env.OWNER_EMAIL = "  Owner@Example.COM ";
    expect(ownerEmail()).toBe("owner@example.com");
  });

  it("returns null when unset", () => {
    delete process.env.OWNER_EMAIL;
    expect(ownerEmail()).toBeNull();
  });

  it("returns null when blank", () => {
    process.env.OWNER_EMAIL = "   ";
    expect(ownerEmail()).toBeNull();
  });
});

describe("isOwnerUser()", () => {
  beforeEach(() => {
    process.env.OWNER_EMAIL = "owner@example.com";
  });

  it("is true for the configured owner (case-insensitive)", () => {
    expect(isOwnerUser({ email: "Owner@Example.com" })).toBe(true);
    expect(isOwnerUser({ email: "  owner@example.com " })).toBe(true);
  });

  it("is false for a different (non-owner) user", () => {
    expect(isOwnerUser({ email: "someone-else@example.com" })).toBe(false);
  });

  it("is false for no session user", () => {
    expect(isOwnerUser(null)).toBe(false);
    expect(isOwnerUser(undefined)).toBe(false);
  });

  it("FAILS CLOSED: nobody is owner when OWNER_EMAIL is unset", () => {
    delete process.env.OWNER_EMAIL;
    expect(isOwnerUser({ email: "owner@example.com" })).toBe(false);
    expect(isOwnerUser({ email: "anyone@example.com" })).toBe(false);
  });
});
