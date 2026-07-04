import { describe, expect, it } from "vitest";
import { cleanUsSecurityName } from "./us-security-name";

describe("cleanUsSecurityName", () => {
  it("strips a trailing Common Stock suffix", () => {
    expect(cleanUsSecurityName("Apple Inc. - Common Stock")).toBe("Apple Inc.");
    expect(cleanUsSecurityName("Microsoft Corporation - Common Stock")).toBe(
      "Microsoft Corporation",
    );
  });

  it("strips a class-qualified stock suffix", () => {
    expect(cleanUsSecurityName("Alphabet Inc. - Class A Common Stock")).toBe("Alphabet Inc.");
    expect(cleanUsSecurityName("Berkshire Hathaway Inc. - Class B Common Stock")).toBe(
      "Berkshire Hathaway Inc.",
    );
  });

  it("leaves ETF and other names untouched", () => {
    expect(cleanUsSecurityName("Vanguard S&P 500 ETF")).toBe("Vanguard S&P 500 ETF");
    expect(cleanUsSecurityName("SPDR S&P 500 ETF Trust")).toBe("SPDR S&P 500 ETF Trust");
  });
});
