# 0007: One module per reply dialect, errors handled once per app

Status: accepted, 26 Nov 2026 (audit-2026-11)

## Context

The API speaks two reply dialects on purpose (AGENTS.md):

- **Website routes** (and their writes, plus a few owner tools that grew up
  with them): `{ "error": "message" }`, sometimes with `details`. The website
  and older tools parse this; it must not change.
- **App routes**: `{ "error": { "code", "message", "details"? } }` via
  `lib/http.ts`.

The code that produced them had grown five ways: `utils/validation.ts` and
`utils/response.ts` for the first; `lib/http.ts`, a hand-written copy in
`routes/site.ts`, and the literal JSON in `routes/journal.ts` for the second.
There was also a third, `types/errors.ts` `ApiError` with a global
`middleware/error-handler.ts`, which never ran: Hono catches an error where a
handler throws it and answers with the app's `onError` (by default a text
500), so a try/catch middleware around `next()` never sees it. On top of that,
56 app handlers each wrapped their body in the same try/catch, and seven
files defined the same one-line `fail` wrapper. The copy-pasted website CRUD
routes repeated the same "Invalid JSON", "Invalid id" and "X not found"
replies and one `hasOwnProperty` block per PATCH column (102 in all).

## Decision

- **`lib/http.ts`** is the app dialect, and only that: `ok`, `fail`,
  `failWith`, `parse`, `body`, lists and cursors, ETags. New:
  `appErrors(app, "Links request")` registers `app.onError(failWith)` on a
  route app, so handlers just throw (`HttpError`, Zod errors, a service
  error with `status` and `code`). Hono applies an app's `onError` to its
  routes wherever the app is mounted, and only to them.
- **`lib/site-http.ts`** is the website dialect: `readBody(c, schema)`
  (`"Invalid JSON"`, then `"Validation error"` with Zod's `flatten()`),
  `validateBody`, `validateQuery`, `idParam`, `badId`, `notFound`. It returns
  Responses for early return rather than throwing, as these handlers always
  have. Its validation replies keep their `content-type:
  application/json; charset=utf-8`; the others `c.json`'s.
- **`utils/query.ts patchAssignments(data, columns)`** builds a PATCH's `SET`
  list from the fields present, with per-column renames and transforms
  (`mapJsonField`, `publishedFlag`).
- **One limit rule**, `clampLimit` (floor, at least 1, at most the max, the
  default for 0 or junk), used by `parseListQuery`, `limitFrom` and every
  other list. A negative limit had reached SQL as "no limit".
- `lib/` holds request helpers (they take a Context); `utils/` stays pure.
- No global error middleware. An uncaught error on a website route is still
  Hono's text 500 (pinned by `website-crud.test.ts`); making it JSON is a
  visible change left to the owner.

The website CRUD routes were characterised first
(`__tests__/routes/website-crud.test.ts`: status, content type and exact
body for every step and error, by snapshot) and the snapshots did not change
with the migration.

## Consequences

- A new app route: `const app = appErrors(new Hono<…>(), "Thing request")`,
  then throw; no try/catch unless the handler answers an error specially
  (documents' 409 with `latest`).
- A new website route: `readBody`, `idParam`/`badId`, `notFound`, and
  `patchAssignments` for PATCH.
- An unexpected throw in an app route that had no try/catch (none were left
  in the migrated files, but a few handlers had relied on Hono's text 500)
  now answers the one JSON shape with a 500.
- Vault, media and the integration routes still answer `{ error: string }`
  though only the apps call them; moving them is the owner's call
  (docs/audit-2026-11.md, section 11).
