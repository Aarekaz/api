#!/usr/bin/env node
// Fills visits.local_date and journeys.local_date (migrations/0048_local_date.sql)
// on rows written before the column existed. Run once, after the migration and
// the deploy that writes the column at ingest:
//
//   node scripts/backfill-local-date.mjs              # local D1 (.wrangler)
//   node scripts/backfill-local-date.mjs --remote     # the real database
//   node scripts/backfill-local-date.mjs --remote --dry-run
//
// The rule is services/places.ts localDate: the UTC time shifted by the row's
// own utc_offset; a row without one is read in America/New_York (the owner's
// home, summer time included). Visits go by arrived_at, journeys by started_at.
// It reads 500 rows at a time by id, writes one UPDATE per batch, only touches
// rows whose local_date is still null (safe to stop and run again), and moves
// the places data version on at the end so clients refetch (ETags).
// Take a D1 bookmark before running it with --remote.
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log("node scripts/backfill-local-date.mjs [--remote] [--dry-run] [--batch=500]");
  process.exit(0);
}
const target = args.has("--remote") ? "--remote" : "--local";
const dryRun = args.has("--dry-run");
const batch = Number([...args].find((a) => a.startsWith("--batch="))?.slice(8) ?? 500);
const DATABASE = "personal_api";
const HOME_TIME_ZONE = "America/New_York";

const homeDate = new Intl.DateTimeFormat("en-US", { timeZone: HOME_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

function localDate(at, utcOffset) {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  if (utcOffset !== null && utcOffset !== undefined) return new Date(ms + Number(utcOffset) * 60_000).toISOString().slice(0, 10);
  const parts = homeDate.formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function d1(sql) {
  const run = spawnSync("npx", ["wrangler", "d1", "execute", DATABASE, target, "--json", "--command", sql], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });
  if (run.status !== 0) throw new Error(`wrangler failed (${run.status}): ${run.stderr || run.stdout}`);
  const out = JSON.parse(run.stdout);
  return (Array.isArray(out) ? out : [out]).flatMap((r) => r.results ?? []);
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function backfill(table, column) {
  let after = 0, filled = 0;
  for (;;) {
    const rows = d1(
      `SELECT id, ${column} AS at, utc_offset FROM ${table} WHERE local_date IS NULL AND id > ${after} ORDER BY id LIMIT ${batch}`,
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const known = rows.map((r) => ({ id: r.id, date: localDate(r.at, r.utc_offset) })).filter((r) => r.date);
    if (known.length && !dryRun) {
      d1(`UPDATE ${table} SET local_date = CASE id ${known.map((r) => `WHEN ${r.id} THEN ${quote(r.date)}`).join(" ")} END
          WHERE local_date IS NULL AND id IN (${known.map((r) => r.id).join(",")})`);
    }
    filled += known.length;
    console.log(`${table}: ${filled} rows${dryRun ? " (dry run)" : ""}, up to id ${after}`);
  }
  return filled;
}

console.log(`Backfilling local_date on ${target === "--remote" ? "the REMOTE" : "the local"} database${dryRun ? " (dry run)" : ""}.`);
const visits = backfill("visits", "arrived_at");
const journeys = backfill("journeys", "started_at");
if (!dryRun && visits + journeys > 0) {
  d1(`INSERT INTO data_versions (name, version, updated_at) VALUES ('places', 1, ${quote(new Date().toISOString())})
      ON CONFLICT(name) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`);
}
console.log(`Done: ${visits} visits, ${journeys} journeys.`);
