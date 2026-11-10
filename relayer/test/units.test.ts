import { describe, expect, it } from "vitest";
import { fromUnits, nearToYoctoStr, toUnits } from "../scripts/lib/units.js";

describe("units", () => {
  it("converts decimal strings exactly", () => {
    expect(toUnits("3.9", 6)).toBe(3900000n);
    expect(toUnits("0.1", 24)).toBe(100000000000000000000000n);
    expect(toUnits("3", 6)).toBe(3000000n);
  });
  it("rejects too many decimals and non-decimals", () => {
    expect(() => toUnits("1.0000001", 6)).toThrow();
    expect(() => toUnits("1e6", 6)).toThrow();
    expect(() => toUnits("-1", 6)).toThrow();
    expect(() => toUnits("", 6)).toThrow();
  });
  it("formats back", () => {
    expect(fromUnits(1n, 6)).toBe("0.000001");
    expect(fromUnits(3900000n, 6)).toBe("3.9");
    expect(fromUnits(3000000n, 6)).toBe("3");
    expect(fromUnits(0n, 6)).toBe("0");
  });
  it("nearToYoctoStr has no float error", () => {
    expect(nearToYoctoStr("0.1")).toBe("100000000000000000000000");
    expect(nearToYoctoStr("1.9")).toBe("1900000000000000000000000");
  });
});
