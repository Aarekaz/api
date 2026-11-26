# 0009: WHOOP collection reads compare ISO instants

Status: accepted, 26 Nov 2026 (audit-2026-11b)

## Context

`/v1/health/whoop/{cycles,recoveries,sleeps,workouts}` (website routes)
filtered and sorted by `julianday(time)`. An index on `(whoop_user_id,
start_at)` can't serve an expression it doesn't contain, so every page
scanned the user's rows and sorted them. Sleeps and workouts sort by
`COALESCE(start_at, upstream_created_at)` and recoveries by
`upstream_created_at`, which no index covered at all.

The writers store `Date.toISOString()` text (`records.ts canonicalTimestamp`),
so comparing the raw column as text would usually give the same answer. But
the read path was built to tolerate rows stored with an offset, and a test
pins it ("orders, windows, and paginates offset timestamps by their
instant"). A raw text comparison sorts `10:00-04:00` before `13:00Z`, which
is wrong, and nothing in the schema stops such a row.

## Decision

- Reads compare `isoInstant(time)`, which is
  `strftime('%Y-%m-%dT%H:%M:%fZ', time)` (`services/whoop/read-repository.ts`):
  the instant as `toISOString()` text. ISO-Z text of fixed width sorts as the
  instant does. `strftime` and `julianday` parse the same input to the same
  millisecond, so filters, order, ties and cursors are what `julianday` gave,
  for any row, canonical or not. Bounds are wrapped the same way.
- Migration 0053 indexes that exact expression per table,
  `(whoop_user_id, isoInstant(time), key) WHERE deleted_at IS NULL`. Date
  functions without `'now'` are deterministic in SQLite, so they may appear in
  an index.
- A cursor page adds `isoInstant(time) <= cursor` before the OR, which the OR
  already implies, so the read seeks to the cursor instead of walking from the
  newest row.
- `__tests__/whoop/read-order.test.ts` runs the old `julianday` query beside
  the new one over 14 timestamp spellings (offsets, no milliseconds, a space,
  sub-millisecond, missing `start_at`), 8 bounds and 3 page sizes, walking every
  page, and requires identical ids and cursors. It also checks the plan is a
  single index seek with no sort.

## Consequences

- Until 0053 is applied, reads are as slow as before (the expression is new to
  the planner) and still correct.
- New WHOOP reads that order or window by time use `isoInstant` and an index
  on the same expression.
- Once the owner has checked that every stored time is canonical
  (`SELECT COUNT(*) FROM whoop_cycles WHERE start_at <> strftime('%Y-%m-%dT%H:%M:%fZ', start_at)`
  and likewise for the other three), the reads could compare raw columns and
  the expression indexes could go. Not worth it now: the cost is the same.
- The reconciliation tombstone (`repository.ts`, a write over a sync window)
  still uses `julianday`; it runs once per sync and is left alone.
