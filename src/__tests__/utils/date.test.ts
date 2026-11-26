import { describe, it, expect } from "vitest";
import { nowIso, dateOnly, addDays } from "../../utils/date";

describe("date utilities", () => {
  describe("nowIso", () => {
    it("returns ISO 8601 format string", () => {
      const result = nowIso();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("includes timezone info", () => {
      const result = nowIso();
      expect(result).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    });
  });

  describe("dateOnly", () => {
    it("extracts date from Date object", () => {
      const date = new Date("2025-06-15T14:30:00Z");
      const result = dateOnly(date);
      expect(result).toBe("2025-06-15");
    });

    it("handles dates near midnight", () => {
      const date = new Date("2025-01-01T00:00:00Z");
      const result = dateOnly(date);
      expect(result).toBe("2025-01-01");
    });
  });

  describe("addDays", () => {
    it("adds positive days", () => {
      const date = new Date("2025-01-15T12:00:00Z");
      const result = addDays(date, 5);
      expect(result.toISOString().split("T")[0]).toBe("2025-01-20");
    });

    it("subtracts days with negative value", () => {
      const date = new Date("2025-01-15T12:00:00Z");
      const result = addDays(date, -5);
      expect(result.toISOString().split("T")[0]).toBe("2025-01-10");
    });

    it("handles month boundaries", () => {
      const date = new Date("2025-01-31T12:00:00Z");
      const result = addDays(date, 1);
      expect(result.toISOString().split("T")[0]).toBe("2025-02-01");
    });

    it("handles year boundaries", () => {
      const date = new Date("2024-12-31T12:00:00Z");
      const result = addDays(date, 1);
      expect(result.toISOString().split("T")[0]).toBe("2025-01-01");
    });
  });
});

describe("day helpers", () => {
  it("DAY / isDay take the YYYY-MM-DD shape only", async () => {
    const { isDay } = await import("../../utils/date");
    expect(["2026-11-20", "1999-01-01"].every(isDay)).toBe(true);
    expect([undefined, null, 20261120, "2026-1-20", "2026-11-20T00:00:00Z", " 2026-11-20"].some(isDay)).toBe(false);
  });

  it("dayAtOffset shifts by minutes east of UTC", async () => {
    const { dayAtOffset } = await import("../../utils/date");
    expect(dayAtOffset("2026-11-20T03:00:00Z", -300)).toBe("2026-11-19");
    expect(dayAtOffset("2026-11-20T03:00:00Z", 0)).toBe("2026-11-20");
    expect(dayAtOffset(Date.parse("2026-11-20T22:30:00Z"), 120)).toBe("2026-11-21");
  });

  it("dayInZone follows summer time, and matches the en-CA formatter it replaced", async () => {
    const { dayInZone } = await import("../../utils/date");
    const ny = dayInZone("America/New_York");
    // 03:30 UTC is still the previous evening in New York, winter (UTC-5) and summer (UTC-4).
    expect(ny("2026-01-15T03:30:00Z")).toBe("2026-01-14");
    expect(ny("2026-07-15T03:30:00Z")).toBe("2026-07-14");
    expect(ny("2026-07-15T04:30:00Z")).toBe("2026-07-15");
    const old = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" });
    const ktm = dayInZone("Asia/Kathmandu");
    for (let h = 0; h < 48; h += 1) {
      const at = new Date(Date.UTC(2026, 2, 28, h, 15));
      expect(ktm(at)).toBe(old.format(at));
    }
    expect(() => dayInZone("Not/AZone")).toThrow(RangeError);
  });

  it("shiftDay moves across months and years", async () => {
    const { shiftDay } = await import("../../utils/date");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDay("2026-11-20", 0)).toBe("2026-11-20");
  });
});
