# 0008: Calendar days come from utils/date.ts

Status: accepted, 26 Nov 2026 (audit-2026-11)

## Context

A "day" (`YYYY-MM-DD`, the calendar day somewhere) is everywhere in this API:
visits' `local_date` (ADR 0001), journal streaks, reading days, training,
WakaTime and GitHub ranges. The same logic had been written several times:

- `/^\d{4}-\d{2}-\d{2}$/` in 15 places, and `toISOString().slice(0, 10)`
  inlined 10 times beside `dateOnly`.
- "The day of an instant in a zone or at an offset" twice:
  `services/places.ts localDate` (en-US `formatToParts`) and
  `routes/journal.ts dayIn` (en-CA `format`), plus two day-arithmetic
  helpers (`places.shiftDate`, `journal.addDays`).

## Decision

`utils/date.ts` is the one place for days:

- `DAY` (the regex) and `isDay(value)`; schemas use `z.string().regex(DAY)`,
  so the OpenAPI pattern is unchanged.
- `dateOnly(date)`: the UTC day of an instant.
- `dayAtOffset(at, minutes)`: the day at a fixed offset (east positive), as
  visits store `utc_offset`.
- `dayInZone(zone)`: a function from instant to day in an IANA zone, with
  summer time; the formatter is built once; an unknown zone throws
  `RangeError` (callers decide the fallback, as `journal.dayIn` does).
- `shiftDay(day, n)`.

`places.localDate` and `journal.dayIn` keep their names and signatures and
are now one line over these. A test checks `dayInZone` against the en-CA
formatter it replaced across a day of Kathmandu's +5:45.

## Consequences

- New code reads or validates days through these, never a fresh regex or
  slice. Places' rule for a row without an offset stays
  `HOME_TIME_ZONE` (New York) via `dayInZone`.
- `scripts/backfill-local-date.mjs` (Node, outside the Worker) keeps its own
  copy of the New York rule; it has already run.
