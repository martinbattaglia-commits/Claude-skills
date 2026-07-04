import { describe, expect, it } from "vitest";
import { detectOS } from "./userscript-apps";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari";
const IPAD_OLD = "Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Safari";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/120 Mobile Safari";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari";

describe("detectOS", () => {
  it("buckets explicit iOS / Android / desktop UAs", () => {
    expect(detectOS(IPHONE)).toBe("ios");
    expect(detectOS(IPAD_OLD)).toBe("ios");
    expect(detectOS(ANDROID)).toBe("android");
    expect(detectOS(WINDOWS)).toBe("desktop");
  });

  it("a real Mac (no touch) is desktop", () => {
    expect(detectOS(MAC, 0)).toBe("desktop");
    expect(detectOS(MAC)).toBe("desktop");
  });

  it("iPadOS reports a Mac UA but has touch points → iOS", () => {
    // The bug: iPadOS Safari (and iPhone 'Request Desktop Website') send the Mac
    // UA with no iPad/Mobile token; maxTouchPoints distinguishes it from a real Mac.
    expect(detectOS(MAC, 5)).toBe("ios");
  });

  it("still catches a mobile-token Mac UA without touch info", () => {
    expect(detectOS(`${MAC} Mobile`)).toBe("ios");
  });
});
