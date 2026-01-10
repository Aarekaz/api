# Personal API (V1)

Link to Lanyared api (JSON) : https://api.lanyard.rest/v1/users/118623730934087681

Private personal API built for Cloudflare Workers + D1.

## V1 endpoints

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

- `GET /health`
- `GET /v1/profile`
- `PUT /v1/profile`
- `GET /v1/now`
- `PUT /v1/now`
- `GET /v1/settings`
- `PUT /v1/settings`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/notes`
- `POST /v1/notes`
- `GET /v1/events`
- `POST /v1/events`
- `GET /v1/export`
- `GET /v1/status`
- `POST /v1/status/refresh`
- `GET /v1/wakatime`
- `POST /v1/wakatime/refresh`
- `GET /v1/wakatime/hourly`
- `POST /v1/wakatime/hourly/refresh`

## Data model

The API stores JSON fields as `*_json` text columns in D1.

## Cloudflare setup (later)

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
8) Deploy:
   - `npx wrangler deploy`

### Cron (optional)

`wrangler.toml` includes a cron trigger to refresh status snapshots every 5 minutes and WakaTime daily/hourly.

### Local dev (optional)

- `npx wrangler dev src/index.ts`

## Notes

This repo still contains the old `main.py` FastAPI prototype; it can be removed once the new workers API is deployed.
