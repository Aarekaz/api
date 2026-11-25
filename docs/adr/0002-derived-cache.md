# 0002: A derived cache for trips, chapters and footprints

Status: accepted, 25 Nov 2026

## Context

`/v1/visits/trips`, `/chapters` and `/footprints` read every visit (and, for
footprints, every journey's path) on each request. ETag/304 (data_versions,
0046) already spares a client that has the current answer, but every new
version, new device or cleared cache pays the full build, and several devices
waking after a sync all pay it at once. On local D1 with a seeded history
(36,500 visits, 18,250 journeys, 10 years) the builds took:

| route | body | build (before) | kept (after) |
| --- | --- | --- | --- |
| trips?offset=-300 | 9.7 KB | ~1.0 s | ~3 ms |
| chapters | 18 KB | ~120 ms | ~2 ms |
| footprints | 13.2 MB | ~215 ms | ~15 ms (from R2) |

(5 sequential requests each through `wrangler dev`; first request is the
build, the rest are kept. Miniflare's SQLite, so only the ratio matters.)

## Decision

One table, `derived_cache` (migration 0050), and one read-through helper,
`services/derived-cache.ts` `derived(env, spec)`.

- **Key**: `(name, params)`, one row each, overwritten in place, so the table
  holds at most one row per distinct query (trips by normalized offset,
  chapters and footprints one each). No growth, no sweeper.
- **Validity**: a row holds only while `data_version` equals the current
  `data_versions` row it names and `shape` equals the code's (a per-build
  number, the route's `SHAPE` and `API_VERSION`). Writes already bump
  `places`, so invalidation needs no new code on any write path. The version
  is read *before* building and stored with the answer: a write during the
  build leaves the row already stale, never newer than its data. An upsert
  never replaces a row built from a newer version.
- **Single flight**: in an isolate, concurrent misses share one promise. Across
  isolates, a lease (`lease_until`, 30 s) taken with one conditional upsert;
  a request that loses waits up to ~1.5 s (100/200/400/800 ms), re-reading the
  row, and builds anyway if nothing comes. A failed build frees the lease. The
  cache can make a request slower by at most that wait, never fail it.
- **Size**: an answer up to 512 KiB lives in the row; up to 32 MiB in
  `R2_PRIVATE` at `derived-cache/<name>/<params>.json` (a D1 row tops out near
  2 MB, and the monthly backup would copy it), with the version and shape in
  the object's metadata, checked on read since the object is overwritten in
  place; larger, or without the bucket, it is built every time.
- **Replies**: the kept JSON text is sent as is (R2 streamed), byte-identical
  to `c.json`, with the same ETag and Cache-Control from the Places
  middleware, so 304s work exactly as before. `X-Derived-Cache:
  hit|miss|shared|waited|bypass` says how it was found.
- **Degrades**: without the table or data_versions, it builds every time.
- The backup skips `derived_cache`: none of it is the owner's data.

Alternatives not taken: the Cache API (per colo, can't be invalidated by a
version across colos without the version in the key, and no single-flight);
KV (eventually consistent, so a just-written version could read an old
answer); materialized tables refreshed on write (every write path pays, and
trips' "home" window makes incremental updates hard).

## Consequences

- A change to how trips, chapters or footprints are computed must bump its
  number in `BUILDS` (routes/visits.ts), or deploy with a new `API_VERSION`;
  otherwise the old answers stay until the next places write.
- Rows written straight into D1 don't bump `places`, so neither the ETags nor
  the cache see them; bump the version (or `DELETE FROM derived_cache`) after.
- Emptying `derived_cache` (and `derived-cache/` in R2) is always safe.
- Deploy: apply 0050 before the code (without it, reads just build as before).
