import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateBody, validateQuery } from "../../utils/validation";

describe("validation utilities", () => {
  const testSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive().optional(),
    email: z.string().email().optional(),
  });

  describe("validateBody", () => {
    it("returns ok=true for valid data", () => {
      const result = validateBody(testSchema, { name: "John", age: 30 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe("John");
        expect(result.data.age).toBe(30);
      }
    });

    it("returns ok=true for minimal valid data", () => {
      const result = validateBody(testSchema, { name: "Jane" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe("Jane");
        expect(result.data.age).toBeUndefined();
      }
    });

    it("returns ok=false for invalid data", () => {
      const result = validateBody(testSchema, { name: "" }); // name too short
      expect(result.ok).toBe(false);
    });

    it("returns ok=false for missing required fields", () => {
      const result = validateBody(testSchema, { age: 25 }); // missing name
      expect(result.ok).toBe(false);
    });

    it("returns ok=false for wrong types", () => {
      const result = validateBody(testSchema, { name: "John", age: "thirty" });
      expect(result.ok).toBe(false);
    });
  });

  describe("validateQuery", () => {
    const querySchema = z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
      search: z.string().optional(),
    });

    it("returns ok=true for valid query params", () => {
      const result = validateQuery(querySchema, { limit: "10", offset: "0" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.limit).toBe("10");
        expect(result.data.offset).toBe("0");
      }
    });

    it("handles empty query params", () => {
      const result = validateQuery(querySchema, {});
      expect(result.ok).toBe(true);
    });
  });
});
