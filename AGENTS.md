# Repository Guidelines

The personal API at `api.anuragd.me`: a Cloudflare Worker (Hono) over D1, two R2
buckets and a queue. It is the source of truth for the public website
(`../anurag.me`, read-only) and the native apps (`../apple`, read/write).

## The one rule: the website sees nothing change

The website reads these GETs, and their bodies must stay byte-compatible:
`/v1/profile`, `/v1/projects`, `/v1/posts`, `/v1/photos`, `/v1/experience`,
`/v1/education`, `/v1/skills`, `/v1/now`, `/v1/uses`, `/v1/settings`,
`/v1/shelf`, `/v1/github`, `/v1/wakatime`, `/v1/wakatime/hourly`, plus
`/v1/wrapped/2026`, `/v1/traffic/:year`, `/v1/status`, `/v1/music/now` and
`/v1/health/whoop/*`.

- `src/__tests__/contracts/website-freeze.test.ts` cuts the website's slice out of
  the API's OpenAPI document and compares it with two files: the site's own
  contract (`website-openapi.snapshot.json`, a copy of
  `anurag.me/contracts/api-openapi.json`; every field must survive) and today's
  exact slice (`website-openapi.frozen.json`; any change fails). Change a
  website shape only on purpose: site first, then refresh both files
  (`UPDATE_WEBSITE_FREEZE=1 npx vitest run src/__tests__/contracts`).
- Website routes keep their old error bodies (`{ "error": "message" }`) and
  never use `src/lib/http.ts`; they use `src/lib/site-http.ts`
  (`docs/adr/0007-one-module-per-error-dialect.md`).
- Writes the website shows trigger a page refresh on anuragd.me
  (`middleware/site-refresh.ts`).

## Layout

- `src/index.ts`: the Worker entry. Global middleware, auth on `/v1/*` and
  `/health`, route mounting, and the `scheduled` and `queue` handlers.
- `src/routes/*.ts`: one Hono app per resource. A route checks input, calls a
  service and shapes the reply. Each file also registers its OpenAPI paths
  (`openApiRegistry.registerPath`), served at `/openapi.json` and `/docs`.
- `src/services/*.ts`: SQL and outside calls. `places.ts` holds every
  `/v1/visits` query; `links/` (extract, nonarticles, urls, store, fetch,
  state, stats; import from `services/links`), `documents.ts`, `highlights.ts`,
  `sections.ts`, `whoop/`, `spotify/` likewise.
- `src/lib/http.ts`: replies for the app's routes (below).
- `src/lib/site-http.ts`: replies for the website's routes: `readBody(c,
  schema)` ("Invalid JSON", then "Validation error" with Zod's `flatten()`),
  `idParam`/`badId`, `notFound(c, "Project")`, `validateBody`/`validateQuery`.
  PATCH handlers build their `SET` list with `patchAssignments` (utils/query.ts).
  `__tests__/routes/website-crud.test.ts` snapshots every body they send.
- `src/utils/`: pure helpers. `date.ts` is the one place for calendar days
  (`DAY`, `isDay`, `dayAtOffset`, `dayInZone`, `shiftDay`; ADR 0008);
  `query.ts` has the list filters and `clampLimit` (the one `?limit=` rule).
- `services/upload-token.ts`: presigned upload tokens (photos, blog images):
  scoped to their kind, spent by their first PUT (`upload_tokens`, 0056),
  signed with `UPLOAD_TOKEN_SECRET` or else `API_TOKEN`; `UPLOAD_KINDS` (raster
  types only, never SVG) and `UPLOAD_LIMITS`, every upload's size cap (ADR
  0011). `lib/uploads.ts` has the presign, presigned PUT and direct upload
  handlers both routes mount.
- `lib/private-photos.ts`: the one upload and read for private photos
  (journal entries, notes): 15 MB, JPEG/PNG/HEIC/WebP, unguessable names in
  `R2_PRIVATE`. `services/note-photos.ts`: note photos (`notes/`, served at
  `/v1/documents/photos/:name`; Markdown points at that authenticated URL).
  Publishing writing copies them to `blog/notes/` in the public bucket and the
  post's content points there; the document keeps the private address.
- `middleware/body-limit.ts`: `limitBody(bytes)` for any route that reads a
  body without the bearer token (the WHOOP webhook, the crowd).
- `utils/json.ts` `parseJsonAs(request, schema)`: a body as a Zod schema for
  routes that answer a bad body with their own fixed message (training,
  capture, vault; ADR 0013).
- `src/services/data-versions.ts`: per-kind data versions for ETags.
- `src/schemas/`: Zod schemas (validation and OpenAPI). `openapi.ts` has the
  shared response helpers (`structuredOkResponses`, `cursorQuery`, `pageFields`).
- `src/middleware/`: request logger, error handler, auth, site refresh.
- `migrations/`: D1 migrations, numbered. **Additive only**: new tables,
  columns, indexes, views. Never drop or rewrite; old tables stay even when
  their routes are unmounted.
- `scripts/`: one-off imports, backfills and backups (Node).
- `services/d1-backup.ts`: the monthly D1 backup (1st of the month from 08:00 UTC) to
  the private bucket only, `backups/YYYY-MM-DD/<table>.ndjson.gz` plus
  `manifest.json`, ~2 s and ~4 MiB of small pages per cron tick until done (state in
  `migrations/0047_d1_backups.sql`). `POST /v1/admin/backup` starts one,
  `GET` shows the latest. Backups are never deleted.

## App routes: replies, errors, pages, caching

App-only routes (visits, documents, search, capture, links, highlights,
journal, sections, recipes, training, music history, vault, media, the WHOOP
and Spotify integrations, app sign-in) use `src/lib/http.ts`:

- Each route app is `appErrors(new Hono<…>(), "Links request")`: anything a
  handler throws is answered by `failWith`, so handlers don't wrap themselves
  in try/catch.
- `ok(c, data)`; `fail(c, status, message, { code?, details?, extra? })`;
  `failWith(c, error, "Links request")` for anything thrown (HttpError, Zod
  errors, service errors carrying `status` and maybe `code`; anything else is
  logged and becomes a 500); `body(c, schema?)`, `objectBody(c)` (a JSON
  object or a 400: "Invalid JSON", "Send a JSON object") and `parse(schema,
  value)` throw a 400 on bad input. Never read `parseJson` by hand in an app
  route. A POST that makes something answers 201.
- One error shape: `{ "error": { "code", "message", "details"? } }`. Codes
  follow the status (`invalid`, `not_found`, `conflict`, `too_large`,
  `server`, …) unless a service names its own (`exists`). Extra top-level
  fields are allowed: a stale document save is a 409 with `latest`.
- Lists: `{ items: [...], next_cursor }` via `list()` (the old named keys
  are gone: `docs/adr/0005-legacy-list-keys.md`). Fetch `limit + 1` rows ordered by a sort column plus `id`,
  then `page(rows, limit, (row) => [row.sort, row.id])`; read the cursor back
  with `cursorFrom(c, 2)` (a bad cursor is a 400). `limitFrom(c, default, max)`.
- Places caching: every GET under `/v1/visits` carries a weak ETag built from
  the `places` data version (`migrations/0046_data_versions.sql`) and
  `Cache-Control: private, no-cache`, and answers 304 to a matching
  `If-None-Match`. Every write that changes a visit, journey, place name or
  saved place calls `bumpDataVersion(env, "places")` (in services/places.ts).
  Without the table the reads fall back to the old `max-age` hints. When a
  reply's shape changes without a data change, bump `SHAPE` in routes/visits.ts.
  Rows written straight into D1 (wrangler, scripts) don't bump the version.
  `/footprints` and `/places` are tagged strongly (same bytes for the same
  version and query); the rest stay weak.
- List caching: GETs under `/v1/documents`, `/v1/links`, `/v1/journal`,
  `/v1/shelf`, `/v1/posts` and `/v1/wrapped/summary` get a strong ETag from
  the body's SHA-256 (`middleware/body-etag.ts`) with `private, no-cache`, and
  a 304 on a match. The body is still built; only the transfer is saved. The
  documents list's `server_time` is left out of its tag, which is weak.
- Wrapped: `GET /v1/wrapped/summary?from=&to=&tz=` is one period of the app's
  Wrapped from D1 (`services/wrapped-summary.ts`). A past period is kept in
  `derived_cache` with `data: "daily"` (built again each UTC day); bump
  `BUILD` in routes/wrapped-summary.ts when its rules change.
- Photo thumbnails: with the `IMAGES` binding (off in wrangler.toml), an
  upload also stores `<name>-thumb.webp` beside the original, in the same
  bucket, so photo-privacy.ts moves it with the photo.
- Derived answers: `/trips`, `/chapters` and `/footprints` are kept in
  `derived_cache` (0050) until the places version moves, single-flight, large
  ones in R2_PRIVATE (`services/derived-cache.ts`,
  `docs/adr/0002-derived-cache.md`). Change how one is computed: bump its
  number in `BUILDS` (routes/visits.ts).
- Places days: every day, month and year read groups by `local_date` (written
  at ingest, indexed); `?offset=` is deprecated and only places a row without
  one (`docs/adr/0001-local-date-reads.md`). Rows written straight into D1 must
  set `local_date`.
- Queries that don't depend on each other go in one `env.DB.batch` (one round
  trip, one transaction; ADR 0012). Counts a read would recompute from every
  row are stored beside their source with a fallback until the migration is
  applied: the crowd total (trigger, 0054) and journal word counts per
  document version (0055; ADR 0010).
- WHOOP collection reads compare `isoInstant(time)` (ISO text of the instant),
  indexed by 0053; never `julianday()` in a read that pages (ADR 0009).
- Work that can finish after the reply goes in `later(c)` (waitUntil); a saved
  link's page is fetched that way, so `POST /v1/links` returns at once with
  `fetched_at: null` and no `body`.

## Commands

- `npm install`
- `npm test` (vitest) and `npm run typecheck` (tsc). Both must pass. In the
  agent sandbox run them with the sandbox disabled (node:sqlite and workers).
- `npx wrangler dev` runs the Worker locally against local D1/R2 state in
  `.wrangler/`; `npx wrangler d1 migrations apply personal_api --local` first.
- Deploying, remote migrations (`--remote`) and `wrangler secret` are the
  owner's to run. Take a D1 bookmark (Time Travel) before any remote write.

## Testing

- Route tests build a Hono app around one route and a real SQLite database:
  `testD1({ migrations: [...] | "all", sql })` from
  `src/__tests__/helpers/d1.ts` (prepare/bind/first/all/run/raw, batch as a
  transaction, RETURNING rows from `run()` and `all()`). Use it instead of
  writing another fake.
- Test the behaviour a client sees (status, body, headers), including that
  an old key still carries what it did.

## Style

- TypeScript, ES2022 modules, 2-space indent, no formatter; match the file.
- Routes under `/v1/*`, named for resources. JSON fields that mirror columns
  are `snake_case`; local variables `camelCase`.
- Comments say why, in plain words; no history.

## Configuration

- `wrangler.toml`: bindings (`DB`, `R2_BUCKET` public media, `R2_PRIVATE`,
  `WHOOP_SYNC_QUEUE`), vars, the five-minute cron, `compatibility_date`
  (raise it only after `wrangler dev` starts and a local smoke test passes).
- Secrets are set with `wrangler secret put` (`API_TOKEN`, WakaTime, GitHub,
  Spotify, WHOOP, analytics, optional `UPLOAD_TOKEN_SECRET`). Never commit them; `.dev.vars` is local only.
- `SITE_TOKEN` (optional): the website's read-only token, GET/HEAD of the
  routes in `lib/site-reads.ts` only (`docs/adr/0004-site-token.md`). A route
  the website starts reading goes there too.
- `/health` requires auth and returns `API_VERSION`.
- No or unknown credentials are 401 with `WWW-Authenticate: Bearer`; a
  known token without permission (SITE_TOKEN off the website's reads) is 403
  (`docs/adr/0014-401-and-403.md`).

## Commits and PRs

Focused commits named for the area (`Visits: ...`, `Links: ...`). A PR lists
the endpoints touched, any migration files and any new secrets or vars. No
AI attribution lines.
