# 0011: Unauthenticated writes and uploads have a size limit

Status: accepted, 26 Nov 2026 (audit-2026-11b)

## Context

Three writes take a body from callers without the bearer token: the WHOOP
webhook (`/integrations/whoop/webhook`), the crowd (`POST /v1/crowd`) and the
presigned uploads (`PUT /v1/{photos,blog-images}/upload-presigned`, which
carry an HMAC token instead). None had a size limit, and the webhook read the
whole body before it checked the signature.

## Decision

- `middleware/body-limit.ts` `limitBody(bytes)` wraps Hono's `bodyLimit`: a
  declared Content-Length over the limit is a 413 before anything is read; a
  body without one is cut off as it streams past the limit. The reply is
  `{ "error": "Payload too large" }`, the dialect these public routes already
  use. Limits: 64 KB for the webhook (an event is four short fields), 8 KB for
  the crowd (`{ id }`). A crowd body cut off mid-stream falls back to network
  identity, as an unreadable body always has.
- `services/upload-token.ts` `UPLOAD_LIMITS` holds every upload cap: direct
  uploads 10 MB (photos) and 5 MB (blog images), as before; presigned uploads
  50 MB and 25 MB. The presigned path exists to get past the OS proxy's 4.5 MB
  limit, so its caps sit well above a full-size camera JPEG or a Retina
  screenshot. `declaresMoreThan(contentLength, max)` is the check: the runtime
  holds a body to its declared length, and R2 can't store a body of unknown
  length, so the header is enough. Over the cap is `413 { "error": "File too large" }`.

## Consequences

- A new unauthenticated route that reads a body uses `limitBody`.
- Raising a cap is a one-line change in `UPLOAD_LIMITS`.
- Still open (owner): SVG uploads, single-use tokens and a signing secret of
  their own (audit 7.4).
