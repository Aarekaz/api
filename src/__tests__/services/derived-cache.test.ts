import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { testD1 } from "../helpers/d1";
import type { Env } from "../../types/env";
import { derived, DERIVED_LIMITS, type DerivedSpec } from "../../services/derived-cache";
import { bumpDataVersion } from "../../services/data-versions";
import visitsRoute from "../../routes/visits";

/** A Map behind the parts of R2 the cache uses. */
function fakeR2() {
  const objects = new Map<string, { text: string; customMetadata: Record<string, string> }>();
  const bucket = {
    objects,
    async put(key: string, text: string, options: { customMetadata?: Record<string, string> } = {}) {
      objects.set(key, { text, customMetadata: options.customMetadata ?? {} });
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return { size: new TextEncoder().encode(o.text).length, customMetadata: o.customMetadata, body: new Response(o.text).body!, text: async () => o.text };
    },
  };
  return bucket;
}

function setup(options: { table?: boolean; r2?: boolean } = {}) {
  const { db, DB } = testD1({ migrations: ["0046_data_versions", ...(options.table === false ? [] : ["0050_derived_cache"])] });
  const R2 = fakeR2();
  const env = { DB, ...(options.r2 ? { R2_PRIVATE: R2 } : {}) } as unknown as Env;
  let builds = 0;
  const spec = (value: unknown = { n: 1 }, extra: Partial<DerivedSpec> = {}): DerivedSpec => ({
    name: "trips", params: "offset=0", data: "places", shape: "1",
    build: async () => { builds++; await new Promise((r) => setTimeout(r, 5)); return value; }, ...extra,
  });
  const text = async (body: string | ReadableStream) => (typeof body === "string" ? body : new Response(body).text());
  return { db, env, R2, spec, text, builds: () => builds };
}

const fast = { ...DERIVED_LIMITS, waits: [10, 10, 10] };

describe("derived cache", () => {
  it("builds once, then serves the kept answer until the data version moves", async () => {
    const { env, spec, builds, text } = setup();
    const first = await derived(env, spec());
    expect([first.source, await text(first.body)]).toEqual(["miss", '{"n":1}']);
    const second = await derived(env, spec({ n: 2 }));
    expect([second.source, await text(second.body), builds()]).toEqual(["hit", '{"n":1}', 1]);
    await bumpDataVersion(env, "places");
    const third = await derived(env, spec({ n: 3 }));
    expect([third.source, await text(third.body), builds()]).toEqual(["miss", '{"n":3}', 2]);
  });

  it("keys by params and by the code that built it", async () => {
    const { env, spec, builds } = setup();
    await derived(env, spec());
    expect((await derived(env, spec({}, { params: "offset=-300" }))).source).toBe("miss");
    expect((await derived(env, spec({}, { shape: "2" }))).source).toBe("miss");
    expect(builds()).toBe(3);
  });

  it("lets concurrent requests share one build", async () => {
    const { env, spec, builds, text } = setup();
    const answers = await Promise.all(Array.from({ length: 5 }, () => derived(env, spec())));
    expect(builds()).toBe(1);
    expect(answers.map((a) => a.source).sort()).toEqual(["miss", "shared", "shared", "shared", "shared"]);
    expect(new Set(await Promise.all(answers.map((a) => text(a.body))))).toEqual(new Set(['{"n":1}']));
  });

  it("waits for another isolate's build instead of starting its own", async () => {
    const { db, env, spec, builds, text } = setup();
    const future = new Date(Date.now() + 60_000).toISOString();
    db.exec(`INSERT INTO derived_cache (name, params, data_name, data_version, shape, built_at, lease_until) VALUES ('trips', 'offset=0', 'places', -1, '', 'x', '${future}')`);
    setTimeout(() => db.exec(`UPDATE derived_cache SET data_version = 0, shape = '1', storage = 'd1', body = '{"theirs":true}', bytes = 15, lease_until = NULL`), 15);
    const found = await derived(env, spec(), fast);
    expect([found.source, await text(found.body), builds()]).toEqual(["waited", '{"theirs":true}', 0]);
  });

  it("builds anyway when the other build never comes, and takes over an expired lease", async () => {
    const { db, env, spec, builds } = setup();
    const future = new Date(Date.now() + 60_000).toISOString();
    db.exec(`INSERT INTO derived_cache (name, params, data_name, data_version, shape, built_at, lease_until) VALUES ('trips', 'offset=0', 'places', -1, '', 'x', '${future}')`);
    expect((await derived(env, spec(), fast)).source).toBe("miss");
    expect(builds()).toBe(1);
    db.exec(`UPDATE derived_cache SET data_version = -1, lease_until = '2000-01-01T00:00:00.000Z'`);
    expect((await derived(env, spec(), { ...fast, waits: [] })).source).toBe("miss");
    const row = db.prepare("SELECT data_version, lease_until FROM derived_cache").get();
    expect(row).toEqual({ data_version: 0, lease_until: null });
  });

  it("frees the lease when a build fails", async () => {
    const { db, env, spec } = setup();
    await expect(derived(env, spec({}, { build: async () => { throw new Error("boom"); } }))).rejects.toThrow("boom");
    expect(db.prepare("SELECT lease_until FROM derived_cache").get()).toEqual({ lease_until: null });
  });

  it("never lets an older build replace a newer one", async () => {
    const { db, env, spec } = setup();
    await bumpDataVersion(env, "places");
    await derived(env, spec({ v: 1 }));
    db.exec("UPDATE data_versions SET version = 0");
    await derived(env, spec({ v: 0 }));
    expect(db.prepare("SELECT data_version, body FROM derived_cache").get()).toEqual({ data_version: 1, body: '{"v":1}' });
  });

  it("keeps large answers in R2, checks the object is the same build, and skips what is too big", async () => {
    const { db, env, R2, spec, text, builds } = setup({ r2: true });
    const limits = { ...fast, inlineMax: 10, maxBytes: 100 };
    const big = { pad: "x".repeat(40) };
    expect((await derived(env, spec(big), limits)).source).toBe("miss");
    expect(db.prepare("SELECT storage, body FROM derived_cache").get()).toEqual({ storage: "r2", body: null });
    const hit = await derived(env, spec(big), limits);
    expect([hit.source, await text(hit.body)]).toEqual(["hit", JSON.stringify(big)]);
    // An object overwritten by another build no longer matches the row.
    R2.objects.get("derived-cache/trips/offset%3D0.json")!.customMetadata.data_version = "7";
    expect((await derived(env, spec(big), limits)).source).toBe("miss");
    // Too big to keep: built every time.
    await derived(env, spec({ pad: "x".repeat(200) }, { params: "huge" }), limits);
    expect((await derived(env, spec({ pad: "x".repeat(200) }, { params: "huge" }), limits)).source).toBe("miss");
    expect(builds()).toBe(4);
  });

  it("without R2, a large answer isn't kept", async () => {
    const { env, spec } = setup();
    const limits = { ...fast, inlineMax: 10 };
    await derived(env, spec({ pad: "x".repeat(40) }), limits);
    expect((await derived(env, spec({ pad: "x".repeat(40) }), limits)).source).toBe("miss");
  });

  it("builds every time on a database without the table", async () => {
    const { env, spec, builds } = setup({ table: false });
    expect((await derived(env, spec())).source).toBe("bypass");
    expect((await derived(env, spec())).source).toBe("bypass");
    expect(builds()).toBe(2);
  });
});

describe("trips, chapters and footprints through the cache", () => {
  function route() {
    const { db, DB } = testD1({
      migrations: ["0007_location", "0027_visits", "0028_place_names", "0029_journeys", "0032_place_categories", "0039_saved_places", "0040_saved_place_notes",
        "0041_visit_guess", "0042_utc_offset", "0043_recorded_departure", "0044_visit_corrections", "0046_data_versions", "0048_local_date", "0050_derived_cache"],
      sql: "ALTER TABLE location_history ADD COLUMN updated_at TEXT",
    });
    const root = new Hono<{ Bindings: Env }>();
    root.route("/v1/visits", visitsRoute);
    const env = { DB, API_VERSION: "test" } as Env;
    const get = (path: string, headers: Record<string, string> = {}) => root.request(path, { headers }, env);
    const post = (visits: unknown[]) => root.request("/v1/visits", { method: "POST", body: JSON.stringify({ visits }), headers: { "Content-Type": "application/json" } }, env);
    return { db, get, post };
  }
  const visit = (i: number) => ({ latitude: 38.8 + i * 0.01, longitude: -77, arrived_at: `2026-0${1 + (i % 9)}-10T15:00:00Z`, departed_at: `2026-0${1 + (i % 9)}-10T18:00:00Z`, source: "visit", source_key: `v${i}` });

  it("serves the same body from the cache, keeps ETag/304, and rebuilds after a write", async () => {
    const { get, post } = route();
    await post([visit(1), visit(2)]);
    for (const path of ["/v1/visits/trips?offset=-300", "/v1/visits/chapters", "/v1/visits/footprints"]) {
      const first = await get(path);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Derived-Cache")).toBe("miss");
      expect(first.headers.get("Content-Type")).toBe("application/json");
      const body = await first.text();
      const second = await get(path);
      expect([second.headers.get("X-Derived-Cache"), await second.text()]).toEqual(["hit", body]);
      expect(second.headers.get("ETag")).toBe(first.headers.get("ETag"));
      expect((await get(path, { "If-None-Match": first.headers.get("ETag")! })).status).toBe(304);
    }
    await post([visit(3)]);
    const after = await get("/v1/visits/footprints");
    expect(after.headers.get("X-Derived-Cache")).toBe("miss");
    expect(((await after.json()) as { spots: unknown[] }).spots).toHaveLength(3);
  });
});

describe("backups", () => {
  it("skip the cache: it is rebuilt from the data", async () => {
    const { planTables } = await import("../../services/d1-backup");
    const plan = planTables([{ type: "table", name: "derived_cache", tbl_name: "derived_cache", sql: "CREATE TABLE derived_cache (name TEXT)" }]);
    expect([plan.tables.length, plan.skipped.map((s) => s.name)]).toEqual([0, ["derived_cache"]]);
  });
});
