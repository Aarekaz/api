# Personal API (V1)

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)
![API Version](https://img.shields.io/endpoint?url=https%3A%2F%2Fapi.anuragd.me%2F)

Private personal API built for Cloudflare Workers + D1.

## V1 endpoints

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

### Core

- `GET /openapi.json` (no auth)
- `GET /health` (auth required)
- `GET /v1/export`

### Profile & Settings

- `GET /v1/profile`
- `PUT /v1/profile`
- `GET /v1/now`
- `PUT /v1/now`
- `GET /v1/settings`
- `PUT /v1/settings`

### Content

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/notes`
- `POST /v1/notes`
- `GET /v1/events`
- `POST /v1/events`
- `GET /v1/posts`
- `POST /v1/posts`
- `GET /v1/photos`
- `POST /v1/photos`
- `POST /v1/photos/upload`

### Portfolio

- `GET /v1/experience`
- `POST /v1/experience`
- `GET /v1/education`
- `POST /v1/education`
- `GET /v1/skills`
- `POST /v1/skills`
- `GET /v1/uses`
- `POST /v1/uses`
- `GET /v1/shelf`
- `POST /v1/shelf`

### Apple Health Data

- `GET /v1/health` - Get daily health metrics (date range)
- `POST /v1/health` - Submit daily health metrics
- `GET /v1/health/{date}` - Get health data for specific date
- `DELETE /v1/health/{date}` - Delete health data for specific date
- `GET /v1/health/heart-rate` - Get heart rate samples
- `POST /v1/health/heart-rate` - Submit heart rate samples (single or batch)
- `GET /v1/health/sleep` - Get sleep sessions
- `POST /v1/health/sleep` - Submit sleep session
- `GET /v1/health/workouts` - Get workout sessions
- `POST /v1/health/workouts` - Submit workout
- `GET /v1/health/summary` - Get health summary with recent data and averages

See [APPLE_HEALTH_EXPORT.md](docs/APPLE_HEALTH_EXPORT.md) for detailed health API documentation.

### External Integrations

- `GET /v1/status` - Latest Lanyard/Discord status
- `POST /v1/status/refresh` - Refresh status snapshot
- `GET /v1/wakatime` - WakaTime daily summaries
- `POST /v1/wakatime/refresh` - Refresh WakaTime daily data
- `POST /v1/wakatime/backfill` - Backfill WakaTime daily data
- `GET /v1/wakatime/hourly` - WakaTime hourly data
- `POST /v1/wakatime/hourly/refresh` - Refresh WakaTime hourly data
- `POST /v1/wakatime/hourly/backfill` - Backfill WakaTime hourly data
- `GET /v1/github` - GitHub contributions
- `POST /v1/github/refresh` - Refresh GitHub contributions
- `POST /v1/github/backfill` - Backfill GitHub contributions
- `POST /v1/refresh` - Refresh all (status, WakaTime, GitHub)

### Analytics & Wrapped

- `GET /v1/wrapped/day` - Daily wrapped stats
- `GET /v1/wrapped/week` - Weekly wrapped stats
- `GET /v1/wrapped/month` - Monthly wrapped stats
- `GET /v1/wrapped/2026` - 2026 wrapped stats

## Data model

The API stores JSON fields as `*_json` text columns in D1.

## Quickstart

Example request:

```bash
curl -H "Authorization: Bearer $API_TOKEN" https://api.anuragd.me/health
```

## Refresh & backfill

- `POST /v1/refresh` refreshes status, WakaTime (daily + hourly), and GitHub if configured.
- Backfill endpoints accept JSON like:

```json
{ "start": "2025-01-01", "end": "2025-12-31" }
```

## Cloudflare setup

### Deploy guide (Workers + D1)

1) Install Wrangler and login:
   - `npm install`
   - `npx wrangler login`
2) Create a D1 database:
   - `npx wrangler d1 create personal_api`
   - Copy the `database_id` into `wrangler.toml`.
3) Run migrations:
   - `npx wrangler d1 migrations apply personal_api --local`
   - `npx wrangler d1 migrations apply personal_api --remote`
4) Set secrets:
   - `npx wrangler secret put API_TOKEN`
5) Set Lanyard user id (optional, for status snapshots):
   - `npx wrangler secret put LANYARD_USER_ID`
6) Set WakaTime API key (optional, for activity snapshots):
   - `npx wrangler secret put WAKATIME_API_KEY`
7) Set WakaTime timezone (optional, for hourly data):
   - `npx wrangler secret put WAKATIME_TIMEZONE`
8) Set GitHub username/token (optional, for wrapped stats):
   - `npx wrangler secret put GITHUB_USERNAME`
   - `npx wrangler secret put GITHUB_TOKEN`
9) Configure R2 (optional, for photo uploads):
   - Create an R2 bucket (example: `personal-api-photos`).
   - Set the bucket name in `wrangler.toml` under `[[r2_buckets]]` for `R2_BUCKET`.
   - Set `R2_PUBLIC_BASE_URL` in `wrangler.toml` (or as a secret) to your public bucket URL.
10) Deploy:
   - `npx wrangler deploy`

### Cron (optional)

`wrangler.toml` includes a cron trigger to refresh status snapshots every 5 minutes and WakaTime daily/hourly. It also sets `API_VERSION`, returned by `/health`.

Link to Lanyard api (JSON): https://api.lanyard.rest/v1/users/{DISCORD_USER_ID}

### Secrets

Use `.env.example` for local values. Never commit real secrets; set them with `wrangler secret put`.

### Local dev (optional)

- `npx wrangler dev src/index.ts`

## Notes

### Photo uploads (R2)

`POST /v1/photos/upload` expects raw image bytes with an `image/*` content type.

Example:

```bash
curl -X POST https://api.anuragd.me/v1/photos/upload \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@./photo.jpg"
```
