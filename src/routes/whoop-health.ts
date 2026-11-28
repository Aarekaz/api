import { Hono, type Context } from "hono";
import {
  WhoopHealthReadRepository,
  type WhoopReadPage,
} from "../services/whoop/read-repository";
import {
  decodeWhoopReadCursor,
  encodeWhoopReadCursor,
  WHOOP_READ_CURSOR_MAX_LENGTH,
  type WhoopCursorResource,
  type WhoopReadAnchor,
} from "../services/whoop/read-cursor";
import type { Env } from "../types/env";
import {
  apiTags,
  authSecurity,
  errorResponses,
  errorSchema,
  okResponses,
  openApiRegistry,
  openApiResponse,
  whoopCycleReadSchema,
  whoopHealthCollectionQuerySchema,
  whoopHealthTimestampSchema,
  whoopHealthPageSchema,
  whoopOverviewReadSchema,
  whoopProfileReadSchema,
  whoopRecoveryReadSchema,
  whoopSleepReadSchema,
  whoopWorkoutPathSchema,
  whoopWorkoutReadSchema,
} from "../schemas/openapi";

export interface WhoopHealthDependencies {
  readRepository?: WhoopHealthReadRepository;
  now?: () => Date;
}

interface CollectionQuery {
  start: string | null;
  end: string | null;
  limit: number;
  cursor: WhoopReadAnchor | null;
}

const canonicalTimestamp = (value: string | undefined): string | null | undefined => {
  if (value === undefined) return null;
  if (!whoopHealthTimestampSchema.safeParse(value).success) return undefined;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
};

const collectionQuery = async (
  query: Record<string, string>,
  secret: string,
  resource: WhoopCursorResource,
): Promise<CollectionQuery | null> => {
  const allowed = new Set(["start", "end", "limit", "cursor"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) return null;
  const start = canonicalTimestamp(query.start);
  const end = canonicalTimestamp(query.end);
  if (start === undefined || end === undefined || (start !== null && end !== null && start > end)) return null;
  const limitText = query.limit ?? "25";
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText)) return null;
  const encodedCursor = query.cursor;
  if (encodedCursor !== undefined && encodedCursor.length > WHOOP_READ_CURSOR_MAX_LENGTH) return null;
  const cursor = encodedCursor === undefined
    ? null
    : await decodeWhoopReadCursor(encodedCursor, secret, resource, start, end);
  if (encodedCursor !== undefined && cursor === null) return null;
  return { start, end, limit: Number(limitText), cursor };
};

export function createWhoopHealthRoute(dependencies: WhoopHealthDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = dependencies.now ?? (() => new Date());
  const readRepositoryFor = (env: Env): WhoopHealthReadRepository => dependencies.readRepository
    ?? new WhoopHealthReadRepository(env.DB);

  app.get("/overview", async (c) => {
    // WHOOP data changes only when a sync runs, so the overview is kept at the
    // edge for a minute. Tests (and anything without the Cache API) skip this.
    const edge = typeof caches !== "undefined" && !dependencies.readRepository ? caches.default : null;
    const cacheKey = new Request("https://cache.api.anuragd.me/whoop/overview");
    const hit = await edge?.match(cacheKey).catch(() => undefined);
    if (hit) return new Response(hit.body, hit);
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getReadContext();

    const overview = context
      ? await readRepository.getOverview(context.whoopUserId, now())
      : {
        current_cycle: null,
        current_recovery: null,
        current_sleep: null,
        recent_workouts: [],
        trends_7_days: [],
        trends_30_days: [],
      };

    const body = {
      ...overview,
      synchronization: context
        ? {
          status: context.status,
          last_success_at: context.last_success_at,
          last_error_at: context.last_error_at,
          consecutive_failure_count: context.consecutive_failure_count,
          updated_at: context.updated_at,
          progress: context.progress,
          runs: context.runs,
        }
        : { status: "not_connected" as const, progress: [], runs: [] },
    };
    const response = c.json(body);
    if (edge && context) {
      const copy = new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" },
      });
      await edge.put(cacheKey, copy).catch(() => undefined);
    }
    return response;
  });

  app.get("/workouts", async (c) => {
    const query = await collectionQuery(
      c.req.query(),
      c.env.WHOOP_TOKEN_ENCRYPTION_KEY,
      "workouts",
    );
    if (!query) return c.json({ error: "Invalid WHOOP collection query" }, 400);
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getConnection();
    if (!context) return c.json({ records: [], next_cursor: null });
    const page = await readRepository.listWorkouts(context.whoopUserId, query);
    const nextCursor = page.nextAnchor
      ? await encodeWhoopReadCursor(
        c.env.WHOOP_TOKEN_ENCRYPTION_KEY,
        "workouts",
        query.start,
        query.end,
        page.nextAnchor,
      )
      : null;
    return c.json({ records: page.records, next_cursor: nextCursor });
  });

  const collectionResponse = async <T>(
    c: Context<{ Bindings: Env }>,
    resource: Exclude<WhoopCursorResource, "workouts">,
    list: (
      repository: WhoopHealthReadRepository,
      whoopUserId: number,
      query: CollectionQuery,
    ) => Promise<WhoopReadPage<T>>,
  ) => {
    const query = await collectionQuery(c.req.query(), c.env.WHOOP_TOKEN_ENCRYPTION_KEY, resource);
    if (!query) return c.json({ error: "Invalid WHOOP collection query" }, 400);
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getConnection();
    if (!context) return c.json({ records: [], next_cursor: null });
    const page = await list(readRepository, context.whoopUserId, query);
    const nextCursor = page.nextAnchor
      ? await encodeWhoopReadCursor(
        c.env.WHOOP_TOKEN_ENCRYPTION_KEY,
        resource,
        query.start,
        query.end,
        page.nextAnchor,
      )
      : null;
    return c.json({ records: page.records, next_cursor: nextCursor });
  };

  app.get("/cycles", (c) => collectionResponse(
    c,
    "cycles",
    (repository, whoopUserId, query) => repository.listCycles(whoopUserId, query),
  ));
  app.get("/recoveries", (c) => collectionResponse(
    c,
    "recoveries",
    (repository, whoopUserId, query) => repository.listRecoveries(whoopUserId, query),
  ));
  app.get("/sleeps", (c) => collectionResponse(
    c,
    "sleeps",
    (repository, whoopUserId, query) => repository.listSleeps(whoopUserId, query),
  ));

  app.get("/workouts/:workoutId", async (c) => {
    const workoutId = c.req.param("workoutId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workoutId)) {
      return c.json({ error: "Invalid workout ID" }, 400);
    }
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getConnection();
    if (!context) return c.json({ error: "WHOOP workout not found" }, 404);
    const workout = await readRepository.getWorkout(context.whoopUserId, workoutId);
    return workout
      ? c.json(workout)
      : c.json({ error: "WHOOP workout not found" }, 404);
  });

  app.get("/profile", async (c) => {
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getConnection();
    if (!context) return c.json({ error: "WHOOP profile not found" }, 404);
    const profile = await readRepository.getProfile(context.whoopUserId);
    if (!profile) return c.json({ error: "WHOOP profile not found" }, 404);
    // Body measurements are synced with the profile; serve them alongside it.
    const body = await c.env.DB.prepare(
      `SELECT height_meter, weight_kilogram, max_heart_rate, synced_at
       FROM whoop_body_measurements WHERE whoop_user_id = ? AND deleted_at IS NULL`,
    ).bind(context.whoopUserId).first().catch(() => null);
    return c.json({ ...profile, body_measurements: body ?? null });
  });

  return app;
}

// One WHOOP tag for the reads here and the connection plumbing in whoop-integration.ts.
export const WHOOP_TAG = "WHOOP";
apiTags.push({
  name: WHOOP_TAG,
  description: `What the WHOOP band records: cycles (strain), recoveries, sleeps and workouts, copied from WHOOP into this API. \
It is health data. Apple Health is under the Health tag.

**Reading.** GET /v1/health/whoop/overview is the quick look: the current cycle, recovery and sleep, recent workouts, 7 and \
30 day trends, and how the sync is doing (kept for a minute). For more, page through /cycles, /recoveries, /sleeps or /workouts: \
\`start\` and \`end\` are timestamps with an offset (2026-08-01T00:00:00Z), \`limit\` is 1–100 (default 25), and you pass \
\`next_cursor\` back as \`cursor\` with the same \`start\` and \`end\` until it is null. Any other query parameter is a 400. \
GET /v1/health/whoop/workouts/{id} is one workout by its WHOOP id. With WHOOP not connected the lists are empty.

**Read-only.** WHOOP writes this data: its webhooks bring changes in, and a reconcile runs every hour (the last 2 days) and \
every night (14 days). There is nothing to create or edit here, so don't try to correct a record. If something looks stale, \
GET /v1/integrations/whoop shows the sync status.

**Plumbing agents don't call.** POST /v1/integrations/whoop/connect, GET /integrations/whoop/callback and \
POST /integrations/whoop/webhook are WHOOP's sign-in and WHOOP's own calls. POST /v1/integrations/whoop/sync is the Sync button \
in the dashboard; call it only when the owner asks. DELETE /v1/integrations/whoop (disconnect) and \
DELETE /v1/integrations/whoop/data (deletes every copied WHOOP record, for good) are the owner's, never an agent's.

**On anuragd.me.** The website reads workouts and cycles and shows a summary of them (movement and cycling) on the home page, \
/now and the year in review. Its token can also read the overview, recoveries and sleeps, though the site doesn't show them. \
The profile (name, email, height, weight) is never shown and the site's token can't read it. Keep all of it out of anything \
shared or published.`,
});

for (const [resource, responseSchema, summary] of [
  ["cycles", whoopCycleReadSchema, "List WHOOP physiological cycles"],
  ["recoveries", whoopRecoveryReadSchema, "List WHOOP recoveries"],
  ["sleeps", whoopSleepReadSchema, "List WHOOP sleeps"],
  ["workouts", whoopWorkoutReadSchema, "List WHOOP workouts"],
] as const) {
  openApiRegistry.registerPath({
    method: "get",
    path: `/v1/health/whoop/${resource}`,
    tags: [WHOOP_TAG],
    summary,
    security: authSecurity,
    request: { query: whoopHealthCollectionQuerySchema },
    responses: okResponses(whoopHealthPageSchema(responseSchema)),
  });
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/whoop/overview",
  tags: [WHOOP_TAG],
  summary: "Get the current WHOOP health overview",
  security: authSecurity,
  responses: okResponses(whoopOverviewReadSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/whoop/profile",
  tags: [WHOOP_TAG],
  summary: "Get the connected WHOOP profile",
  security: authSecurity,
  responses: {
    ...okResponses(whoopProfileReadSchema),
    404: openApiResponse(errorSchema, "WHOOP profile not found"),
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/whoop/workouts/{workoutId}",
  tags: [WHOOP_TAG],
  summary: "Get a WHOOP workout",
  security: authSecurity,
  request: { params: whoopWorkoutPathSchema },
  responses: {
    200: openApiResponse(whoopWorkoutReadSchema, "OK"),
    404: openApiResponse(errorSchema, "WHOOP workout not found"),
    ...errorResponses,
  },
});

export default createWhoopHealthRoute();
