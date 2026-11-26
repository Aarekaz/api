import { describe, expect, it } from "vitest";
import { uniqueSlug } from "../../services/documents";
import type { Env } from "../../types/env";
import { testD1 } from "../helpers/d1";

// A new document's slug: the title's, else the first free numbered one. It used
// to ask once per candidate (up to 498 reads); now it reads the taken ones once.

const insert = (d1: ReturnType<typeof testD1>, slugs: string[]) => slugs.forEach((slug, i) => d1.db.prepare(
  "INSERT INTO documents (id, kind, title, slug, created_at, updated_at) VALUES (?, 'note', ?, ?, '2026-01-01', '2026-01-01')",
).run(`d${i}`, slug, slug));

describe("uniqueSlug", () => {
  it.each<[string, string[], string]>([
    ["notes", [], "notes"],
    ["notes", ["notes"], "notes-2"],
    ["notes", ["notes", "notes-2", "notes-3"], "notes-4"],
    ["notes", ["notes", "notes-3"], "notes-2"],
    ["notes", ["notes-2"], "notes"],
    // Look-alikes that aren't numbered copies of this base don't count.
    ["notes", ["notes", "notes-and-more", "notesy", "notes-2-x", "note", "notes.md"], "notes-2"],
    ["a-b", ["a-b", "a-b-2"], "a-b-3"],
  ])("%s with %j taken is %s, in one read", async (base, taken, expected) => {
    const d1 = testD1({ migrations: "all" });
    insert(d1, taken);
    d1.queries.length = 0;
    expect(await uniqueSlug({ DB: d1.DB } as Env, base)).toBe(expected);
    expect(d1.queries).toHaveLength(1);
    d1.db.close();
  });

  it("falls back to a random tail once 2 to 499 are all taken", async () => {
    const d1 = testD1({ migrations: "all" });
    insert(d1, ["x", ...Array.from({ length: 498 }, (_, i) => `x-${i + 2}`)]);
    expect(await uniqueSlug({ DB: d1.DB } as Env, "x")).toMatch(/^x-[0-9a-z]{6}$/);
    d1.db.close();
  });
});
