# 0006: Time read comes from the seconds the app measures

Status: accepted, 26 Nov 2026

## Context

`reading_days` (0038) feeds the reading counter, days read and the streak.
`saveProgress` (services/links/state.ts) credited it with
`progress gained × links.reading_minutes`. Two problems:

- `reading_minutes` is the fetch's word count / 230, and a fetch often misses
  most of a page. julian.com/blog/memorized-rules, a very long essay, has
  `reading_minutes = 4`, so reading 57% of it counted about 2 minutes.
- Only forward movement counted, so re-reading (or reading past the furthest
  point on another device first) counted nothing.

The app can measure what it actually knows: how long you were reading, and
how many words it rendered.

## Decision

`PUT /v1/links/:id/progress` (and `POST`, the same handler) take three more
optional fields. The reply is unchanged.

- `seconds`: active reading seconds since this device's last report. When
  present it replaces the old formula: `seconds / 60` minutes go to
  `reading_days` on the sent `day` (else the date of `updated_at`), whether or
  not the position moved and whether or not this write won last-write-wins.
- The credit is clamped (`creditedSeconds`): at most the wall-clock time,
  on the server's clock, since the link's previous `progress_updated_at`, plus
  30 s of slack, and never more than 10 minutes a report. A link with no
  previous progress gets the 10-minute cap. The server's clock is used so a
  device's wrong clock can't widen the window; a previous time in the future
  (a fast device clock, accepted up to 60 s) leaves only the slack.
- `report_id` (a UUID): the report is recorded in `reading_reports`
  (migration 0051, primary key `(document_id, report_id)`) before its minutes
  are added; a retry with the same id adds nothing. A report without an id
  always counts, and so does every report until 0051 is applied (the insert
  failing with "no such table" is treated as new), so the code can deploy
  before the migration.
- `words`: the words in the text the app rendered. When `words / 230`
  (rounded, at least 1; the rate a fetch uses) is more than `reading_minutes`,
  `reading_minutes` is raised. It is never lowered here. The old formula,
  still used when `seconds` is absent, reads the raised value.
- Without `seconds` (older app builds), time read is as before.

## Consequences

- Reports that arrive in a burst after being queued offline are each limited
  by the time since the previous one on the server, so an offline session is
  undercounted rather than overcounted. Each report is capped at 10 minutes,
  which also bounds a flood of distinct report ids.
- The record of a report and its minutes are two writes, not one; if the
  second fails the report is kept and its minutes are lost (stats are a
  bonus; the position is always saved).
- A refetch of the page (`fetchArticle`) still sets `reading_minutes` from the
  fetched words and may lower a value the app raised.
- Deploy: the code is safe without 0051 (no dedupe until it is applied).
  Apply `migrations/0051_reading_reports.sql` remotely when ready (owner).
  `reading_reports` is included in the monthly D1 backup like any table.
