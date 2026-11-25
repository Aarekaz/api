import type { Env } from "../types/env";
import { dateOnly } from "../utils/date";

/**
 * The monthly D1 backup, to the private bucket only (R2_PRIVATE; never the
 * public media bucket). On the 1st of each month (UTC) a run copies every table
 * to `backups/YYYY-MM-DD/<table>.ndjson.gz` (one JSON object per row, gzip) and
 * finishes with `manifest.json`. It works a few seconds at a time from the
 * five-minute cron and picks up where it left off (migrations/0047), so no tick
 * runs long. Old backups are never deleted: this file never calls delete on a
 * bucket.
 *
 * A tick reads rows in rowid order (keyset paging, so a big table like
 * location_history costs the same per page at the end as at the start), and
 * compresses what it read as one gzip member. A file can be several members
 * back to back, which gzip allows: gunzip, zcat and Python's gzip read it as one.
 * A large table goes up as a multipart upload; R2 needs every part but the last
 * to be the same size, so what doesn't fill a part waits in backup_carry.
 */

export const BACKUP_PART_BYTES = 5 * 1024 * 1024; // R2's smallest part
const CARRY_CHUNK = 900_000;                       // base64 characters per row, under D1's 2 MB
const MAX_ATTEMPTS = 5;                            // failed ticks in a row before a run is given up
const LEASE_MS = 2 * 60_000;

export interface BackupOptions {
  now?: () => Date;
  /** Bytes per multipart part (R2: at least 5 MiB). */
  partBytes?: number;
  /** How long one tick works before stopping. */
  tickMs?: number;
  /** Raw (uncompressed) bytes one tick reads before stopping. */
  tickRawBytes?: number;
  /** Rows in the first page of a table, before its row size is known. */
  firstPageRows?: number;
  /** Most rows in a page. */
  maxPageRows?: number;
  /** Raw bytes a page aims for, once a table's row size is known. */
  pageBytes?: number;
}

const DEFAULTS = {
  partBytes: BACKUP_PART_BYTES,
  tickMs: 10_000,
  tickRawBytes: 24 * 1024 * 1024,
  firstPageRows: 100,
  maxPageRows: 1000,
  pageBytes: 2 * 1024 * 1024,
};

export class BackupError extends Error {
  constructor(readonly status: 409 | 503, message: string, readonly code: string) {
    super(message);
  }
}

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };
type RunRow = {
  id: string; status: string; trigger: string; prefix: string; started_at: string; finished_at: string | null;
  updated_at: string; ticks: number; attempts: number; error: string | null; lease_until: string | null; schema_json: string;
};
type TableRow = {
  run_id: string; name: string; position: number; sql: string | null; without_rowid: number; status: string;
  last_rowid: number | null; rows: number; raw_bytes: number; bytes: number; upload_id: string | null;
  parts_json: string; carry_gen: number; carry_bytes: number;
};
type Part = { partNumber: number; etag: string };

// MARK: Which tables

const FTS_SHADOW = ["data", "idx", "docsize", "config", "content"];

/**
 * The tables a backup copies, from sqlite_master. SQLite's and Cloudflare's own
 * tables (sqlite_*, _cf_*) are left out; d1_migrations is kept, so a restore
 * knows which migrations its schema has. A virtual table (the documents search
 * index) and its storage tables are skipped: they are rebuilt from the content
 * table (`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`).
 */
export function planTables(master: MasterRow[]) {
  const own = master.filter((m) => !m.name.startsWith("sqlite_") && !m.name.startsWith("_cf_"));
  const virtual = own.filter((m) => m.type === "table" && /^\s*create\s+virtual\s+table/i.test(m.sql ?? "")).map((m) => m.name);
  const tables: Array<{ name: string; sql: string | null; without_rowid: boolean }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const m of own.filter((m) => m.type === "table").sort((a, b) => a.name.localeCompare(b.name))) {
    if (virtual.includes(m.name)) skipped.push({ name: m.name, reason: "virtual table; rebuild it from its content table" });
    else if (virtual.some((v) => FTS_SHADOW.some((s) => m.name === `${v}_${s}`))) skipped.push({ name: m.name, reason: "storage of a virtual table" });
    else if (m.name === "backup_carry") skipped.push({ name: m.name, reason: "the backup's own bytes in flight" });
    else tables.push({ name: m.name, sql: m.sql, without_rowid: /without\s+rowid\s*;?\s*$/i.test(m.sql ?? "") });
  }
  return { tables, skipped, schema: own.filter((m) => m.sql).map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql })) };
}

/** The 1st of the month (UTC) starts a run. */
export const isBackupDay = (now: Date) => now.getUTCDate() === 1;

// MARK: Starting and reading a run

export async function startBackup(env: Env, trigger: "cron" | "manual", now = new Date()): Promise<RunRow> {
  if (!env.R2_PRIVATE) throw new BackupError(503, "The private bucket (R2_PRIVATE) isn't bound", "unavailable");
  const running = await env.DB.prepare("SELECT id FROM backup_runs WHERE status = 'running' LIMIT 1").first<{ id: string }>();
  if (running) throw new BackupError(409, `Backup ${running.id} is still running`, "conflict");
  const id = dateOnly(now);
  const { results } = await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all<MasterRow>();
  const plan = planTables(results);
  const stamp = now.toISOString();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO backup_runs (id, status, trigger, prefix, started_at, updated_at, schema_json)
       VALUES (?, 'running', ?, ?, ?, ?, ?)`,
    ).bind(id, trigger, `backups/${id}/`, stamp, stamp, JSON.stringify({ schema: plan.schema, skipped: plan.skipped })),
    ...plan.tables.map((t, position) => env.DB.prepare(
      "INSERT OR IGNORE INTO backup_tables (run_id, name, position, sql, without_rowid) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, t.name, position, t.sql, t.without_rowid ? 1 : 0)),
  ]);
  if (!(inserted as D1Result).meta.changes) throw new BackupError(409, `There is already a backup for ${id}`, "conflict");
  return (await env.DB.prepare("SELECT * FROM backup_runs WHERE id = ?").bind(id).first<RunRow>())!;
}

/** The latest run and how far each table has got, or null before the first run. */
export async function backupStatus(env: Env) {
  const run = await env.DB.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 1").first<RunRow>();
  if (!run) return null;
  const { results } = await env.DB.prepare(
    "SELECT name, status, rows, bytes FROM backup_tables WHERE run_id = ? ORDER BY position",
  ).bind(run.id).all<{ name: string; status: string; rows: number; bytes: number }>();
  return {
    id: run.id, status: run.status, trigger: run.trigger, prefix: run.prefix,
    started_at: run.started_at, finished_at: run.finished_at, updated_at: run.updated_at,
    ticks: run.ticks, error: run.error,
    tables_total: results.length, tables_done: results.filter((t) => t.status === "done").length,
    rows: results.reduce((n, t) => n + t.rows, 0), bytes: results.reduce((n, t) => n + t.bytes, 0),
    tables: results,
  };
}

// MARK: A tick

/**
 * One tick of the running backup, if there is one: copies tables until the
 * tick's time or byte budget is spent, and writes the manifest once every table
 * is done. Another tick still at work (a lease) means this one does nothing.
 */
export async function backupTick(env: Env, options: BackupOptions = {}) {
  const bucket = env.R2_PRIVATE;
  if (!bucket) return null;
  const o = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => new Date());
  const run = await env.DB.prepare("SELECT * FROM backup_runs WHERE status = 'running' ORDER BY started_at LIMIT 1").first<RunRow>();
  if (!run) return null;
  const start = now();
  const claim = await env.DB.prepare(
    `UPDATE backup_runs SET lease_until = ?, ticks = ticks + 1, updated_at = ?
      WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
  ).bind(new Date(start.getTime() + LEASE_MS).toISOString(), start.toISOString(), run.id, start.toISOString()).run();
  if (!claim.meta.changes) return backupStatus(env);

  try {
    const budget = { until: start.getTime() + o.tickMs, raw: o.tickRawBytes };
    const spent = () => now().getTime() >= budget.until || budget.raw <= 0;
    const { results: tables } = await env.DB.prepare(
      "SELECT * FROM backup_tables WHERE run_id = ? AND status != 'done' ORDER BY position",
    ).bind(run.id).all<TableRow>();
    let left = tables.length;
    for (const table of tables) {
      if (spent()) break;
      if (await copySome(env, bucket, run, table, budget, spent, o)) left -= 1;
    }
    const stamp = now().toISOString();
    if (left === 0) {
      await writeManifest(env, bucket, run, stamp);
      await env.DB.prepare(
        "UPDATE backup_runs SET status = 'done', finished_at = ?, updated_at = ?, attempts = 0, error = NULL, lease_until = NULL WHERE id = ?",
      ).bind(stamp, stamp, run.id).run();
    } else {
      await env.DB.prepare("UPDATE backup_runs SET updated_at = ?, attempts = 0, error = NULL, lease_until = NULL WHERE id = ?")
        .bind(stamp, run.id).run();
    }
  } catch (error) {
    // The next tick starts again from the last saved state; a run that keeps failing is given up.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`D1 backup ${run.id} tick failed`, error);
    await env.DB.prepare(
      `UPDATE backup_runs SET attempts = attempts + 1, error = ?, updated_at = ?, lease_until = NULL,
         status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
       WHERE id = ?`,
    ).bind(message.slice(0, 500), now().toISOString(), MAX_ATTEMPTS, run.id).run();
  }
  return backupStatus(env);
}

/** The cron's part: start this month's run on the 1st, then move whichever run is going on. */
export async function maybeRunD1Backup(env: Env, now = new Date(), options: BackupOptions = {}) {
  if (!env.R2_PRIVATE) return;
  try {
    if (isBackupDay(now)) {
      const today = await env.DB.prepare("SELECT 1 FROM backup_runs WHERE id = ?").bind(dateOnly(now)).first();
      if (!today) await startBackup(env, "cron", now).catch((error) => {
        if (!(error instanceof BackupError)) throw error; // another run still going: try again next tick
      });
    }
    await backupTick(env, options);
  } catch (error) {
    console.error("D1 backup failed", error);
  }
}

// MARK: Copying one table

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;
const encoder = new TextEncoder();

/**
 * Copies the next rows of one table, as many as the budget allows, and saves
 * where it got to. Returns true when the table is done. Parts go up before the
 * state that counts them is saved, so a tick that dies in between is redone
 * from the old state and uploads the same part numbers again (R2 keeps the
 * last upload of a part number).
 */
async function copySome(
  env: Env, bucket: R2Bucket, run: RunRow, t: TableRow,
  budget: { raw: number }, spent: () => boolean, o: typeof DEFAULTS,
): Promise<boolean> {
  const gzip = new CompressionStream("gzip");
  const compressed = new Response(gzip.readable).arrayBuffer();
  const writer = gzip.writable.getWriter();

  let last = t.last_rowid;
  let rows = 0, raw = 0, done = false;
  const avg = t.rows > 0 ? t.raw_bytes / t.rows : 0;
  let limit = avg ? pageLimit(avg, o) : o.firstPageRows;
  while (!done) {
    if (rows > 0 && spent()) break;
    let page: Array<Record<string, unknown>>;
    if (t.without_rowid) {
      // None today; such a table has no rowid to page by, so it goes in one read.
      page = (await env.DB.prepare(`SELECT * FROM ${quoted(t.name)}`).all<Record<string, unknown>>()).results;
      done = true;
    } else {
      const where = last === null ? "" : "WHERE rowid > ?";
      const statement = env.DB.prepare(`SELECT rowid AS __backup_rowid, * FROM ${quoted(t.name)} ${where} ORDER BY rowid LIMIT ?`);
      page = (await (last === null ? statement.bind(limit) : statement.bind(last, limit)).all<Record<string, unknown>>()).results;
      if (page.length < limit) done = true;
      if (page.length) last = Number(page[page.length - 1].__backup_rowid);
    }
    if (!page.length) break;
    let text = "";
    for (const row of page) {
      delete row.__backup_rowid;
      text += JSON.stringify(row) + "\n";
    }
    const bytes = encoder.encode(text);
    await writer.write(bytes);
    rows += page.length;
    raw += bytes.length;
    budget.raw -= bytes.length;
    limit = pageLimit((t.raw_bytes + raw) / (t.rows + rows), o);
  }
  await writer.close();
  const member = new Uint8Array(await compressed);

  const carry = await loadCarry(env, run.id, t.name, t.carry_gen, t.carry_bytes);
  // Always the member, even with no rows: an empty table is still a valid (empty) gzip file.
  const buffer = concat(carry, member);
  const key = `${run.prefix}${t.name}.ndjson.gz`;
  const httpMetadata = { contentType: "application/gzip" };
  let uploadId = t.upload_id;
  const parts: Part[] = JSON.parse(t.parts_json);
  let sent = t.bytes;
  let rest = buffer;

  if (done && !uploadId) {
    await bucket.put(key, buffer, { httpMetadata, customMetadata: { table: t.name, rows: String(t.rows + rows) } });
    sent = buffer.length;
    rest = new Uint8Array();
  } else if (buffer.length >= o.partBytes || (done && uploadId)) {
    const upload = uploadId
      ? bucket.resumeMultipartUpload(key, uploadId)
      : await bucket.createMultipartUpload(key, { httpMetadata, customMetadata: { table: t.name } });
    uploadId = upload.uploadId;
    let offset = 0;
    while (buffer.length - offset >= o.partBytes) {
      const part = await upload.uploadPart(parts.length + 1, buffer.subarray(offset, offset + o.partBytes));
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      offset += o.partBytes;
      sent += o.partBytes;
    }
    rest = buffer.subarray(offset);
    if (done) {
      if (rest.length) {
        const part = await upload.uploadPart(parts.length + 1, rest);
        parts.push({ partNumber: part.partNumber, etag: part.etag });
        sent += rest.length;
      }
      await upload.complete(parts);
      rest = new Uint8Array();
    }
  }

  // New leftover bytes are written under a new generation before the state
  // points at them; the old generation goes in the same batch that moves on.
  const gen = t.carry_gen + 1;
  const encoded = base64(rest);
  for (let i = 0, seq = 0; i < encoded.length; i += CARRY_CHUNK, seq++) {
    await env.DB.prepare("INSERT OR REPLACE INTO backup_carry (run_id, name, gen, seq, data) VALUES (?, ?, ?, ?, ?)")
      .bind(run.id, t.name, gen, seq, encoded.slice(i, i + CARRY_CHUNK)).run();
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE backup_tables SET status = ?, last_rowid = ?, rows = rows + ?, raw_bytes = raw_bytes + ?, bytes = ?,
         upload_id = ?, parts_json = ?, carry_gen = ?, carry_bytes = ? WHERE run_id = ? AND name = ?`,
    ).bind(done ? "done" : "writing", last, rows, raw, sent, uploadId, JSON.stringify(parts), gen, rest.length, run.id, t.name),
    env.DB.prepare("DELETE FROM backup_carry WHERE run_id = ? AND name = ? AND gen != ?").bind(run.id, t.name, gen),
  ]);
  return done;
}

const pageLimit = (avgRowBytes: number, o: typeof DEFAULTS) =>
  Math.max(1, Math.min(o.maxPageRows, Math.floor(o.pageBytes / Math.max(avgRowBytes, 1))));

async function loadCarry(env: Env, runId: string, name: string, gen: number, size: number): Promise<Uint8Array> {
  if (!size) return new Uint8Array();
  const { results } = await env.DB.prepare(
    "SELECT data FROM backup_carry WHERE run_id = ? AND name = ? AND gen = ? ORDER BY seq",
  ).bind(runId, name, gen).all<{ data: string }>();
  const bytes = unbase64(results.map((r) => r.data).join(""));
  if (bytes.length !== size) throw new Error(`Backup carry for ${name} is ${bytes.length} bytes, expected ${size}`);
  return bytes;
}

async function writeManifest(env: Env, bucket: R2Bucket, run: RunRow, finishedAt: string) {
  const { results } = await env.DB.prepare(
    "SELECT name, sql, rows, raw_bytes, bytes FROM backup_tables WHERE run_id = ? ORDER BY position",
  ).bind(run.id).all<{ name: string; sql: string | null; rows: number; raw_bytes: number; bytes: number }>();
  const { schema, skipped } = JSON.parse(run.schema_json) as { schema: unknown[]; skipped: unknown[] };
  const manifest = {
    database: "personal_api",
    run: run.id,
    trigger: run.trigger,
    started_at: run.started_at,
    finished_at: finishedAt,
    format: "Each <table>.ndjson.gz holds one JSON object per row, in rowid order. A file can be several gzip members back to back; gunzip, zcat and Python's gzip read it as one. Rows were read over several cron ticks, so the files are not one moment in time (D1 Time Travel is).",
    tables: results.map((t) => ({ name: t.name, key: `${run.prefix}${t.name}.ndjson.gz`, rows: t.rows, bytes: t.bytes, raw_bytes: t.raw_bytes, sql: t.sql })),
    totals: { tables: results.length, rows: results.reduce((n, t) => n + t.rows, 0), bytes: results.reduce((n, t) => n + t.bytes, 0) },
    skipped,
    schema,
  };
  await bucket.put(`${run.prefix}manifest.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json" } });
}

// MARK: Bytes

function concat(a: Uint8Array, b: Uint8Array) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function unbase64(text: string) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
