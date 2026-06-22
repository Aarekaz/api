import { describe, expect, it } from "vitest";
import { shelfItemSchema, statusMatchesShelfType } from "../../schemas/content";

describe("shelf item status schema", () => {
  it("accepts canonical statuses for the matching shelf type", () => {
    expect(shelfItemSchema.safeParse({ type: "book", title: "Book", status: "completed" }).success).toBe(true);
    expect(shelfItemSchema.safeParse({ type: "movie", title: "Movie", status: "watched" }).success).toBe(true);
    expect(shelfItemSchema.safeParse({ type: "show", title: "Show", status: "watching" }).success).toBe(true);
  });

  it("rejects free-form statuses", () => {
    expect(shelfItemSchema.safeParse({ type: "book", title: "Book", status: "read" }).success).toBe(false);
    expect(shelfItemSchema.safeParse({ type: "show", title: "Show", status: "binging" }).success).toBe(false);
  });

  it("rejects statuses from the wrong shelf type", () => {
    expect(statusMatchesShelfType("book", "watching")).toBe(false);
    expect(statusMatchesShelfType("movie", "reading")).toBe(false);
    expect(statusMatchesShelfType("show", "watched")).toBe(false);
  });
});
