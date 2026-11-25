# 0005: Old list keys go, behind LEGACY_LIST_KEYS for one release

Status: accepted, 25 Nov 2026

## Context

App-only lists answered `{ <name>: [...], items: [...], next_cursor }` so the
apps could move to `items` before the named key went: `/v1/links` (`links`),
`/v1/documents` (`documents`), `/v1/visits` (`visits`), `/v1/visits/journeys`
(`journeys`), `/v1/highlights` (`highlights`), `/v1/music/history`
(`plays`), `/v1/training/bests` (`bests`). Every list paid for its items
twice on the wire. The website reads none of these.

The app (../apple) still read the old key in nine places: Wrapped's links,
highlights, documents and music; Home's and the Journal's music; the Music
history screen; Ask's highlights tool; recent visits (`PlacesClient`) and the
Places page (`VisitsClient.Page`). Commit "Lists read items" in the app moved
all of them (with tests on bodies that carry no old key). Builds up to 0.20.1,
installed on the owner's phone and Mac, still read the old keys.

## Decision

- `list()` in lib/http.ts sends `{ items, next_cursor, …extra }` only. The
  old named key comes back only while the `LEGACY_LIST_KEYS` var is `"on"`.
- `wrangler.toml` sets `LEGACY_LIST_KEYS = "on"` for this release. The code's
  default (var missing or anything else) is the end state, so tests and any
  future environment run without the old keys; the compatibility is one
  explicit line of config with a removal date attached to it.
- OpenAPI marks each old key `deprecated` and optional.
- Website routes are untouched (they never used `list()`); the freeze test
  passes unchanged.

Why a flag and not dropping now: a deploy of this API (it also carries the
local_date, cache and SITE_TOKEN work) should not depend on every device
having the new app first. Shipped builds would lose Wrapped's reading,
writing and music, the Music screen and recent visits the moment the keys
went. The flag makes the API deploy safe on its own and the cut-over a
separate, reversible step. A header-negotiated shape was rejected: old builds
can't send it, so the keys would never go.

## Consequences

Order:
1. Ship the app build with "Lists read items" to every device (iPhone and
   Mac DMG).
2. Deploy the API (keys still sent: `LEGACY_LIST_KEYS = "on"`).
3. Set `LEGACY_LIST_KEYS = "off"` in wrangler.toml and deploy (or change the
   var in the dashboard). Roll back by setting it to `"on"`.
4. A release later: delete the var, `legacyListKeys()` and the `key`
   parameter of `list()`, and the deprecated schema fields.

Until step 3, replies are as large as before.
