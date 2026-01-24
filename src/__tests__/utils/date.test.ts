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
