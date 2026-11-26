import { describe, expect, it } from "vitest";
import { readingStats } from "../../services/links";
import type { Env } from "../../types/env";
import { testD1 } from "../helpers/d1";

// Every part of GET /v1/links/stats from fixed rows: tracked days, days from
// before tracking, finished per month, top sites, totals and one day's
// articles. Deleted documents are left out everywhere but the highlight count.

const doc = (id: string, deleted = false) =>
  `('${id}', 'link', '${id}', 'slug-${id}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deleted ? "'2026-11-01T00:00:00.000Z'" : "NULL"})`;

const SQL = `
  INSERT INTO documents (id, kind, title, slug, created_at, updated_at, deleted_at) VALUES
    ${["a", "b", "c", "d", "e", "f", "g"].map((id) => doc(id)).join(", ")}, ${doc("x", true)};
  INSERT INTO links (document_id, url, site, reading_minutes, read_at) VALUES
    ('a', 'https://one.example/a', 'one.example', 7, '2026-10-02T09:00:00.000Z'),
    ('b', 'https://one.example/b', 'one.example', NULL, '2026-11-03T22:00:00.000Z'),
    ('c', 'https://two.example/c', 'two.example', 12, NULL),
    ('d', 'https://two.example/d', 'two.example', 4, '2026-11-03T08:00:00.000Z'),
    ('e', 'https://three.example/e', NULL, 3, NULL),
    ('f', 'https://four.example/f', 'four.example', 5, NULL),
    ('g', 'https://five.example/g', 'five.example', 9, '2025-12-30T10:00:00.000Z'),
    ('x', 'https://gone.example/x', 'gone.example', 8, '2026-11-03T10:00:00.000Z');
  INSERT INTO link_reading (document_id, progress, progress_updated_at) VALUES
    ('c', 0.5, '2026-11-04T10:00:00.000Z'), ('d', 1, '2026-11-03T08:00:00.000Z'),
    ('e', 0.05, '2026-11-04T09:00:00.000Z'), ('f', 0.01, NULL);
  INSERT INTO reading_days (day, document_id, minutes) VALUES
    ('2026-11-03', 'd', 3.26), ('2026-11-04', 'c', 1.04), ('2026-11-04', 'e', 0.33),
    ('2026-11-04', 'x', 2), ('2026-11-04', 'ghost', 1.5), ('2026-09-01', 'c', 9);
  INSERT INTO highlights (id, document_id, text, created_at, updated_at, deleted_at) VALUES
    ('h1', 'a', 'one', '2026-11-01', '2026-11-01', NULL), ('h2', 'x', 'two', '2026-11-01', '2026-11-01', '2026-11-02');
`;

describe("links reading stats", () => {
  it.each([[undefined], ["2026-11-04"]])("from fixed rows (day %s)", async (day) => {
    const d1 = testD1({ migrations: "all", sql: SQL });
    const stats = await readingStats({ DB: d1.DB } as Env, "2026-10-01", day);
    expect(stats).toMatchSnapshot();
    d1.db.close();
  });
});
