import { describe, expect, it } from "vitest";
import { performanceDisclaimer } from "./performance-disclaimer";

describe("performanceDisclaimer", () => {
  it("TR benchmark selected, no dividend fund → no caveat (both total return)", () => {
    expect(performanceDisclaimer(true, false)).toBeNull();
  });

  it("no benchmark, holds a dividend fund → balance-only sentence", () => {
    expect(performanceDisclaimer(false, true)).toBe(
      "Some funds pay dividends out, so your real total return is a bit higher than shown.",
    );
  });

  it("TR benchmark + dividend fund → portfolio understates vs benchmark", () => {
    expect(performanceDisclaimer(true, true)).toBe(
      "Your funds pay dividends out, so your line can sit just below this benchmark.",
    );
  });

  it("neither → null (render nothing)", () => {
    expect(performanceDisclaimer(false, false)).toBeNull();
  });
});
