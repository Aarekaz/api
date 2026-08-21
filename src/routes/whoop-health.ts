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

    return c.json({
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
    });
  });

  app.get("/workouts", async (c) => {
    const query = await collectionQuery(
      c.req.query(),
      c.env.WHOOP_TOKEN_ENCRYPTION_KEY,
      "workouts",
    );
    if (!query) return c.json({ error: "Invalid WHOOP collection query" }, 400);
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getReadContext();
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
    const context = await readRepository.getReadContext();
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
    const context = await readRepository.getReadContext();
    if (!context) return c.json({ error: "WHOOP workout not found" }, 404);
    const workout = await readRepository.getWorkout(context.whoopUserId, workoutId);
    return workout
      ? c.json(workout)
      : c.json({ error: "WHOOP workout not found" }, 404);
  });

  app.get("/profile", async (c) => {
    const readRepository = readRepositoryFor(c.env);
    const context = await readRepository.getReadContext();
    if (!context) return c.json({ error: "WHOOP profile not found" }, 404);
    const profile = await readRepository.getProfile(context.whoopUserId);
    return profile
      ? c.json(profile)
      : c.json({ error: "WHOOP profile not found" }, 404);
  });

  return app;
}

for (const [resource, responseSchema, summary] of [
  ["cycles", whoopCycleReadSchema, "List WHOOP physiological cycles"],
  ["recoveries", whoopRecoveryReadSchema, "List WHOOP recoveries"],
  ["sleeps", whoopSleepReadSchema, "List WHOOP sleeps"],
  ["workouts", whoopWorkoutReadSchema, "List WHOOP workouts"],
] as const) {
  openApiRegistry.registerPath({
    method: "get",
    path: `/v1/health/whoop/${resource}`,
    summary,
    security: authSecurity,
    request: { query: whoopHealthCollectionQuerySchema },
    responses: okResponses(whoopHealthPageSchema(responseSchema)),
  });
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/whoop/overview",
  summary: "Get the current WHOOP health overview",
  security: authSecurity,
  responses: okResponses(whoopOverviewReadSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/whoop/profile",
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
