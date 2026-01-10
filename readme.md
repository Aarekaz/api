# Personal API (V1)

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

1) Create a D1 database and replace `database_id` in `wrangler.toml`.
2) Apply migrations from `migrations/`.
3) Set `API_TOKEN` as a secret.

## Notes

This repo still contains the old `main.py` FastAPI prototype; it can be removed once the new workers API is deployed.
