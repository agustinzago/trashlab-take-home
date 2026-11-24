import { describe, expect, it } from "vitest";
import { centsToInput, formatAgo, formatCents, formatDate, parseCents } from "./format.ts";

describe("money", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["0.1", 10],
    [".75", 75],
    ["12.", 1200],
    ["$1,234.56", 123456],
    [" 2 500 ", 250000],
    ["-3.10", -310],
    ["0.29", 29], // 0.29 * 100 is 28.999… in floating point
  ])("parses %j as %i cents", (input, cents) => expect(parseCents(input)).toBe(cents));

  it.each(["", ".", "abc", "1.234", "1e3", "--1", "1.2.3", "99999999999999999999"])("rejects %j", (input) =>
    expect(parseCents(input)).toBeNull(),
  );

  it("formats and round-trips", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-500)).toBe("-$5.00");
    expect(parseCents(centsToInput(1205))).toBe(1205);
  });
});

describe("dates", () => {
  it("shows a calendar date without shifting it by timezone", () => {
    expect(formatDate("2026-11-01")).toBe("Nov 1, 2026");
    expect(formatDate(null)).toBe("—");
  });

  it("describes recent times relatively", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(formatAgo("2026-11-23T11:59:50Z", now)).toBe("just now");
    expect(formatAgo("2026-11-23T11:57:00Z", now)).toBe("3 minutes ago");
    expect(formatAgo("2026-11-22T12:00:00Z", now)).toBe("yesterday");
  });
});
