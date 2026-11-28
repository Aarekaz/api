import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { failWith, later, ok } from "../lib/http";
import { backupStatus, backupTick, startBackup } from "../services/d1-backup";
import { backfillJournalWords } from "../services/journal-words";
import {
  authSecurity, dateSchema, dateTimeSchema, apiTags, openApiRegistry, openApiResponse, structuredErrorResponses, structuredOkResponses,
} from "../schemas/openapi";

// /v1/admin: the owner's housekeeping. The monthly D1 backup runs from the
// cron on the 1st; these start one now and say how the latest one is going.
const app = new Hono<{ Bindings: Env }>();

const SYSTEM_TAG = "System";
apiTags.push({
  name: SYSTEM_TAG,
  description: `The API's own housekeeping: sign-in for the apps, refreshes, sync times, status, backups, export and traffic. \
Private: nothing here is shown on anuragd.me.

**Reading.** GET /v1/sync/status says when each source last synced. GET /v1/status has the latest Discord status and each \
refresh job's health. GET /v1/export returns every table at once: use the area's own endpoints when you only need one.

**Avoid.** Don't call POST /v1/refresh, POST /v1/status/refresh or POST /v1/admin/backup unless the owner asks: the \
every-five-minutes cron refreshes sources, and a D1 backup runs on the 1st of each month. \
/auth/app/* and POST /v1/app/signout are for the native apps' Sign in with GitHub; agents use their bearer token instead.`,
});


const runSchema = z.object({
  id: dateSchema.openapi({ description: "The run's UTC date, also its folder" }),
  status: z.enum(["running", "done", "failed"]),
  trigger: z.enum(["cron", "manual"]),
  prefix: z.string().openapi({ example: "backups/2026-12-01/", description: "Folder in the private bucket" }),
  started_at: dateTimeSchema,
  finished_at: dateTimeSchema.nullable(),
  updated_at: dateTimeSchema,
  ticks: z.number().int().openapi({ description: "Cron ticks (or requests) that worked on it" }),
  error: z.string().nullable().openapi({ description: "The last tick's error; the next tick tries again" }),
  tables_total: z.number().int(),
  tables_done: z.number().int(),
  rows: z.number().int(),
  bytes: z.number().int().openapi({ description: "Compressed bytes written so far" }),
  tables: z.array(z.object({
    name: z.string(),
    status: z.enum(["pending", "writing", "done"]),
    rows: z.number().int(),
    bytes: z.number().int(),
  })),
});
const statusSchema = z.object({ run: runSchema.nullable().openapi({ description: "null before the first backup" }) });

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/admin/backup",
  tags: [SYSTEM_TAG],
  summary: "Get the latest D1 backup's progress",
  security: authSecurity,
  responses: structuredOkResponses(statusSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/admin/backup",
  tags: [SYSTEM_TAG],
  summary: "Start a D1 backup to the private bucket now",
  description: "Copies every table to backups/YYYY-MM-DD/ in the private bucket over the next cron ticks. 409 when one is running or today's exists.",
  security: authSecurity,
  responses: { 202: openApiResponse(statusSchema, "Started"), ...structuredErrorResponses },
});

const journalWordsSchema = z.object({
  counted: z.number().int().openapi({ description: "Entries counted by this call" }),
  more: z.boolean().openapi({ description: "Whether entries without a current count remain; call again" }),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/admin/journal-words",
  tags: [SYSTEM_TAG],
  summary: "Store word counts for up to 200 journal entries that lack a current one",
  description: "Fills journal_words (migration 0055) for /v1/journal/stats. Safe to repeat: it only writes counts, and a current count is never rewritten. Call until `more` is false.",
  security: authSecurity,
  responses: structuredOkResponses(journalWordsSchema),
});

app.post("/journal-words", async (c) => {
  try {
    return ok(c, await backfillJournalWords(c.env));
  } catch (error) {
    return failWith(c, error, "Journal word count");
  }
});

app.get("/backup", async (c) => {
  try {
    return ok(c, { run: await backupStatus(c.env) });
  } catch (error) {
    return failWith(c, error, "Backup status");
  }
});

app.post("/backup", async (c) => {
  try {
    await startBackup(c.env, "manual");
    // The first tick runs now; the cron carries on from there.
    const tick = backupTick(c.env);
    const after = later(c);
    if (after) after(tick); else await tick;
    return ok(c, { run: await backupStatus(c.env) }, 202);
  } catch (error) {
    return failWith(c, error, "Backup request");
  }
});

export default app;
