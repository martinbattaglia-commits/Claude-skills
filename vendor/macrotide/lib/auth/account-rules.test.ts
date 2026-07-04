import { describe, expect, it } from "vitest";
import { shouldAdoptOnLink, shouldBlockUnlink, shouldResetEmailOnUnlink } from "./account-rules";

describe("shouldBlockUnlink", () => {
  it("blocks only when no other provider AND no passkey remain", () => {
    expect(shouldBlockUnlink({ isSocial: true, otherSocialCount: 0, passkeyCount: 0 })).toBe(true);
  });

  it("allows when a passkey remains (the Google-signup + passkey case)", () => {
    expect(shouldBlockUnlink({ isSocial: true, otherSocialCount: 0, passkeyCount: 1 })).toBe(false);
  });

  it("allows when another provider remains", () => {
    expect(shouldBlockUnlink({ isSocial: true, otherSocialCount: 1, passkeyCount: 0 })).toBe(false);
  });

  it("never blocks a non-social (credential) row", () => {
    expect(shouldBlockUnlink({ isSocial: false, otherSocialCount: 0, passkeyCount: 0 })).toBe(
      false,
    );
  });
});

describe("shouldAdoptOnLink", () => {
  it("adopts when linking the sole provider (passkey-first first link)", () => {
    expect(
      shouldAdoptOnLink({ isSocial: true, currentIsPlaceholder: true, isSoleProvider: true }),
    ).toBe(true);
  });

  it("adopts on re-link after unlinking (sole provider, real current email)", () => {
    // unlink A → link B: B is now the only provider, current email is the stale a@…
    expect(
      shouldAdoptOnLink({ isSocial: true, currentIsPlaceholder: false, isSoleProvider: true }),
    ).toBe(true);
  });

  it("does NOT adopt when adding a second provider (first-adopted email stands)", () => {
    expect(
      shouldAdoptOnLink({ isSocial: true, currentIsPlaceholder: false, isSoleProvider: false }),
    ).toBe(false);
  });

  it("still adopts a placeholder even if not sole (defensive)", () => {
    expect(
      shouldAdoptOnLink({ isSocial: true, currentIsPlaceholder: true, isSoleProvider: false }),
    ).toBe(true);
  });

  it("never adopts for a non-social row", () => {
    expect(
      shouldAdoptOnLink({ isSocial: false, currentIsPlaceholder: true, isSoleProvider: true }),
    ).toBe(false);
  });
});

describe("shouldResetEmailOnUnlink", () => {
  it("resets when the last provider is gone and the email is real", () => {
    expect(
      shouldResetEmailOnUnlink({
        isSocial: true,
        remainingSocialCount: 0,
        currentIsPlaceholder: false,
      }),
    ).toBe(true);
  });

  it("does not reset when a provider remains", () => {
    expect(
      shouldResetEmailOnUnlink({
        isSocial: true,
        remainingSocialCount: 1,
        currentIsPlaceholder: false,
      }),
    ).toBe(false);
  });

  it("does not reset an already-placeholder email", () => {
    expect(
      shouldResetEmailOnUnlink({
        isSocial: true,
        remainingSocialCount: 0,
        currentIsPlaceholder: true,
      }),
    ).toBe(false);
  });

  it("never resets for a non-social row", () => {
    expect(
      shouldResetEmailOnUnlink({
        isSocial: false,
        remainingSocialCount: 0,
        currentIsPlaceholder: false,
      }),
    ).toBe(false);
  });
});
