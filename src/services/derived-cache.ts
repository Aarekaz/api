import type { Env } from "../types/env";
import { dataVersion, type DataName } from "./data-versions";

/**
 * A read-through cache for answers computed from whole tables (trips,
 * chapters, footprints): migrations/0050_derived_cache.sql and
 * docs/adr/0002-derived-cache.md.
 *
 * - Valid only while the data it was built from hasn't moved: a row stores the
 *   data_versions version read *before* building, so a write during the build
 *   leaves the row already stale rather than claiming data it might not have.
 * - One build at a time: concurrent requests in this isolate share one promise;
 *   across isolates a lease in the row makes the others wait briefly for the
 *   result, then build anyway if it doesn't come (never fail for the cache).
 * - Small answers live in the row, large ones in R2_PRIVATE (a D1 row tops out
 *   near 2 MB), anything past `maxBytes` isn't kept.
 * - Without the table (migration not applied) or data_versions, it builds
 *   every time, as before.
 */

export interface DerivedSpec {
  /** What is computed: "trips". */
  name: string;
  /** The query it depends on, already normalized ("offset=-300"); "" for none. */
  params: string;
  /** The data_versions row whose writes change it. */
  data: DataName;
  /** The code that builds it; change it when the answer's shape or rules change. */
  shape: string;
  build: () => Promise<unknown>;
}

export interface DerivedLimits {
  /** Largest answer kept in the D1 row (bytes); larger goes to R2. */
  inlineMax: number;
  /** Largest answer kept at all. */
  maxBytes: number;
  /** How long a build may hold the lease before others take over (ms). */
  leaseMs: number;
  /** Pauses while another isolate builds (ms), checking for its answer after each. */
  waits: number[];
}

export const DERIVED_LIMITS: DerivedLimits = {
  inlineMax: 512 * 1024,
  maxBytes: 32 * 1024 * 1024,
  leaseMs: 30_000,
  waits: [100, 200, 400, 800],
};

/** How the answer was found: kept, built here, built by a request it waited on, or not cached. */
export type DerivedSource = "hit" | "miss" | "shared" | "waited" | "bypass";

export interface DerivedAnswer {
  /** The JSON text, or a stream of it from R2. */
  body: string | ReadableStream;
  bytes: number;
  source: DerivedSource;
}

type Row = { data_version: number; shape: string; storage: string; bytes: number; body: string | null; lease_until: string | null };

/** Builds in flight in this isolate, by name, params, version and shape. */
const building = new Map<string, Promise<string>>();

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const r2Key = (spec: DerivedSpec) => `derived-cache/${spec.name}/${encodeURIComponent(spec.params || "_")}.json`;

/** The answer for `spec`, from the cache when it still holds for the current data. */
export async function derived(env: Env, spec: DerivedSpec, limits: DerivedLimits = DERIVED_LIMITS): Promise<DerivedAnswer> {
  const version = await dataVersion(env, spec.data);
  const plain = async (): Promise<DerivedAnswer> => {
    const text = JSON.stringify(await spec.build());
    return { body: text, bytes: encoder.encode(text).length, source: "bypass" };
  };
  if (version === null) return plain();

  let row: Row | null;
  try {
    row = await readRow(env, spec);
  } catch {
    return plain(); // no derived_cache table yet
  }
  const kept = await fromRow(env, spec, row, version);
  if (kept) return { ...kept, source: "hit" };

  const key = `${spec.name}|${spec.params}|${version}|${spec.shape}`;
  const running = building.get(key);
  if (running) return answer(await running, "shared");

  let source: DerivedSource = "miss";
  const job = (async () => {
    const leased = await takeLease(env, spec, limits).catch(() => true);
    if (!leased) {
      // Another isolate is building it: wait for its answer, then build anyway.
      for (const ms of limits.waits) {
        await sleep(ms);
        const theirs = await fromRow(env, spec, await readRow(env, spec).catch(() => null), version, true);
        if (theirs) { source = "waited"; return theirs.body as string; }
      }
    }
    const started = Date.now();
    try {
      const text = JSON.stringify(await spec.build());
      await store(env, spec, version, text, Date.now() - started, limits).catch((error) => {
        console.warn(`derived cache: could not keep ${spec.name}`, error instanceof Error ? error.message : error);
      });
      return text;
    } catch (error) {
      if (leased) await releaseLease(env, spec).catch(() => undefined);
      throw error;
    }
  })();
  building.set(key, job);
  try {
    return answer(await job, source);
  } finally {
    building.delete(key);
  }
}

function answer(text: string, source: DerivedSource): DerivedAnswer {
  return { body: text, bytes: encoder.encode(text).length, source };
}

async function readRow(env: Env, spec: DerivedSpec) {
  return env.DB.prepare(
    "SELECT data_version, shape, storage, bytes, body, lease_until FROM derived_cache WHERE name = ? AND params = ?",
  ).bind(spec.name, spec.params).first<Row>();
}

/** The kept answer when the row still holds for `version`; `asText` reads an R2 answer whole. */
async function fromRow(env: Env, spec: DerivedSpec, row: Row | null, version: number, asText = false): Promise<Omit<DerivedAnswer, "source"> | null> {
  if (!row || Number(row.data_version) !== version || row.shape !== spec.shape) return null;
  if (row.storage === "d1") return row.body === null ? null : { body: row.body, bytes: Number(row.bytes) };
  if (row.storage !== "r2" || !env.R2_PRIVATE) return null;
  const object = await env.R2_PRIVATE.get(r2Key(spec)).catch(() => null);
  // The object is overwritten in place, so it must say it is the same build as the row.
  if (!object || object.customMetadata?.data_version !== String(version) || object.customMetadata?.shape !== spec.shape) {
    await object?.body.cancel().catch(() => undefined);
    return null;
  }
  return asText ? { body: await object.text(), bytes: object.size } : { body: object.body, bytes: object.size };
}

/** Claims the build: true unless another request holds an unexpired lease. */
async function takeLease(env: Env, spec: DerivedSpec, limits: DerivedLimits) {
  const now = new Date();
  const until = new Date(now.getTime() + limits.leaseMs).toISOString();
  const won = await env.DB.prepare(
    `INSERT INTO derived_cache (name, params, data_name, data_version, shape, built_at, lease_until) VALUES (?, ?, ?, -1, '', ?, ?)
     ON CONFLICT(name, params) DO UPDATE SET lease_until = excluded.lease_until
     WHERE derived_cache.lease_until IS NULL OR derived_cache.lease_until < ?
     RETURNING name`,
  ).bind(spec.name, spec.params, spec.data, now.toISOString(), until, now.toISOString()).first();
  return won !== null;
}

async function releaseLease(env: Env, spec: DerivedSpec) {
  await env.DB.prepare("UPDATE derived_cache SET lease_until = NULL WHERE name = ? AND params = ?").bind(spec.name, spec.params).run();
}

/** Keeps the answer (and frees the lease). An older build never replaces a newer one. */
async function store(env: Env, spec: DerivedSpec, version: number, text: string, ms: number, limits: DerivedLimits) {
  const bytes = encoder.encode(text).length;
  let storage: "d1" | "r2" | null = bytes <= limits.inlineMax ? "d1" : null;
  if (!storage && bytes <= limits.maxBytes && env.R2_PRIVATE) {
    await env.R2_PRIVATE.put(r2Key(spec), text, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { data_version: String(version), shape: spec.shape },
    });
    storage = "r2";
  }
  if (!storage) return releaseLease(env, spec);
  await env.DB.prepare(
    `INSERT INTO derived_cache (name, params, data_name, data_version, shape, storage, bytes, body, built_at, build_ms, lease_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(name, params) DO UPDATE SET data_name = excluded.data_name, data_version = excluded.data_version, shape = excluded.shape,
       storage = excluded.storage, bytes = excluded.bytes, body = excluded.body, built_at = excluded.built_at, build_ms = excluded.build_ms,
       lease_until = NULL
     WHERE excluded.data_version >= derived_cache.data_version`,
  ).bind(spec.name, spec.params, spec.data, version, spec.shape, storage, bytes, storage === "d1" ? text : null, new Date().toISOString(), ms).run();
}
