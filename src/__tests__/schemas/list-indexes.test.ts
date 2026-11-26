import { describe, expect, it } from "vitest";
import { testD1 } from "../helpers/d1";

// Migration 0052: each list read below walks an index in its ORDER BY instead
// of sorting the table (no "USE TEMP B-TREE FOR ORDER BY" in the plan). On
// node:sqlite with empty tables; D1 with real statistics may plan better still.

const plan = (sql: string, withIndexes: boolean) => {
  const { db } = testD1({ migrations: "all" });
  if (!withIndexes) {
    for (const name of ["idx_shelf_items_published_date_added", "idx_photos_published_shot_at", "highlights_created", "journeys_mode_started", "documents_created"]) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
  }
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  db.close();
  return rows.map((r) => r.detail).join(" | ");
};

const READS: Array<[string, string, RegExp]> = [
  ["shelf", "SELECT * FROM shelf_items WHERE published = 1 ORDER BY date_added DESC LIMIT 100 OFFSET 0", /idx_shelf_items_published_date_added/],
  ["photos", "SELECT * FROM photos WHERE published = 1 ORDER BY shot_at DESC, created_at DESC LIMIT 100 OFFSET 0", /idx_photos_published_shot_at/],
  ["highlights", `SELECT h.*, d.title, d.kind, l.url, l.site FROM highlights h JOIN documents d ON d.id = h.document_id
     LEFT JOIN links l ON l.document_id = h.document_id
     WHERE h.deleted_at IS NULL AND d.deleted_at IS NULL ORDER BY h.created_at DESC, h.id DESC LIMIT 501`, /highlights_created/],
  ["links", `SELECT d.id FROM links l JOIN documents d ON d.id = l.document_id LEFT JOIN link_reading r ON r.document_id = l.document_id
     WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC, d.id DESC LIMIT 501`, /documents_created/],
];

describe("list indexes (0052)", () => {
  it.each(READS)("%s reads in index order", (_, sql, index) => {
    const withIndex = plan(sql, true);
    expect(withIndex).toMatch(index);
    expect(withIndex).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    // Without the migration the same read sorted the whole table.
    expect(plan(sql, false)).toMatch(/TEMP B-TREE FOR ORDER BY/);
  });

  it("flights seek by mode instead of scanning every journey", () => {
    const sql = "SELECT * FROM journeys WHERE mode = 'flying' ORDER BY started_at";
    expect(plan(sql, true)).toMatch(/SEARCH journeys USING INDEX journeys_mode_started \(mode=\?\)/);
    expect(plan(sql, false)).toMatch(/^SCAN journeys/);
  });
});
