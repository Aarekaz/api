// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { testD1 } from "../helpers/d1";
import type { Env } from "../../types/env";
import { backupStatus, backupTick, maybeRunD1Backup, planTables, startBackup, type BackupOptions } from "../../services/d1-backup";
import adminRoute from "../../routes/admin";

/**
 * A private bucket that keeps objects in memory and holds multipart uploads to
 * R2's rules: every part but the last at least `minPart` bytes and all the same
 * size. It has no delete, so a backup that tried to delete would throw.
 */
function fakeBucket(minPart: number) {
  const objects = new Map<string, { bytes: Uint8Array; options: unknown }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const calls: string[] = [];
  let failPuts = 0;
  const bytesOf = async (value: unknown) =>
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as Uint8Array);
  const handle = (key: string, uploadId: string) => ({
    key, uploadId,
    async uploadPart(partNumber: number, value: Uint8Array) {
      calls.push(`part ${key} ${partNumber}`);
      uploads.get(uploadId)!.parts.set(partNumber, await bytesOf(value));
      return { partNumber, etag: `etag-${partNumber}-${value.length}` };
    },
    async complete(parts: Array<{ partNumber: number; etag: string }>) {
      calls.push(`complete ${key}`);
      const upload = uploads.get(uploadId)!;
      const list = parts.map((p) => upload.parts.get(p.partNumber)!);
      const leading = list.slice(0, -1);
      if (leading.some((p) => p.length < minPart)) throw new Error("part too small");
      if (new Set(leading.map((p) => p.length)).size > 1) throw new Error("All non-trailing parts must have the same length");
      if (list[list.length - 1].length > (leading[0]?.length ?? Infinity)) throw new Error("last part too big");
      const total = list.reduce((n, p) => n + p.length, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const p of list) { bytes.set(p, offset); offset += p.length; }
      objects.set(key, { bytes, options: { multipart: true } });
      uploads.delete(uploadId);
      return {};
    },
    async abort() { throw new Error("a backup never aborts"); },
  });
  const bucket = {
    async put(key: string, value: unknown, options: unknown) {
      calls.push(`put ${key}`);
      if (failPuts > 0) { failPuts -= 1; throw new Error("R2 is down"); }
      objects.set(key, { bytes: await bytesOf(value), options });
      return {};
    },
    async createMultipartUpload(key: string) {
      const uploadId = `u${uploads.size + 1}-${key}`;
      calls.push(`create ${key}`);
      uploads.set(uploadId, { key, parts: new Map() });
      return handle(key, uploadId);
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      if (!uploads.has(uploadId)) throw new Error("no such upload");
      return handle(key, uploadId);
    },
  };
  return {
    bucket: bucket as unknown as R2Bucket, objects, uploads, calls,
    failNextPuts(n: number) { failPuts = n; },
    text: (key: string) => new TextDecoder().decode(gunzipSync(objects.get(key)!.bytes)),
    json: (key: string) => JSON.parse(new TextDecoder().decode(objects.get(key)!.bytes)),
  };
}

/** The public media bucket: any use at all fails the test. */
const untouchable = new Proxy({}, { get(_, prop) { throw new Error(`R2_BUCKET.${String(prop)} used`); } }) as R2Bucket;

// Random hex doesn't compress much, so a few hundred rows fill several small parts.
const noise = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function setup(options: { minPart?: number; bigRows?: number } = {}) {
  const { db, DB } = testD1({
    migrations: ["0007_location", "0027_visits", "0031_training", "0047_d1_backups"],
    sql: [
      // What D1 and SQLite keep for themselves, and a search index, which a backup leaves out.
      "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)",
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)",
      "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_init.sql', '2026-01-01')",
      "CREATE TABLE notes_src (body TEXT)",
      "CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes_src')",
    ],
  });
  const rows = options.bigRows ?? 400;
  const insert = db.prepare("INSERT INTO location_history (latitude, longitude, recorded_at, label, source, created_at) VALUES (?, ?, ?, ?, 'test', ?)");
  for (let i = 0; i < rows; i++) insert.run(40 + i / 1000, -74, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, noise(200), "2026-01-01");
  // A gap in the rowids: paging is by rowid, not by count.
  db.exec("DELETE FROM location_history WHERE id IN (10, 11, 12)");
  db.exec("INSERT INTO training_sets (day, exercise, set_number, reps, weight, unit, done_at) VALUES ('2026-11-24', 'Squat', 1, 5, 100, 'kg', '2026-11-24T12:00:00Z')");
  const r2 = fakeBucket(options.minPart ?? 4096);
  const env = { DB, R2_PRIVATE: r2.bucket, R2_BUCKET: untouchable } as unknown as Env;
  return { db, env, r2 };
}

const small: BackupOptions = { partBytes: 4096, tickRawBytes: 20_000, firstPageRows: 25, maxPageRows: 60, pageBytes: 8_000 };

async function runToEnd(env: Env, options: BackupOptions, max = 200) {
  for (let i = 1; i <= max; i++) {
    const status = await backupTick(env, options);
    if (status?.status !== "running") return { status, ticks: i };
  }
  throw new Error("backup never finished");
}

describe("which tables a backup copies", () => {
  it("leaves out SQLite's and Cloudflare's own tables and a virtual table's storage, keeps d1_migrations", () => {
    const plan = planTables([
      { type: "table", name: "sqlite_sequence", tbl_name: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence(name,seq)" },
      { type: "table", name: "_cf_METADATA", tbl_name: "_cf_METADATA", sql: "CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)" },
      { type: "table", name: "d1_migrations", tbl_name: "d1_migrations", sql: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY)" },
      { type: "table", name: "documents", tbl_name: "documents", sql: "CREATE TABLE documents (id TEXT PRIMARY KEY)" },
      { type: "table", name: "documents_fts", tbl_name: "documents_fts", sql: "CREATE VIRTUAL TABLE documents_fts USING fts5(title)" },
      { type: "table", name: "documents_fts_data", tbl_name: "documents_fts_data", sql: "CREATE TABLE 'documents_fts_data'(id INTEGER PRIMARY KEY, block BLOB)" },
      { type: "table", name: "documents_fts_config", tbl_name: "documents_fts_config", sql: "CREATE TABLE 'documents_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID" },
      { type: "index", name: "documents_updated", tbl_name: "documents", sql: "CREATE INDEX documents_updated ON documents (updated_at)" },
      { type: "index", name: "sqlite_autoindex_documents_1", tbl_name: "documents", sql: null },
    ]);
    expect(plan.tables.map((t) => t.name)).toEqual(["d1_migrations", "documents"]);
    expect(plan.skipped.map((t) => t.name)).toEqual(["documents_fts", "documents_fts_config", "documents_fts_data"]);
    expect(plan.schema.map((s) => s.name)).toEqual(["d1_migrations", "documents", "documents_fts", "documents_fts_data", "documents_fts_config", "documents_updated"]);
  });
});

describe("a backup run", () => {
  it("copies a big table over many ticks, resuming where each one stopped", async () => {
    const { db, env, r2 } = setup();
    await startBackup(env, "manual", new Date("2026-11-25T10:00:00Z"));

    const first = await backupTick(env, small);
    expect(first?.status).toBe("running");
    const progress = () => db.prepare("SELECT status, last_rowid, rows, upload_id, carry_bytes FROM backup_tables WHERE name = 'location_history'").get() as
      { status: string; last_rowid: number | null; rows: number; upload_id: string | null; carry_bytes: number };
    const seen: number[] = [];
    let previous = progress();
    let ticks = 1;
    while ((await backupStatus(env))?.status === "running") {
      await backupTick(env, small);
      ticks += 1;
      const now = progress();
      // Every tick moves on from the rowid the last one saved, never back.
      if (previous.last_rowid !== null && now.last_rowid !== null) expect(now.last_rowid).toBeGreaterThanOrEqual(previous.last_rowid);
      if (now.carry_bytes) seen.push(now.carry_bytes);
      previous = now;
      if (ticks > 200) throw new Error("never finished");
    }
    expect(ticks).toBeGreaterThan(3);
    expect(seen.length).toBeGreaterThan(0);                    // leftovers waited between ticks
    expect(r2.calls.filter((c) => c.startsWith("part")).length).toBeGreaterThan(3);

    const lines = r2.text("backups/2026-11-25/location_history.ndjson.gz").trim().split("\n").map((l) => JSON.parse(l));
    const ids = (db.prepare("SELECT id FROM location_history ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
    expect(lines.map((l) => l.id)).toEqual(ids);              // every row once, in order
    expect(lines[0]).toEqual(db.prepare("SELECT * FROM location_history ORDER BY id LIMIT 1").get());
    expect(lines[0]).not.toHaveProperty("__backup_rowid");
    // The scratch bytes are gone once a run is done.
    expect(db.prepare("SELECT COUNT(*) AS n FROM backup_carry").get()).toEqual({ n: 0 });
    expect((await backupStatus(env))?.status).toBe("done");
  });

  it("gzip round trip: the several members a file is made of read back as one", async () => {
    const { env, r2 } = setup({ bigRows: 300 });
    await startBackup(env, "manual", new Date("2026-11-25T10:00:00Z"));
    await runToEnd(env, small);
    const bytes = r2.objects.get("backups/2026-11-25/location_history.ndjson.gz")!.bytes;
    let members = 0;
    for (let i = 0; i + 2 < bytes.length; i++) if (bytes[i] === 0x1f && bytes[i + 1] === 0x8b && bytes[i + 2] === 8) members++;
    expect(members).toBeGreaterThan(1);
    expect(r2.text("backups/2026-11-25/location_history.ndjson.gz").trim().split("\n")).toHaveLength(297);
    // A small table goes up in one put and reads back exactly.
    const sets = JSON.parse(r2.text("backups/2026-11-25/training_sets.ndjson.gz"));
    expect(sets).toMatchObject({ day: "2026-11-24", exercise: "Squat", weight: 100, unit: "kg" });
    // An empty table is still a valid gzip file.
    expect(r2.text("backups/2026-11-25/visits.ndjson.gz")).toBe("");
  });

  it("writes a manifest of tables, row counts, sizes, schema and times", async () => {
    const { env, r2 } = setup({ bigRows: 120 });
    await startBackup(env, "manual", new Date("2026-11-25T10:00:00Z"));
    await runToEnd(env, small);
    const manifest = r2.json("backups/2026-11-25/manifest.json");
    const names = manifest.tables.map((t: { name: string }) => t.name);
    expect(names).toContain("d1_migrations");
    expect(names).toContain("location_history");
    expect(names).toContain("backup_runs");
    expect(names).not.toContain("_cf_KV");
    expect(names).not.toContain("sqlite_sequence");
    expect(names).not.toContain("notes_fts");
    expect(names).not.toContain("backup_carry");
    expect(manifest.skipped.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(["notes_fts", "notes_fts_data", "backup_carry"]));
    const history = manifest.tables.find((t: { name: string }) => t.name === "location_history");
    expect(history).toMatchObject({ key: "backups/2026-11-25/location_history.ndjson.gz", rows: 117 });
    expect(history.bytes).toBe(r2.objects.get(history.key)!.bytes.length);
    expect(history.raw_bytes).toBeGreaterThan(history.rows * 200);
    expect(history.sql).toMatch(/^CREATE TABLE/);
    expect(manifest.tables.find((t: { name: string }) => t.name === "d1_migrations").rows).toBe(1);
    expect(manifest.totals.tables).toBe(manifest.tables.length);
    expect(manifest.schema.find((s: { name: string }) => s.name === "visits_arrived")).toMatchObject({ type: "index", tbl_name: "visits" });
    expect(manifest.started_at).toBe("2026-11-25T10:00:00.000Z");
    expect(Date.parse(manifest.finished_at)).toBeGreaterThan(0);
    expect(manifest.trigger).toBe("manual");
  });

  it("a failed tick is tried again from the saved state; five in a row give the run up", async () => {
    const { env, r2 } = setup({ bigRows: 30 });
    await startBackup(env, "manual", new Date("2026-11-25T10:00:00Z"));
    r2.failNextPuts(1);
    expect(await backupTick(env, small)).toMatchObject({ status: "running", error: "R2 is down" });
    const { status } = await runToEnd(env, small);
    expect(status).toMatchObject({ status: "done", error: null });
    expect(r2.text("backups/2026-11-25/location_history.ndjson.gz").trim().split("\n")).toHaveLength(27);

    const other = setup({ bigRows: 5 });
    await startBackup(other.env, "manual", new Date("2026-11-26T10:00:00Z"));
    other.r2.failNextPuts(99);
    for (let i = 0; i < 5; i++) await backupTick(other.env, small);
    expect((await backupStatus(other.env))?.status).toBe("failed");
  });

  it("a tick does nothing while another holds the run", async () => {
    const { db, env } = setup({ bigRows: 5 });
    await startBackup(env, "manual", new Date("2026-11-25T10:00:00Z"));
    db.exec("UPDATE backup_runs SET lease_until = '2999-01-01T00:00:00.000Z'");
    await backupTick(env, small);
    expect(db.prepare("SELECT COUNT(*) AS n FROM backup_tables WHERE status != 'pending'").get()).toEqual({ n: 0 });
  });
});

describe("the monthly trigger", () => {
  it("starts on the 1st (UTC), once, and carries on through the next days", async () => {
    const { db, env, r2 } = setup({ bigRows: 300 });
    const runs = () => db.prepare("SELECT id, status, trigger FROM backup_runs").all();

    await maybeRunD1Backup(env, new Date("2026-11-30T23:55:00Z"), small);
    expect(runs()).toEqual([]);

    await maybeRunD1Backup(env, new Date("2026-12-01T00:00:00Z"), small);
    expect(runs()).toEqual([{ id: "2026-12-01", status: "running", trigger: "cron" }]);

    // Later ticks keep going (even past the 1st) and never start a second run.
    for (let i = 0; i < 200 && (runs()[0] as { status: string }).status === "running"; i++) {
      await maybeRunD1Backup(env, new Date(i < 50 ? "2026-12-01T04:00:00Z" : "2026-12-02T00:00:00Z"), small);
    }
    await maybeRunD1Backup(env, new Date("2026-12-01T23:55:00Z"), small);
    expect(runs()).toEqual([{ id: "2026-12-01", status: "done", trigger: "cron" }]);
    expect(r2.objects.has("backups/2026-12-01/manifest.json")).toBe(true);
    // Every object is under that month's folder; nothing was deleted (the bucket has no delete).
    expect([...r2.objects.keys()].every((k) => k.startsWith("backups/2026-12-01/"))).toBe(true);

    await maybeRunD1Backup(env, new Date("2027-01-01T00:00:00Z"), small);
    expect(runs()).toHaveLength(2);
  });

  it("does nothing without the private bucket", async () => {
    const { db, env } = setup({ bigRows: 1 });
    await maybeRunD1Backup({ ...env, R2_PRIVATE: undefined } as Env, new Date("2026-12-01T00:00:00Z"), small);
    expect(db.prepare("SELECT COUNT(*) AS n FROM backup_runs").get()).toEqual({ n: 0 });
  });
});

describe("/v1/admin/backup", () => {
  const app = (env: Env) => {
    const root = new Hono<{ Bindings: Env }>();
    root.route("/v1/admin", adminRoute);
    return (method: string) => root.request("/v1/admin/backup", { method }, env);
  };

  it("starts a run, refuses a second, and reports the latest", async () => {
    const { env } = setup({ bigRows: 10 });
    const send = app(env);
    expect(await (await send("GET")).json()).toEqual({ run: null });

    const started = await send("POST");
    expect(started.status).toBe(202);
    const body = await started.json() as { run: { status: string; trigger: string; prefix: string; tables: unknown[] } };
    expect(body.run).toMatchObject({ trigger: "manual" });
    expect(body.run.prefix).toMatch(/^backups\/\d{4}-\d{2}-\d{2}\/$/);

    const again = await send("POST");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: "conflict", message: expect.any(String) } });

    const status = await (await send("GET")).json() as { run: { tables_total: number; tables: Array<{ name: string }> } };
    expect(status.run.tables_total).toBe(status.run.tables.length);
    expect(status.run.tables.map((t) => t.name)).toContain("location_history");
  });

  it("is a 503 without the private bucket", async () => {
    const { env } = setup({ bigRows: 1 });
    const res = await app({ ...env, R2_PRIVATE: undefined } as Env)("POST");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: expect.any(String) } });
  });
});
