# 0001: Places days come from local_date

Status: accepted, 25 Nov 2026

## Context

A visit's day is the calendar day where it happened. Until now every day,
month and year read under `/v1/visits` computed it per row in SQL:
`datetime(arrived_at, printf('%+d minutes', COALESCE(utc_offset, ?offset)))`.
That has two costs:

- No index can serve it, so a single day (`/day`) scanned a two-day UTC window
  and `/on-this-day` scanned every visit.
- A row without its own offset took the reader's `?offset=`, so the same visit
  could land on different days for different clients (and different ETags).

Migration 0048 added `local_date` to visits and journeys, written at ingest
(`services/places.ts localDate`: the row's offset, else America/New_York with
summer time) and filled once for older rows by `scripts/backfill-local-date.mjs`,
with an index on each table.

## Decision

- Every day, month and year grouping reads `local_date`: `/days`, `/day`
  (visits and journeys), `/on-this-day`, `/months`, `/years`, `/trips`,
  `/chapters`, and `/places?year=` (now the local year, matching `/years`).
- Filters are written so the index serves them: `/day` is
  `local_date BETWEEN day-2 AND day` (the extra two days pick up a stay that ran
  into the day; its departure is still read in its own offset), `/days?year=` a
  range, `/on-this-day` an `IN` list of one date per year (from MIN/MAX of the
  index). `EXPLAIN QUERY PLAN` on local D1 (36,500 seeded visits) shows
  `SEARCH ... USING INDEX visits_local_date` / `journeys_local_date` for each;
  a test asserts the same on node:sqlite.
- A row with `local_date` NULL (the backfill should leave none) is read the old
  way in a `UNION ALL` branch filtered by `local_date IS NULL`, which is itself
  an index seek and costs nothing when there are none. Grouping reads use
  `COALESCE(local_date, <old expression>)`.
- `?offset=` stays accepted on every route that took it, marked deprecated in
  the OpenAPI document. It now only places a NULL-`local_date` row. Clients may
  keep sending it; it will be ignored entirely once every row has a date.
- `SHAPE` in routes/visits.ts moved to 3 so cached replies are refetched once
  (the grouping of offset-less rows changed without a data change).

## Consequences

- A day is the same for every reader; offset-less rows go by New York time
  rather than the reader's offset (the backfill already decided this).
- Day lookups are index seeks instead of window scans; whole-history reads
  (`/trips`, `/chapters`, `/months`) still scan, which item 0002 caches.
- A visit's day is fixed at ingest. Changing the home time zone rule means a
  new backfill, not a read change. Rows written straight into D1 must set
  `local_date` (or be backfilled) to be placed by the new rule.
- Order matters on deploy: migration 0048 and the backfill before (or with)
  this code. Without the backfill nothing breaks; those rows take the fallback.
