# 0012: A request's independent queries go in one D1 batch

Status: accepted, 26 Nov 2026 (audit-2026-11b)

## Context

Every awaited D1 statement is a round trip from the Worker to the database.
Several paths awaited one statement at a time when nothing depended on the
previous answer: the links reading stats (seven reads), the WakaTime refresh
(one write per day, language, project, editor and hour), and a document's new
slug (one read per candidate, up to 498). The WakaTime hourly replace (a
DELETE then 24 INSERTs) could also be seen half written.

## Decision

- Statements that don't depend on each other's results go in one
  `env.DB.batch([...])`: one round trip, run in order in one transaction.
  `readingStats` reads its seven results from the batch; `refreshWakaTime`
  sends one batch per day; `refreshWakaTimeHourly` replaces a day's hours in
  one batch, so the day is never half written; the OAuth sweep deletes from
  both tables in one batch.
- A search over candidates reads them once: `uniqueSlug` takes every taken
  `base`/`base-*` slug in one range query on the unique index and picks in JS.
- The test D1 (`__tests__/helpers/d1.ts`) returns a read's rows from `run()`,
  as D1 does, so a batch of SELECTs behaves in tests as in production.
- Keep a batch to one unit of work (a day, a page, a request). Very long
  batches hold the database for their whole length.

## Consequences

- Characterisation tests pinned what each path wrote or answered before the
  change (`wakatime-refresh`, `links-stats` snapshots) and still pass.
- A failure inside a batch rolls the whole batch back. For WakaTime that is the
  one day; the next cron tick writes it again.
