import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateBody, validateQuery } from "../../lib/site-http";

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

describe("patchAssignments", () => {
  it("writes only the fields present, in the listed order, with each column's transform", async () => {
    const { patchAssignments, publishedFlag } = await import("../../utils/query");
    const { mapJsonField } = await import("../../utils/json");
    const columns = { title: true, tags: { column: "tags_json", to: mapJsonField }, published: { to: publishedFlag }, sort: "sort_order" } as const;
    expect(patchAssignments({ published: false, title: null, extra: 1 }, columns)).toEqual({ sets: ["title = ?", "published = ?"], params: [null, 0] });
    expect(patchAssignments({ tags: ["a"], sort: undefined, published: undefined }, columns))
      .toEqual({ sets: ["tags_json = ?", "published = ?", "sort_order = ?"], params: ['["a"]', 1, null] });
    expect(patchAssignments({}, columns)).toEqual({ sets: [], params: [] });
  });
});

describe("readBody, idParam", () => {
  it("answers unreadable JSON, a mismatch and a bad id in the website's shape", async () => {
    const { Hono } = await import("hono");
    const { readBody, idParam, badId } = await import("../../lib/site-http");
    const app = new Hono();
    app.post("/:id", async (c) => {
      const id = idParam(c);
      if (!id) return badId(c);
      const v = await readBody(c, z.object({ name: z.string() }));
      if (!v.ok) return v.response;
      return c.json({ id, name: v.data.name });
    });
    const send = (path: string, body: string) => app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(await (await send("/x", "{}")).json()).toEqual({ error: "Invalid id" });
    expect(await (await send("/1", "nope")).json()).toEqual({ error: "Invalid JSON" });
    const mismatch = await send("/1", "{}");
    expect(mismatch.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await mismatch.json()).toMatchObject({ error: "Validation error", details: { fieldErrors: { name: ["Required"] } } });
    expect(await (await send("/2", '{"name":"a"}')).json()).toEqual({ id: 2, name: "a" });
  });
});
