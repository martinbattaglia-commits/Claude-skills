import { describe, expect, it } from "vitest";
import { aaguidName } from "./aaguid";

describe("aaguidName", () => {
  it("returns the authenticator name for a known AAGUID", () => {
    // iCloud Keychain (Managed)
    expect(aaguidName("dd4ec289-e01d-41c9-bb89-70fa845d4bf2")).toBe("iCloud Keychain (Managed)");
    // 1Password
    expect(aaguidName("bada5566-a7aa-401f-bd96-45619a55120d")).toBe("1Password");
    // Google Password Manager
    expect(aaguidName("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe("Google Password Manager");
    // Windows Hello
    expect(aaguidName("9ddd1817-af5a-4672-a2b9-3e3dd95000a9")).toBe("Windows Hello");
    // Apple Passwords
    expect(aaguidName("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")).toBe("Apple Passwords");
  });

  it("returns null for the all-zeros AAGUID (not disclosed)", () => {
    expect(aaguidName("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(aaguidName(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(aaguidName(null)).toBeNull();
  });

  it("returns null for an unknown AAGUID", () => {
    expect(aaguidName("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeNull();
  });
});
