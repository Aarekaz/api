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
  never use `src/lib/http.ts`.
- Writes the website shows trigger a page refresh on anuragd.me
  (`middleware/site-refresh.ts`).

## Layout

- `src/index.ts`: the Worker entry. Global middleware, auth on `/v1/*` and
  `/health`, route mounting, and the `scheduled` and `queue` handlers.
- `src/routes/*.ts`: one Hono app per resource. A route checks input, calls a
  service and shapes the reply. Each file also registers its OpenAPI paths
  (`openApiRegistry.registerPath`), served at `/openapi.json` and `/docs`.
- `src/services/*.ts`: SQL and outside calls. `places.ts` holds every
  `/v1/visits` query; `documents.ts`, `links.ts`, `highlights.ts`,
  `sections.ts`, `whoop/`, `spotify/` likewise.
- `src/lib/http.ts`: replies for the app's routes (below).
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
journal, sections, recipes, training, music history) use `src/lib/http.ts`:

- `ok(c, data)`; `fail(c, status, message, { code?, details?, extra? })`;
  `failWith(c, error, "Links request")` for anything thrown (HttpError, Zod
  errors, service errors carrying `status` and maybe `code`; anything else is
  logged and becomes a 500); `body(c, schema?)` and `parse(schema, value)`
  throw a 400 on bad input.
- One error shape: `{ "error": { "code", "message", "details"? } }`. Codes
  follow the status (`invalid`, `not_found`, `conflict`, `too_large`,
  `server`, …) unless a service names its own (`exists`). Extra top-level
  fields are allowed: a stale document save is a 409 with `latest`.
- Lists: `{ <name>: [...], items: [...], next_cursor }`. The old named key
  carries the same items until the apps have moved to `items`; remove it a
  release later. Fetch `limit + 1` rows ordered by a sort column plus `id`,
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
  Spotify, WHOOP, analytics). Never commit them; `.dev.vars` is local only.
- `/health` requires auth and returns `API_VERSION`.

## Commits and PRs

Focused commits named for the area (`Visits: ...`, `Links: ...`). A PR lists
the endpoints touched, any migration files and any new secrets or vars. No
AI attribution lines.
