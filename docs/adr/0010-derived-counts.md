# 0010: Counts a request would recompute are stored beside their source

Status: accepted, 26 Nov 2026 (audit-2026-11b)

## Context

Two reads recomputed a number from every row on each request:

- `/v1/crowd` (public, unauthenticated) counted `COUNT(DISTINCT visitor_hash)`
  over every visit ever recorded.
- `/v1/journal/stats` read a year of journal bodies to count their words in JS.

An edge cache would make the crowd total stale and wouldn't help the journal.
Both numbers have an exact incremental form.

## Decision

- **A counter kept by a trigger** when the source rows are only ever added.
  `crowd_visitors` (each visitor once) and `crowd_totals` (one row) are filled
  by migration 0054 from the existing visits and then kept by an `AFTER INSERT`
  trigger on `crowd_visits`. Every writer keeps the count right, whatever
  version of the Worker it is, so there is no gap between applying the
  migration and deploying. A repeat visit the same day is an upsert's UPDATE and
  doesn't fire it. Nothing deletes visits; a future delete must adjust the
  counter.
- **A stored value keyed by the source's version** when the source is edited.
  `journal_words(document_id, version, words)` (migration 0055) is written after
  each journal write. A reader uses a row only when its version is the
  document's; otherwise it counts the body, as before. Every body change bumps
  `documents.version` (services/documents.ts, links/fetch.ts), so a stale row is
  never used. `POST /v1/admin/journal-words` fills rows for older entries, 200
  per call, and is safe to repeat.
- **Code works before the migration.** Readers catch `no such table` and fall
  back to the old query, so deploy order doesn't matter and nothing changes
  for a client either way. Tests run both with and without the migration and
  require the same answers.

## Consequences

- A restore must load `crowd_visitors` before `crowd_visits` (alphabetical
  order, as the D1 backup writes them) or recreate the trigger after loading;
  the trigger's `WHEN NOT EXISTS` keeps a reload from counting twice.
- Rows written straight into D1 (wrangler, scripts) keep these right as long
  as they bump `documents.version` when they change a journal body.
  `scripts/import-vault.ts` appends body chunks without bumping it, but only to
  rows it has just inserted, which have no count yet.
