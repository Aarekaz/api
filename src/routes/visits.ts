import { Hono, type Context } from "hono";
import type { Env } from "../types/env";
import { z } from "zod";
import {
  apiTags,
  authSecurity,
  dateSchema,
  openApiJsonRequestBody,
  openApiRegistry,
  structuredCreatedResponses,
  structuredOkResponses,
} from "../schemas/openapi";
import { appErrors, cursorFrom, fail, failWith, limitFrom, list, notModified, objectBody, ok, page, shortHash } from "../lib/http";
import { dataVersion } from "../services/data-versions";
import { derived, type DerivedSpec } from "../services/derived-cache";
import {
  addJourneys, addSaved, addVisits, chapters, cleanJourney, cleanSaved, cleanVisit, correctJourneyMode, correctVisit,
  deleteSaved, flights, footprints, isDate, listJourneys, listPlaces, listSaved, listTrips, listVisits, offsetOf,
  onThisDay, PLACE_KEY, saveNames, str, TRAVEL_MODES, updateSaved, visitDay, visitDays, visitMonths, visitSources,
  visitsAt, visitYears, type CleanJourney, type CleanVisit, type JourneyInput, type VisitInput,
} from "../services/places";
import { isDay } from "../utils/date";

export { cleanJourney, cleanSaved, cleanVisit, findTrips, TRAVEL_MODES, type AwayDay } from "../services/places";

// /v1/visits: places you've been. The phone posts visits as they happen;
// imports (photos, Google Timeline) post them in batches. Safe to repeat.
// The SQL is in services/places.ts. App-only: errors are { error: { code, message } },
// and every GET carries an ETag from the "places" data version (304 when unchanged).
// Anything a handler doesn't catch itself is a JSON 500 in the one shape.
const app = appErrors(new Hono<{ Bindings: Env }>(), "Visits request");

// The Places guide agents read in /openapi.json; routes/location.ts shares the tag.
const TAG = "Places";
apiTags.push({
  name: TAG,
  description: `Where you've been: visits (stops), journeys (the trips between them), place names, the places you define, \
and the live location. Private: nothing here is shown on anuragd.me.

**The iPhone app records this, not you.** It posts visits as they happen (\`source: "visit"\`), and imports from photos \
(\`"photos"\`) and Google Timeline (\`"google-timeline"\`, visits and journeys). It also posts place names it looks up \
(POST /v1/visits/names). Don't post visits, journeys or names with those sources: the app owns them.

**What you may do by hand.**
- Correct a visit: PATCH /v1/visits/{id} with \`hidden: true\` (it wasn't a visit), a \`note\`, or \`move_to\` (where you really were). \
Visits are never deleted; hiding takes one out of every view.
- Correct how a journey was travelled: PATCH /v1/visits/journeys/{id} { \`mode\` }, one of the listed modes.
- Define a place (home, work, a gym): GET /v1/visits/saved first. If it is already there, PATCH it rather than adding a \
second; if not, POST /v1/visits/saved. Visits inside its circle, in its months, count as it. \`kind: "hidden"\` marks somewhere that isn't \
a place (a road, a car park): its time stops counting.
- Add a visit the phone missed, only when asked: POST /v1/visits with your own \`source\` (not one of the app's) and a stable \
\`source_key\`, so sending it again changes nothing.

**Live location.** GET /v1/location/latest is where you are now (Today and the weather read it). The phone's live visits \
add to it on their own, and an iOS Shortcut may POST /v1/location. Don't post points by hand or backfill history there: \
past places are visits.

**Order.** Read before you write: GET /v1/visits/day?date= or /v1/visits/at?key= to find the visit's \`id\`. Posting is safe to \
repeat: a repeat (same \`source_key\`) is ignored, except that it can fill in a missing \`departed_at\`.

**Avoid.** Writing rows straight into D1 (they skip \`local_date\` and the cache version). The \`offset\` query is deprecated: \
days come from each row's \`local_date\`. A live visit (\`source: "visit"\`) from the last six hours also becomes the latest \
location, so don't fake one. No uploads here.`,
});

// OpenAPI registrations. Posted visits and journeys are cleaned, not
// validated: invalid items are skipped and counted in `valid`.
const placeKey = z.string().regex(/^-?\d+\.\d{3},-?\d+\.\d{3}$/).openapi({
  description: "Grid cell of about 110 m: printf('%.3f,%.3f', lat, lng)",
  example: "38.898,-77.037",
});
// Deprecated: days and months come from each row's local_date (where it
// happened). The offset is still accepted, and only places a row that has no
// local_date (docs/adr/0001-local-date-reads.md).
const offset = z.coerce.number().int().min(-840).max(840).optional().openapi({
  description: "Deprecated. Local minutes from UTC, used only for a row without local_date (default 0)",
  param: { deprecated: true },
});

const visitSchema = z.object({
  id: z.number().int(),
  latitude: z.number(),
  longitude: z.number(),
  arrived_at: z.string(),
  departed_at: z.string().nullable(),
  place: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  source: z.string(),
  source_key: z.string(),
  utc_offset: z.number().int().nullable().openapi({ description: "Minutes from UTC where it happened (Kathmandu 345); null if unknown" }),
  local_date: z.string().nullable().optional().openapi({ format: "date", description: "Local date it began where it happened (its utc_offset, else New York); null on rows from before it was kept, until the backfill" }),
  note: z.string().nullable().optional().openapi({ description: "Your note on this visit" }),
  created_at: z.string(),
});
const visitWithNameSchema = visitSchema.extend({
  key: z.string(),
  place_name: z.string().nullable(),
  place_city: z.string().nullable(),
});

const placeNameSchema = z.object({
  key: z.string(),
  name: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  category: z.string().nullable(),
  map_item_id: z.string().nullable(),
  updated_at: z.string(),
});

const journeySchema = z.object({
  id: z.number().int(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  start_lat: z.number().nullable(),
  start_lng: z.number().nullable(),
  end_lat: z.number().nullable(),
  end_lng: z.number().nullable(),
  distance_m: z.number().nullable(),
  mode: z.string().nullable(),
  points_json: z.string().nullable().openapi({ description: "JSON array of [lat, lng(, t)] points" }),
  source: z.string(),
  source_key: z.string(),
  utc_offset: z.number().int().nullable().openapi({ description: "Minutes from UTC where it happened (Kathmandu 345); null if unknown" }),
  local_date: z.string().nullable().optional().openapi({ format: "date", description: "Local date it began where it happened (its utc_offset, else New York); null on rows from before it was kept, until the backfill" }),
  created_at: z.string(),
});

const batchResultSchema = z.object({
  received: z.number().int(),
  valid: z.number().int(),
  added: z.number().int().openapi({ description: "New rows; repeats are ignored" }),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits",
  tags: [TAG],
  summary: "List visits, newest first, with counts per source",
  security: authSecurity,
  request: {
    query: z.object({
      start: z.string().optional().openapi({ description: "ISO time (default the beginning)" }),
      end: z.string().optional().openapi({ description: "ISO time (default now)" }),
      limit: z.coerce.number().int().min(1).max(5000).optional().openapi({ description: "Default 500" }),
      cursor: z.string().optional().openapi({ description: "next_cursor from the page before" }),
    }),
  },
  responses: structuredOkResponses(z.object({
    sources: z.array(z.object({ source: z.string(), n: z.number().int(), first: z.string() })),
    items: z.array(visitSchema),
    next_cursor: z.string().nullable().openapi({ description: "Pass as ?cursor= for the next page; null on the last" }),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits",
  tags: [TAG],
  summary: "Add visits (up to 500 at a time; safe to repeat)",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      visits: z.array(z.object({
        latitude: z.number().min(-90).max(90).openapi({ description: "Where you were" }),
        longitude: z.number().min(-180).max(180).openapi({ description: "Where you were" }),
        arrived_at: z.string().openapi({ description: "ISO time you arrived" }),
        departed_at: z.string().nullable().optional().openapi({
          description: "ISO time you left; leave it out while still there. Sending the visit again with it fills it in",
        }),
        place: z.string().max(300).nullable().optional().openapi({ description: "The place's name, if known" }),
        address: z.string().max(300).nullable().optional().openapi({ description: "Street address, if known" }),
        city: z.string().max(120).nullable().optional(),
        country: z.string().max(120).nullable().optional(),
        source: z.string().max(40).openapi({
          description: "Where it came from. The app uses \"visit\" (live, from the phone), \"photos\" and \"google-timeline\"; "
            + "anything added by hand uses its own word",
        }),
        source_key: z.string().max(200).nullable().optional().openapi({
          description: "A stable id for this visit; a repeat with the same key is ignored. "
            + "Without it the key is source, arrival and rough position",
        }),
        utc_offset: z.number().int().min(-840).max(840).nullable().optional().openapi({ description: "Minutes from UTC where it happened" }),
      })).min(1).max(500),
    })),
  },
  responses: structuredOkResponses(batchResultSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/places",
  tags: [TAG],
  summary: "List places (grouped visits), most visited first",
  security: authSecurity,
  request: {
    query: z.object({
      year: z.string().regex(/^\d{4}$/).optional(),
      from: z.string().optional().openapi({ description: "ISO time" }),
      to: z.string().optional().openapi({ description: "ISO time" }),
    }),
  },
  responses: structuredOkResponses(z.object({
    places: z.array(z.object({
      key: z.string(),
      lat: z.number(),
      lng: z.number(),
      visits: z.number().int(),
      minutes: z.number().int().openapi({ description: "Time spent, each visit capped at a day" }),
      first: z.string(),
      last: z.string(),
      name: z.string().nullable(),
      label: z.string().nullable(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      category: z.string().nullable(),
      map_item_id: z.string().nullable(),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/years",
  tags: [TAG],
  summary: "Count visits and places per year",
  security: authSecurity,
  responses: structuredOkResponses(z.object({
    years: z.array(z.object({ year: z.string(), visits: z.number().int(), places: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/months",
  tags: [TAG],
  summary: "Count visits and places per month",
  security: authSecurity,
  request: { query: z.object({ offset }) },
  responses: structuredOkResponses(z.object({
    months: z.array(z.object({ month: z.string(), visits: z.number().int(), places: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/at",
  tags: [TAG],
  summary: "List one place's visits, newest first",
  security: authSecurity,
  request: { query: z.object({ key: placeKey }) },
  responses: structuredOkResponses(z.object({
    key: z.string(),
    name: placeNameSchema.nullable(),
    visits: z.array(visitSchema),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/on-this-day",
  tags: [TAG],
  summary: "List visits on this month and day in every year",
  security: authSecurity,
  request: {
    query: z.object({
      md: z.string().regex(/^\d{2}-\d{2}$/).openapi({ example: "11-23" }),
      offset,
    }),
  },
  responses: structuredOkResponses(z.object({ visits: z.array(visitWithNameSchema) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/days",
  tags: [TAG],
  summary: "List days that have visits, with counts",
  security: authSecurity,
  request: { query: z.object({ year: z.string().regex(/^\d{4}$/).optional(), offset }) },
  responses: structuredOkResponses(z.object({
    days: z.array(z.object({ day: dateSchema, visits: z.number().int(), places: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/day",
  tags: [TAG],
  summary: "Get one local day's visits and the journeys between them",
  security: authSecurity,
  request: { query: z.object({ date: dateSchema.openapi({ example: "2024-05-01" }), offset }) },
  responses: structuredOkResponses(z.object({
    date: dateSchema,
    start: z.string(),
    end: z.string(),
    visits: z.array(visitWithNameSchema),
    journeys: z.array(journeySchema),
  })),
});

const chapterPlace = z.object({
  key: z.string(), name: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable(),
  lat: z.number(), lng: z.number(), hours: z.number(), visits: z.number().int(),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/flights",
  tags: [TAG],
  summary: "List every flight (journeys flown), oldest first",
  security: authSecurity,
  responses: structuredOkResponses(z.object({ flights: z.array(z.record(z.string(), z.unknown())) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/chapters",
  tags: [TAG],
  summary: "Your eras: where home was each stretch, where the days went, the places you kept going to, how you got around",
  security: authSecurity,
  responses: structuredOkResponses(z.object({
    chapters: z.array(z.object({
      start: z.string().openapi({ description: "First month, YYYY-MM" }),
      end: z.string().openapi({ description: "Last month, YYYY-MM" }),
      months: z.number().int(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      home: chapterPlace,
      anchor: chapterPlace.nullable().openapi({ description: "Where most days went (school, work), if anywhere stands out" }),
      haunts: z.array(chapterPlace),
      visits: z.number().int(),
      newPlaces: z.number().int(),
      km: z.number().openapi({ description: "Distance moved on the ground" }),
      modes: z.array(z.object({ mode: z.string(), km: z.number() })),
    })),
  })),
});

const savedPlace = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: z.enum(["home", "work", "school", "gym", "other", "hidden"]),
  latitude: z.number(),
  longitude: z.number(),
  radius_m: z.number().int().openapi({ description: "Everything within this many metres is this place (25 to 2000)" }),
  address: z.string().nullable(),
  starts_on: z.string().nullable().openapi({ description: "First month it applies, YYYY-MM; null for always" }),
  ends_on: z.string().nullable().openapi({ description: "Last month it applies, YYYY-MM; null for still" }),
  note: z.string().nullable().openapi({ description: "A line of context: \"Dad's office\"" }),
  created_at: z.string(),
  updated_at: z.string(),
});
const savedPlaceInput = z.object({
  name: z.string().min(1).max(120).openapi({ description: "What you call it: \"Home\", \"Mom's\"" }),
  kind: z.enum(["home", "work", "school", "gym", "other", "hidden"]).optional().openapi({
    description: "Default \"other\". \"hidden\" is somewhere that isn't a place (a road, a car park): its time doesn't count",
  }),
  latitude: z.number().min(-90).max(90).openapi({ description: "The centre" }),
  longitude: z.number().min(-180).max(180).openapi({ description: "The centre" }),
  radius_m: z.number().int().min(25).max(2000).optional().openapi({ description: "Metres around the centre that count as this place. Default 150" }),
  address: z.string().max(300).nullable().optional(),
  starts_on: z.string().nullable().optional().openapi({ description: "First month it applies, YYYY-MM; null for always (a home you moved into)" }),
  ends_on: z.string().nullable().optional().openapi({ description: "Last month it applies, YYYY-MM; null for still" }),
  note: z.string().max(500).nullable().optional().openapi({ description: "A line of context: \"Dad's office\"" }),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/footprints",
  tags: [TAG],
  summary: "Your footprints for a heat layer: time spent per ~50 m cell, and every ground journey's path",
  security: authSecurity,
  responses: structuredOkResponses(z.object({
    spots: z.array(z.array(z.number())).openapi({ description: "[lat, lng, hours]" }),
    paths: z.array(z.object({ mode: z.string().nullable(), points: z.array(z.number()).openapi({ description: "lat, lng, lat, lng, …" }) })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/saved",
  tags: [TAG],
  summary: "List the places you defined (a centre, a radius, a name, the months it applies)",
  security: authSecurity,
  responses: structuredOkResponses(z.object({ places: z.array(savedPlace) })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits/saved",
  tags: [TAG],
  summary: "Save a place of your own: visits inside its circle, in its months, count as it",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(savedPlaceInput) },
  responses: structuredCreatedResponses(savedPlace),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/visits/journeys/{id}",
  tags: [TAG],
  summary: "Correct how you travelled on a trip (a bus, not a car)",
  security: authSecurity,
  request: {
    params: z.object({ id: z.string() }),
    body: openApiJsonRequestBody(z.object({
      mode: z.string().openapi({ description: `How you travelled, one of: ${TRAVEL_MODES.join(", ")}` }),
    })),
  },
  responses: structuredOkResponses(z.record(z.string(), z.unknown())),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/visits/{id}",
  tags: [TAG],
  summary: "Correct a visit: hide it (it wasn't a visit), add a note, or move it to where you really were",
  security: authSecurity,
  request: {
    params: z.object({ id: z.string() }),
    body: openApiJsonRequestBody(z.object({
      hidden: z.boolean().optional().openapi({ description: "true: it wasn't a visit; it leaves every view but stays stored. false brings it back" }),
      note: z.string().max(500).nullable().optional().openapi({ description: "Your note on the visit; null clears it" }),
      move_to: z.object({ latitude: z.number(), longitude: z.number() }).optional().openapi({
        description: "Where you really were; the old spot is kept as the guess",
      }),
    })),
  },
  responses: structuredOkResponses(visitSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/visits/saved/{id}",
  tags: [TAG],
  summary: "Change a place you saved",
  security: authSecurity,
  request: { params: z.object({ id: z.string() }), body: openApiJsonRequestBody(savedPlaceInput.partial()) },
  responses: structuredOkResponses(savedPlace),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/visits/saved/{id}",
  tags: [TAG],
  summary: "Remove a place you saved (the visits stay)",
  security: authSecurity,
  request: { params: z.object({ id: z.string() }) },
  responses: structuredOkResponses(z.object({ deleted: z.boolean() })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/trips",
  tags: [TAG],
  summary: "List trips: days roughly 100 km or more from home, grouped",
  security: authSecurity,
  request: { query: z.object({ offset }) },
  responses: structuredOkResponses(z.object({
    trips: z.array(z.object({
      start: dateSchema,
      end: dateSchema,
      days: z.number().int(),
      visits: z.number().int(),
      places: z.number().int(),
      lat: z.number(),
      lng: z.number(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      bounds: z.object({
        min_lat: z.number(),
        max_lat: z.number(),
        min_lng: z.number(),
        max_lng: z.number(),
      }),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits/names",
  tags: [TAG],
  summary: "Save place names looked up on a device (up to 500)",
  description: "Missing fields keep what's already stored. Items with an invalid key are skipped.",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      names: z.array(z.object({
        key: placeKey,
        name: z.string().max(200).nullable().optional().openapi({ description: "The place's name; left out keeps the stored one" }),
        city: z.string().max(120).nullable().optional(),
        country: z.string().max(120).nullable().optional(),
        category: z.string().max(80).nullable().optional().openapi({ description: "Apple Maps' point-of-interest category" }),
        map_item_id: z.string().max(300).nullable().optional().openapi({ description: "Apple Maps' place ID" }),
      })).min(1).max(500),
    })),
  },
  responses: structuredOkResponses(z.object({ received: z.number().int(), saved: z.number().int() })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/journeys",
  tags: [TAG],
  summary: "Trips between visits in a time range (no raw path traces), oldest first",
  security: authSecurity,
  request: { query: z.object({ start: z.string().optional(), end: z.string().optional(), limit: z.coerce.number().int().optional(),
    cursor: z.string().optional().openapi({ description: "next_cursor from the page before" }) }) },
  responses: structuredOkResponses(z.object({
    items: z.array(z.record(z.string(), z.unknown())),
    next_cursor: z.string().nullable(),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits/journeys",
  tags: [TAG],
  summary: "Add journeys (up to 500 at a time; safe to repeat)",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      journeys: z.array(z.object({
        started_at: z.string().openapi({ description: "ISO time it began" }),
        ended_at: z.string().nullable().optional().openapi({ description: "ISO time it ended" }),
        start_lat: z.number().nullable().optional(),
        start_lng: z.number().nullable().optional(),
        end_lat: z.number().nullable().optional(),
        end_lng: z.number().nullable().optional(),
        distance_m: z.number().nullable().optional().openapi({ description: "Metres travelled" }),
        mode: z.string().max(40).nullable().optional().openapi({ description: `How you travelled, lowercased: ${TRAVEL_MODES.join(", ")}` }),
        points: z.array(z.array(z.number()).min(2).max(3)).max(2000).nullable().optional()
          .openapi({ description: "[lat, lng] or [lat, lng, t] points" }),
        source: z.string().max(40).openapi({ description: "Where it came from; the app's import uses \"google-timeline\"" }),
        source_key: z.string().max(200).nullable().optional().openapi({
          description: "A stable id; a repeat with the same key is ignored. Without it the key is source, start and mode",
        }),
        utc_offset: z.number().int().min(-840).max(840).nullable().optional().openapi({ description: "Minutes from UTC where it happened" }),
      })).min(1).max(500),
    })),
  },
  responses: structuredOkResponses(batchResultSchema),
});

// ---------------------------------------------------------------------------
// Conditional GETs. Every read here depends only on the stored rows (and the
// query), so the "places" version, bumped on each write, makes a correct ETag.
// /journeys defaults to "the last 30 days", a window that slides with the
// clock, so it is tagged only when its start is given. (GET / ends at "now" by
// default; only a visit stored with a future arrival could appear without a
// write, which the phone and the imports don't send.)

const SHAPE = 3; // bump when a reply's shape changes without a data change
const STRONG = /\/(footprints|places)$/;
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const url = new URL(c.req.url);
  if (url.pathname.endsWith("/journeys") && !url.searchParams.has("start")) return next();
  const version = await dataVersion(c.env, "places");
  if (version === null) return next();
  const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
  // Footprints (kept in derived_cache) and places are the same bytes for the same version and query,
  // so their tag is strong; the rest stay weak.
  const weak = STRONG.test(url.pathname) ? "" : "W/";
  const tag = `${weak}"places-${version}-${shortHash(`${SHAPE}|${c.env.API_VERSION ?? ""}|${url.pathname}?${query}`)}"`;
  tagged.add(c.req.raw);
  const unchanged = notModified(c, tag);
  if (unchanged) return unchanged;
  await next();
  // Only a successful body is worth revalidating; an error goes out untagged.
  if (c.res.status !== 200) { c.res.headers.delete("ETag"); c.res.headers.delete("Cache-Control"); }
});
const tagged = new WeakSet<Request>();

/** The old freshness hint, for a database without data_versions yet. An ETag'd reply keeps no-cache. */
const cached = (c: { req: { raw: Request }; header: (k: string, v: string) => void }, seconds: number) => {
  if (!tagged.has(c.req.raw)) c.header("Cache-Control", `private, max-age=${seconds}`);
};

/**
 * Trips, chapters and footprints read every visit, so their answers are kept
 * in derived_cache until the places data moves (services/derived-cache.ts).
 * Bump a build's number when its code changes what it returns; SHAPE and
 * API_VERSION are part of every key too. X-Derived-Cache says how it was found.
 */
const BUILDS = { trips: 1, chapters: 1, footprints: 1 } as const;
async function derivedReply(
  c: Context<{ Bindings: Env }>, name: keyof typeof BUILDS, params: string, build: DerivedSpec["build"], seconds: number,
) {
  const found = await derived(c.env, { name, params, data: "places", shape: `${BUILDS[name]}|${SHAPE}|${c.env.API_VERSION ?? ""}`, build });
  cached(c, seconds);
  return c.body(found.body, 200, { "Content-Type": "application/json", "Content-Length": String(found.bytes), "X-Derived-Cache": found.source });
}

/** Trips at this offset, from the same derived_cache row GET /trips keeps (Wrapped reads them too). */
export async function cachedTrips(env: Env, offset: number): Promise<Array<Record<string, unknown>>> {
  const found = await derived(env, {
    name: "trips", params: `offset=${offset}`, data: "places", shape: `${BUILDS.trips}|${SHAPE}|${env.API_VERSION ?? ""}`,
    build: async () => ({ trips: await listTrips(env, offset) }),
  });
  const text = typeof found.body === "string" ? found.body : await new Response(found.body).text();
  return (JSON.parse(text) as { trips: Array<Record<string, unknown>> }).trips;
}

const isoOr = (v: string | undefined, fallback: string) => (isDate(v) ? new Date(v!).toISOString() : fallback);
const YEAR = /^\d{4}$/;
/** Each item cleaned; one that isn't an object (null, 3, "x") is dropped like any invalid one. */
const cleanAll = <I, O>(items: I[], clean: (item: I) => O | null) =>
  items.map((item) => (isObject(item) ? clean(item) : null)).filter((v): v is O => v !== null);
const isObject = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

app.get("/", async (c) => {
  try {
    const limit = limitFrom(c, 500, 5000);
    const after = cursorFrom(c, 2) as [string, number] | null;
    const rows = await listVisits(c.env, {
      start: isoOr(c.req.query("start"), "1970-01-01T00:00:00.000Z"), end: isoOr(c.req.query("end"), new Date().toISOString()), limit, after,
    });
    const { items, next_cursor } = page(rows, limit, (v) => [v.arrived_at, v.id]);
    return list(c, items, next_cursor, { sources: await visitSources(c.env) });
  } catch (error) {
    return failWith(c, error, "Visits request");
  }
});

/** POST { visits: [...] } up to 500 at a time. Repeats are ignored, but can fill in a missing departure. */
app.post("/", async (c) => {
  try {
    const b = (await objectBody(c)) as { visits?: unknown };
    const items = Array.isArray(b?.visits) ? (b.visits as VisitInput[]) : null;
    if (!items || items.length === 0 || items.length > 500) return fail(c, 400, "Send visits: 1 to 500 items");
    const clean = cleanAll<VisitInput, CleanVisit>(items, cleanVisit);
    return ok(c, { received: items.length, valid: clean.length, added: await addVisits(c.env, clean) });
  } catch (error) {
    return failWith(c, error, "Visits request");
  }
});

/** PATCH /v1/visits/journeys/:id { mode }: you know how you travelled better than the motion sensor (a bus isn't a car). */
app.patch("/journeys/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return fail(c, 400, "Invalid id");
    const b = (await objectBody(c)) as { mode?: unknown };
    const mode = typeof b?.mode === "string" ? b.mode : "";
    if (!(TRAVEL_MODES as readonly string[]).includes(mode)) return fail(c, 400, `mode must be one of: ${TRAVEL_MODES.join(", ")}`);
    const row = await correctJourneyMode(c.env, id, mode);
    return row ? ok(c, row) : fail(c, 404, "Not found");
  } catch (error) {
    return failWith(c, error, "Journey request");
  }
});

/**
 * PATCH /v1/visits/:id { hidden?, note?, move_to?: { latitude, longitude } }:
 * your corrections. Hidden visits leave every view but stay in the table; a
 * moved visit keeps its old spot in guess_latitude/guess_longitude.
 */
app.patch("/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return fail(c, 400, "Invalid id");
    const b = (await objectBody(c).catch(() => null)) as { hidden?: unknown; note?: unknown; move_to?: { latitude?: unknown; longitude?: unknown } } | null;
    if (!b) return fail(c, 400, "Send hidden, note or move_to");
    let moveTo: { latitude: number; longitude: number } | undefined;
    if (b.move_to) {
      const lat = Number(b.move_to.latitude), lng = Number(b.move_to.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail(c, 400, "move_to needs latitude and longitude");
      moveTo = { latitude: lat, longitude: lng };
    }
    const hidden = typeof b.hidden === "boolean" ? b.hidden : undefined;
    const note = b.note !== undefined ? str(b.note, 500) : undefined;
    if (hidden === undefined && note === undefined && !moveTo) return fail(c, 400, "Nothing to change");
    const row = await correctVisit(c.env, id, { hidden, note, moveTo });
    return row ? ok(c, row) : fail(c, 404, "Not found");
  } catch (error) {
    return failWith(c, error, "Visit request");
  }
});

// ---------------------------------------------------------------------------
// The map. Visits are grouped into places by a ~110 m grid cell: the key is
// printf('%.3f,%.3f', lat, lng), the same string the apps build.

/** Places, most visited first. ?year=2024 or ?from=&to= (ISO) narrow the visits counted. */
app.get("/places", async (c) => {
  const year = c.req.query("year");
  const places = await listPlaces(c.env, {
    year: year && YEAR.test(year) ? year : undefined,
    from: isDate(c.req.query("from")) ? new Date(c.req.query("from")!).toISOString() : undefined,
    to: isDate(c.req.query("to")) ? new Date(c.req.query("to")!).toISOString() : undefined,
  });
  cached(c, 300);
  return ok(c, { places });
});

/** Visits per year, for the map's year scrubber. */
app.get("/years", async (c) => {
  const years = await visitYears(c.env);
  cached(c, 300);
  return ok(c, { years });
});

/** Visits per month, for the map's timeline. ?offset= minutes from UTC for local months. */
app.get("/months", async (c) => {
  const months = await visitMonths(c.env, offsetOf(c.req.query("offset")));
  cached(c, 300);
  return ok(c, { months });
});

/** One place's visits, newest first. ?key=38.898,-77.037 */
app.get("/at", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!PLACE_KEY.test(key)) return fail(c, 400, "key must look like 38.898,-77.037");
  const { name, visits } = await visitsAt(c.env, key);
  return ok(c, { key, name, visits });
});

/** Where you were on this date in past years. ?md=11-23&offset=-300 (local minutes from UTC). */
app.get("/on-this-day", async (c) => {
  const md = c.req.query("md") ?? "";
  if (!/^\d{2}-\d{2}$/.test(md)) return fail(c, 400, "md must look like 11-23");
  return ok(c, { visits: await onThisDay(c.env, md, offsetOf(c.req.query("offset"))) });
});

/** Days that have visits, with counts. ?year=2024&offset=-300 */
app.get("/days", async (c) => {
  const year = c.req.query("year");
  const days = await visitDays(c.env, year && YEAR.test(year) ? year : null, offsetOf(c.req.query("offset")));
  cached(c, 300);
  return ok(c, { days });
});

/** One day: its visits and the journeys between them, in order. ?date=2024-05-01&offset=-240 */
app.get("/day", async (c) => {
  const date = c.req.query("date") ?? "";
  if (!isDay(date)) return fail(c, 400, "date must look like 2024-05-01");
  return ok(c, await visitDay(c.env, date, offsetOf(c.req.query("offset"))));
});

/** Footprints for the map's heat layer (see services/places.ts). */
app.get("/footprints", (c) => derivedReply(c, "footprints", "", () => footprints(c.env), 6 * 3600));

/** Every flight, oldest first: the arcs of your travels. */
app.get("/flights", async (c) => {
  const body = { flights: await flights(c.env) };
  cached(c, 3600);
  return ok(c, body);
});

/** Your eras: where home was, where the days went, how you got around. See services/chapters.ts. */
// Changes to your own places show at once, so the old hint was a minute, not an hour.
app.get("/chapters", (c) => derivedReply(c, "chapters", "", async () => ({ chapters: await chapters(c.env) }), 60));

/** Trips: days roughly 100 km or more from home, grouped. ?offset=-300 */
app.get("/trips", (c) => {
  const offset = offsetOf(c.req.query("offset"));
  return derivedReply(c, "trips", `offset=${offset}`, async () => ({ trips: await listTrips(c.env, offset) }), 600);
});

// Places you define: a centre and a radius (see services/chapters.ts applySaved).

app.get("/saved", async (c) => ok(c, { places: await listSaved(c.env) }));

app.post("/saved", async (c) => {
  const b = await objectBody(c).catch(() => null);
  const p = b && cleanSaved(b);
  if (!p) return fail(c, 400, "Send name, latitude and longitude");
  return ok(c, await addSaved(c.env, p), 201);
});

app.patch("/saved/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await objectBody(c).catch(() => null);
  const p = b && cleanSaved(b, true);
  if (!Number.isInteger(id) || !p) return fail(c, 400, "Invalid place");
  const row = await updateSaved(c.env, id, p);
  return row ? ok(c, row) : fail(c, 404, "Not found");
});

app.delete("/saved/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return fail(c, 400, "Invalid id");
  return ok(c, { deleted: await deleteSaved(c.env, id) });
});

/**
 * POST { names: [{ key, name?, city?, country?, category?, map_item_id? }] }:
 * names (and Apple's category and place ID) looked up on a device. Missing
 * fields keep what's already there.
 */
app.post("/names", async (c) => {
  const b = (await objectBody(c).catch(() => null)) as { names?: unknown } | null;
  const items = Array.isArray(b?.names) ? (b!.names as Array<Record<string, unknown>>) : null;
  if (!items || items.length === 0 || items.length > 500) return fail(c, 400, "Send names: 1 to 500 items");
  const valid = items.filter((n): n is Record<string, unknown> & { key: string } => isObject(n) && typeof n.key === "string" && PLACE_KEY.test(n.key));
  await saveNames(c.env, valid);
  return ok(c, { received: items.length, saved: valid.length });
});

/** GET /v1/visits/journeys?start=&end=&limit=&cursor=: trips between visits (not raw path traces), oldest first. */
app.get("/journeys", async (c) => {
  try {
    const limit = limitFrom(c, 1000, 5000);
    const after = cursorFrom(c, 2) as [string, number] | null;
    const rows = await listJourneys(c.env, {
      start: isoOr(c.req.query("start"), new Date(Date.now() - 30 * 86_400_000).toISOString()),
      end: isoOr(c.req.query("end"), new Date().toISOString()), limit, after,
    });
    const { items, next_cursor } = page(rows, limit, (j) => [j.started_at, j.id]);
    return list(c, items, next_cursor);
  } catch (error) {
    return failWith(c, error, "Journeys request");
  }
});

/** POST { journeys: [...] } up to 500 at a time. Repeats are ignored. */
app.post("/journeys", async (c) => {
  try {
    const b = (await objectBody(c)) as { journeys?: unknown };
    const items = Array.isArray(b?.journeys) ? (b.journeys as JourneyInput[]) : null;
    if (!items || items.length === 0 || items.length > 500) return fail(c, 400, "Send journeys: 1 to 500 items");
    const clean = cleanAll<JourneyInput, CleanJourney>(items, cleanJourney);
    return ok(c, { received: items.length, valid: clean.length, added: await addJourneys(c.env, clean) });
  } catch (error) {
    return failWith(c, error, "Journeys request");
  }
});

export default app;
