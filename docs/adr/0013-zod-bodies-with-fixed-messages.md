# 0013: Bodies with their own fixed messages are still Zod schemas

Status: accepted, 26 Nov 2026 (audit-2026-11b)

## Context

Most routes read bodies with `body(c, schema)` (lib/http.ts) or
`readBody(c, schema)` (lib/site-http.ts), which word the error from Zod. A few
answer a bad body with one fixed message the apps show, and so checked fields
by hand on a `Record<string, unknown>`: training (`/pick`, `/routines/:id`,
`/sets`), capture (`/v1/capture`) and vault (`/blobs`, `/file`, `/capture`).
Training is also deliberately forgiving: a field of the wrong type is dropped,
text is trimmed and cut to length.

## Decision

- Those bodies are Zod schemas next to their routes, read with
  `parseJsonAs(request, schema)` (utils/json.ts), which returns Zod's
  `safeParse` result and treats unreadable JSON as `null`, so it fails like any
  wrong shape. The route sends its own message on failure, exactly as before.
- Forgiving fields are `z.unknown().transform(...)` over the same helpers
  (`str`, `num`, `cleanWeekdays`, `cleanExercises`), and a required one adds
  `.refine(v => v !== null)`.
- Where a route names the first wrong field (vault `PUT /file`: path, then
  content, then sha), each field carries its message and `firstMessage(error,
  fallback)` picks the first issue's; the fallback answers a body that isn't an
  object. Zod reports issues in shape order, which is the old check order.
- `__tests__/routes/body-checks.test.ts` pins status, body and what was stored
  for every kind of body (not JSON, `null`, scalars, arrays, each wrong field),
  written before the change.

## Consequences

- `POST`/`PUT /v1/documents` still only check that the body is truthy JSON;
  their field checks live in `services/documents.ts` with ordered per-field
  messages, and a non-object body such as `true` still makes an Untitled note.
  Tightening that is a visible change, so it is listed for the owner.
