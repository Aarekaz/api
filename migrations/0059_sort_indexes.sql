-- Two hot lists sorted by a time and then id, where the index had only the
-- time, so ties were sorted in a temp B-tree on every page. Additive only:
-- indexes, no data change. Checked by __tests__/schemas/list-indexes.test.ts.
--   GET /v1/documents      ORDER BY updated_at DESC, id DESC (the apps' launch sync, up to 5000 rows)
--   GET /v1/music/history  ORDER BY played_at DESC, id DESC (Today, and Wrapped's music)
CREATE INDEX IF NOT EXISTS documents_updated_id ON documents (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS music_plays_played_id ON music_plays (played_at DESC, id DESC);
