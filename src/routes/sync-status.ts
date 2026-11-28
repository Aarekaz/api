import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { authSecurity, dateTimeSchema, okResponses, openApiRegistry } from "../schemas/openapi";

// GET /v1/sync/status: when each source last synced, for the apps' Settings.
const app = new Hono<{ Bindings: Env }>();

const SYSTEM_TAG = "System";

async function value<T>(env: Env, sql: string): Promise<T | null> {
  try {
    return (await env.DB.prepare(sql).first<T>()) ?? null;
  } catch {
    return null; // A missing table means that source isn't set up; report it as unknown.
  }
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/sync/status",
  tags: [SYSTEM_TAG],
  summary: "Get when each data source last synced",
  security: authSecurity,
  responses: okResponses(z.object({
    server_time: dateTimeSchema,
    sources: z.array(z.object({
      id: z.enum(["documents", "whoop", "wakatime", "github", "spotify", "backup"]),
      name: z.string(),
      last_success_at: z.string().nullable(),
      status: z.string().openapi({ description: "ok, unknown, pending or error, or the source's own sync status" }),
      detail: z.string().optional().openapi({ description: "documents only" }),
      error: z.string().nullable().optional().openapi({ description: "backup only" }),
    })),
  })),
});

app.get("/", async (c) => {
  const env = c.env;
  const [documents, whoopData, whoopRun, wakatime, github, spotify, backup] = await Promise.all([
    value<{ last: string | null; count: number }>(env, "SELECT MAX(updated_at) AS last, COUNT(*) AS count FROM documents WHERE deleted_at IS NULL"),
    value<{ last: string | null }>(env, "SELECT MAX(synced_at) AS last FROM whoop_cycles"),
    value<{ status: string; updated_at: string | null }>(env, "SELECT status, updated_at FROM whoop_sync_runs ORDER BY rowid DESC LIMIT 1"),
    value<{ last: string | null }>(env, "SELECT MAX(created_at) AS last FROM wakatime_days"),
    value<{ last: string | null }>(env, "SELECT MAX(created_at) AS last FROM github_daily"),
    value<{ status: string; refreshed_at: string | null; connected_at: string | null }>(env, "SELECT status, refreshed_at, connected_at FROM spotify_connections WHERE id = 1"),
    value<{ last_success_at: string | null; last_error_at: string | null; last_error: string | null }>(env, "SELECT last_success_at, last_error_at, last_error FROM job_runs WHERE job = 'vault_backup'"),
  ]);

  return c.json({
    server_time: new Date().toISOString(),
    sources: [
      { id: "documents", name: "Notes and writing", last_success_at: documents?.last ?? null, detail: `${documents?.count ?? 0} documents`, status: "ok" },
      { id: "whoop", name: "WHOOP", last_success_at: whoopData?.last ?? null, status: whoopRun?.status ?? (whoopData?.last ? "ok" : "unknown") },
      { id: "wakatime", name: "WakaTime", last_success_at: wakatime?.last ?? null, status: wakatime?.last ? "ok" : "unknown" },
      { id: "github", name: "GitHub", last_success_at: github?.last ?? null, status: github?.last ? "ok" : "unknown" },
      { id: "spotify", name: "Spotify", last_success_at: spotify?.refreshed_at ?? spotify?.connected_at ?? null, status: spotify?.status ?? "unknown" },
      {
        id: "backup", name: "GitHub backup", last_success_at: backup?.last_success_at ?? null,
        status: backup?.last_error_at && (!backup.last_success_at || backup.last_error_at > backup.last_success_at) ? "error" : backup?.last_success_at ? "ok" : "pending",
        error: backup?.last_error ?? null,
      },
    ],
  });
});

export default app;
