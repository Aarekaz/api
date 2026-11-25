# 0004: A read-only SITE_TOKEN for the website

Status: accepted, 25 Nov 2026

## Context

The website (anuragd.me, a Next.js server) and the apps share `API_TOKEN`,
which can do everything: write and delete content, read visits, journal,
health and documents. The website only ever GETs a fixed set of public
routes. A leak from the site's hosting env would hand over the whole API.

## Decision

- An optional secret, `SITE_TOKEN`. In `middleware/auth.ts` a request bearing
  it passes only when it is a GET or HEAD of a path in `lib/site-reads.ts`:
  the website contract's routes (`website-openapi.snapshot.json`) plus the
  reads AGENTS.md lists outside it (`/v1/wrapped/:year`, `/v1/traffic/:year`,
  `/v1/status`, `/v1/music/now`, `/v1/health/whoop/*`). A test walks every
  path in the contract file, so a new contract route without a matching entry
  fails CI rather than breaking the site.
- Anything else with `SITE_TOKEN` is a 403: on a website path (a write) the
  website's old body `{ "error": "…" }`; elsewhere the one shape
  `{ "error": { "code": "forbidden", "message": "…" } }`.
- `API_TOKEN` keeps full access; device sessions are unchanged. Unset
  `SITE_TOKEN` and nothing changes.
- Every bearer comparison (`sameSecret`, also used by sign-out) hashes both
  sides with SHA-256 and compares the digests with an XOR fold, so neither
  content nor length shows in timing; both tokens are always compared.
- The allow-list is code, not derived at runtime from the contract JSON: the
  Worker shouldn't ship test fixtures, and regexes are what let `:year` and
  WHOOP resources through. The test is what ties the two together.

## Rollout (owner)

1. Deploy this API (nothing changes while `SITE_TOKEN` is unset).
2. `openssl rand -hex 32` and `npx wrangler secret put SITE_TOKEN`.
3. Set the website's `API_TOKEN` env var (Vercel, all environments) to that
   value and redeploy the site. The site's code doesn't change: it sends
   whatever `API_TOKEN` it has. Check pages, `/blog`, `/wrapped`, the shelf,
   and the Worker logs for 403s from the site.
4. Optional: rotate `API_TOKEN` (`wrangler secret put API_TOKEN`, then the
   apps' and scripts' copies), so the value the site held before is dead.

Rollback: set the site's env back to `API_TOKEN`.

## Consequences

- A website change that reads a new route must add it to `lib/site-reads.ts`
  (and the contract), or the site gets 403s once it uses SITE_TOKEN.
- The site token can still read everything the site shows publicly, nothing
  more; it can't trigger refreshes or writes.
