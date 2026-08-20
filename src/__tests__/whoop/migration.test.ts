// @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
import { execFile } from "node:child_process";
// @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
import { mkdtemp, readFile, rm } from "node:fs/promises";
// @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
import { tmpdir } from "node:os";
// @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
import { join } from "node:path";
// @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
import process from "node:process";
// @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const WHOOP_TABLES = [
  "whoop_connections",
  "whoop_oauth_states",
  "whoop_profiles",
  "whoop_body_measurements",
  "whoop_cycles",
  "whoop_recoveries",
  "whoop_sleeps",
  "whoop_workouts",
  "whoop_webhook_events",
  "whoop_reconcile_seen",
  "whoop_sync_checkpoints",
  "whoop_sync_runs",
] as const;

const WHOOP_INDEXES = [
  "idx_whoop_profiles_user_updated",
  "idx_whoop_profiles_deleted",
  "idx_whoop_body_measurements_user_updated",
  "idx_whoop_body_measurements_deleted",
  "idx_whoop_cycles_user_start",
  "idx_whoop_cycles_user_end",
  "idx_whoop_cycles_deleted",
  "idx_whoop_recoveries_user_updated",
  "idx_whoop_recoveries_deleted",
  "idx_whoop_sleeps_user_start",
  "idx_whoop_sleeps_user_end",
  "idx_whoop_sleeps_deleted",
  "idx_whoop_workouts_user_start",
  "idx_whoop_workouts_user_end",
  "idx_whoop_workouts_deleted",
  "idx_whoop_webhook_events_user_received",
  "idx_whoop_sync_checkpoints_progress",
  "idx_whoop_sync_runs_user_started",
] as const;

const requiredColumns: Record<string, readonly string[]> = {
  whoop_connections: [
    "connection_id", "credential_version", "reconcile_generation",
    "initial_backfill_pending", "refresh_dispatched_at",
  ],
  whoop_profiles: ["whoop_user_id", "deleted_at", "synced_at", "raw_json"],
  whoop_body_measurements: ["whoop_user_id", "deleted_at", "synced_at", "raw_json"],
  whoop_cycles: ["cycle_id", "whoop_user_id", "kilojoules", "deleted_at", "synced_at", "raw_json"],
  whoop_recoveries: ["sleep_id", "cycle_id", "whoop_user_id", "user_calibrating", "deleted_at", "synced_at", "raw_json"],
  whoop_sleeps: ["sleep_id", "cycle_id", "whoop_user_id", "deleted_at", "synced_at", "raw_json"],
  whoop_workouts: ["workout_id", "whoop_user_id", "kilojoules", "deleted_at", "synced_at", "raw_json"],
  whoop_webhook_events: ["trace_id", "connection_id", "event_type", "status", "attempts"],
  whoop_reconcile_seen: ["connection_id", "reconcile_generation", "reconcile_run_id", "resource", "provider_id"],
  whoop_sync_checkpoints: ["connection_id", "mode", "reconcile_generation", "sync_run_id", "target_id", "window_end"],
  whoop_sync_runs: ["run_id", "whoop_user_id", "trigger", "status"],
};

type WranglerRow = Record<string, unknown>;

const parseWranglerRows = (stdout: string): WranglerRow[] => {
  const payload = JSON.parse(stdout) as Array<{ results?: WranglerRow[] }>;
  return payload[0]?.results ?? [];
};

describe("WHOOP fresh D1 migration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-d1-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const wrangler = async (...args: string[]) => execFileAsync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { cwd: process.cwd(), env: { ...process.env, CI: "true" } },
  );

  it("applies every migration from empty state and creates the final WHOOP schema", async () => {
    const migrationSql = await readFile("migrations/0020_whoop.sql", "utf8");
    expect(migrationSql).not.toMatch(/(?:ALTER|DROP|CREATE)\s+(?:TABLE\s+)?apple_health_/i);

    await wrangler(
      "d1", "migrations", "apply", "personal_api", "--local", "--persist-to", tempDir,
    );

    const schema = await wrangler(
      "d1", "execute", "personal_api", "--local", "--persist-to", tempDir,
      "--command", "SELECT type, name FROM sqlite_master WHERE name LIKE 'whoop_%' OR name LIKE 'idx_whoop_%' ORDER BY type, name",
      "--json",
    );
    const objects = parseWranglerRows(schema.stdout);
    const tables = objects.filter((row) => row.type === "table").map((row) => row.name);
    const indexes = objects.filter((row) => row.type === "index").map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([...WHOOP_TABLES]));
    expect(indexes).toEqual(expect.arrayContaining([...WHOOP_INDEXES]));

    for (const [table, expected] of Object.entries(requiredColumns)) {
      const result = await wrangler(
        "d1", "execute", "personal_api", "--local", "--persist-to", tempDir,
        "--command", `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`, "--json",
      );
      const columns = parseWranglerRows(result.stdout).map((row) => row.name);
      expect(columns, table).toEqual(expect.arrayContaining([...expected]));
    }
  }, 30_000);

  it("enforces representative WHOOP constraints and has no foreign-key violations", async () => {
    await wrangler(
      "d1", "migrations", "apply", "personal_api", "--local", "--persist-to", tempDir,
    );

    const invalidStatus = wrangler(
      "d1", "execute", "personal_api", "--local", "--persist-to", tempDir,
      "--command", "INSERT INTO whoop_connections (whoop_user_id, connection_id, status, granted_scopes, created_at, updated_at) VALUES (42, 'fixture-connection', 'invalid', '', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z')",
    );
    await expect(invalidStatus).rejects.toThrow(/CHECK constraint failed/i);

    const invalidEvent = wrangler(
      "d1", "execute", "personal_api", "--local", "--persist-to", tempDir,
      "--command", "INSERT INTO whoop_webhook_events (trace_id, whoop_user_id, connection_id, resource_id, event_type, received_at, status) VALUES ('trace', 42, 'fixture-connection', 'resource', 'profile.updated', '2026-08-19T12:00:00.000Z', 'received')",
    );
    await expect(invalidEvent).rejects.toThrow(/CHECK constraint failed/i);

    const foreignKeys = await wrangler(
      "d1", "execute", "personal_api", "--local", "--persist-to", tempDir,
      "--command", "PRAGMA foreign_key_check", "--json",
    );
    expect(parseWranglerRows(foreignKeys.stdout)).toEqual([]);
  }, 30_000);

  it("keeps focused WHOOP verification in the package and CI contracts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const ci = await readFile(".github/workflows/ci.yml", "utf8");

    expect(packageJson.scripts?.["test:whoop"]).toBe("vitest run src/__tests__/whoop");
    expect(ci).toMatch(/name:\s*Test WHOOP[\s\S]*?run:\s*npm run test:whoop[\s\S]*?name:\s*Test\b/);
  });
});
