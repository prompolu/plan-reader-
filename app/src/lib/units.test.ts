import { describe, expect, it } from "vitest";
import { formatFtIn, formatLength } from "./units";

describe("formatLength", () => {
  it("formats metric units without changing the value", () => {
    expect(formatLength(1219.2, "mm")).toBe("1219 mm");
    expect(formatLength(1219.2, "cm")).toBe("121.9 cm");
    expect(formatLength(2100, "m")).toBe("2.1 m");
  });
  it("formats feet and inches", () => {
    expect(formatFtIn(1219.2)).toBe("4'-0\"");
    expect(formatFtIn(2032)).toBe("6'-8\"");
    expect(formatFtIn(1079.5)).toBe("3'-6 1/2\"");
    expect(formatLength(914.4, "ft_in")).toBe("3'-0\"");
  });
  it("shows the original notation when requested", () => {
    expect(formatLength(1219.2, "original", "4'-0\"")).toBe("4'-0\"");
    expect(formatLength(null, "mm")).toBe("—");
  });
});
