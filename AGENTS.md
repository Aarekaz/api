# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` contains the Cloudflare Worker entrypoint and all API routes.
- `migrations/` holds D1 schema migrations (e.g., `0001_init.sql`, `0004_wakatime.sql`).
- `wrangler.toml` configures the Worker, D1 binding, cron, and `API_VERSION`.
- `readme.md` documents endpoints and deployment steps.

## Build, Test, and Development Commands
- `npm install` installs dev tooling (Wrangler + TypeScript).
- `npx wrangler dev src/index.ts` runs the Worker locally.
- `npx wrangler deploy` deploys to Cloudflare Workers.
- `npx wrangler d1 migrations apply personal_api --local` applies migrations locally.
- `npx wrangler d1 migrations apply personal_api --remote` applies migrations to D1.

## Coding Style & Naming Conventions
- TypeScript, ES2022 module syntax.
- 2-space indentation (follow existing style in `src/index.ts`).
- API routes are under `/v1/*` and named for resources (e.g., `/v1/wakatime`).
- Use `snake_case` for JSON fields that mirror DB columns; prefer `camelCase` for local TS variables.
- No lint/formatter configured; keep changes consistent with existing file style.

## Testing Guidelines
- No test framework configured yet.
- Validate changes by calling endpoints with `curl` or REST client after deploying.

## Commit & Pull Request Guidelines
- Commit history shows mixed styles (e.g., `feat: ...` and plain sentences). No strict convention enforced.
- Keep commits focused and descriptive; include the feature area (e.g., `feat: add github refresh`).
- If opening a PR, include: summary, endpoints touched, and any new env vars or migrations.

## Security & Configuration Tips
- Never commit secrets; set them via `wrangler secret put` (e.g., `API_TOKEN`, `WAKATIME_API_KEY`).
- Re-run migrations after adding new `migrations/*.sql` files.
- `/health` requires auth and returns `API_VERSION` from `wrangler.toml`.
