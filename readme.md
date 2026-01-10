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
5) Deploy:
   - `npx wrangler deploy`

### Local dev (optional)

- `npx wrangler dev src/index.ts`

## Notes

This repo still contains the old `main.py` FastAPI prototype; it can be removed once the new workers API is deployed.
