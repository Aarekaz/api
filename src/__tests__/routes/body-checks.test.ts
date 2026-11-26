import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import trainingRoute from "../../routes/training";
import documentsRoute, { captureRoute } from "../../routes/documents";
import vaultRoute from "../../routes/vault";
import { testD1, type TestD1 } from "../helpers/d1";

// What training, documents and vault answer to every kind of body, good and
// bad: status, the whole error body, and what was stored. Written before their
// hand checks moved to Zod schemas; it must not change.

const SHA = "a".repeat(40);
const LONG = "x".repeat(20_001);

// Bodies every route gets, as raw text (undefined: no body at all).
const ANYTHING: Array<string | undefined> = [undefined, "", "not json", "null", "true", "0", "1", '"text"', "[]", "[1]", "{}", '{"a":1}'];

const CASES: Array<[method: string, path: string, bodies: Array<string | undefined>]> = [
  ["PUT", "/v1/training/pick", [
    ...ANYTHING,
    JSON.stringify({ day: "2026-11-24" }),
    JSON.stringify({ day: "2026-11-24", routine_id: "  push  " }),
    JSON.stringify({ day: "2026-11-24", routine_id: "r".repeat(80) }),
    JSON.stringify({ day: "2026-11-24", routine_id: 7 }),
    JSON.stringify({ day: "2026-11-24", routine_id: "   " }),
    JSON.stringify({ day: "2026-11-24", routine_id: null }),
    JSON.stringify({ day: "24-11-2026", routine_id: "push" }),
    JSON.stringify({ day: 20261124 }),
    JSON.stringify([{ day: "2026-11-24" }]),
  ]],
  ["PUT", "/v1/training/routines/legs", [
    ...ANYTHING,
    JSON.stringify({ name: "  " }),
    JSON.stringify({ name: 5 }),
    JSON.stringify({ name: "Legs" }),
    JSON.stringify({ name: ` ${"L".repeat(130)} `, weekdays: "3,1,9,1", position: 2.6 }),
    JSON.stringify({ name: "Legs", weekdays: [7, "2", 2, 0, 1.5], position: "4", exercises: "squats" }),
    JSON.stringify({
      name: "Legs", weekdays: [1], exercises: [
        { name: "Squat", sets: 99, reps: 0.4, reps_max: 12, per_side: "yes", weight: 60, unit: "kilograms", rest: -5, note: " deep " },
        { name: "Plank", seconds: 30, seconds_max: 20, sets: "3" },
        { name: "" }, null, 4, { reps: 5 },
        { name: "Lunge", reps: 10, reps_max: 8, per_side: true, seconds: 45, seconds_max: 60, unit: "lb", rest: 2000 },
      ],
    }),
  ]],
  ["POST", "/v1/training/sets", [
    ...ANYTHING,
    JSON.stringify({ day: "2026-11-24", exercise: "Squat" }),
    JSON.stringify({ day: "2026-11-24", exercise: "Squat", set_number: "1" }),
    JSON.stringify({ day: "2026-11-24", exercise: "  ", set_number: 1 }),
    JSON.stringify({ day: "2026-11-2", exercise: "Squat", set_number: 1 }),
    JSON.stringify({ day: "2026-11-24", exercise: " Squat ", set_number: 1.6, reps: 8, weight: 60.5, unit: "kilograms", routine_id: "legs" }),
    JSON.stringify({ day: "2026-11-24", exercise: "Squat", set_number: 1, reps: "8", weight: null, unit: 3 }),
  ]],
  ["POST", "/v1/documents", [
    ...ANYTHING,
    JSON.stringify({ title: "A note", body: "Hello" }),
    JSON.stringify({ kind: "nope" }),
    JSON.stringify({ title: 5 }),
  ]],
  ["POST", "/v1/capture", [
    ...ANYTHING,
    JSON.stringify({ text: "   " }),
    JSON.stringify({ text: 12 }),
    JSON.stringify({ text: LONG }),
    JSON.stringify({ text: "  Buy milk  " }),
  ]],
  ["POST", "/v1/vault/blobs", [
    ...ANYTHING,
    JSON.stringify({ shas: [] }),
    JSON.stringify({ shas: SHA }),
    JSON.stringify({ shas: [SHA, "abc"] }),
    JSON.stringify({ shas: [SHA.toUpperCase()] }),
    JSON.stringify({ shas: Array.from({ length: 101 }, () => SHA) }),
    JSON.stringify({ shas: [SHA, SHA] }),
  ]],
  ["PUT", "/v1/vault/file", [
    ...ANYTHING,
    JSON.stringify({ path: "../x.md", content: 5, sha: "nope" }),
    JSON.stringify({ path: "Dump.md" }),
    JSON.stringify({ path: "Dump.md", content: 5, sha: "nope" }),
    JSON.stringify({ path: "Dump.md", content: "x".repeat(1_000_001) }),
    JSON.stringify({ path: "Dump.md", content: "hi", sha: "nope" }),
    JSON.stringify({ path: "Dump.md", content: "hi", sha: 5 }),
    JSON.stringify({ path: "Dump.md", content: "hi", sha: SHA.toUpperCase() }),
    JSON.stringify({ path: "Dump.md", content: "hi", sha: null, message: "  tidy  " }),
    JSON.stringify({ path: "Dump.md", content: "hi", sha: SHA, message: 5 }),
    JSON.stringify({ path: "Dump.md", content: "", message: "m".repeat(200) }),
  ]],
  ["POST", "/v1/vault/capture", [
    ...ANYTHING,
    JSON.stringify({ text: "   " }),
    JSON.stringify({ text: "x".repeat(2001) }),
    JSON.stringify({ text: " An idea " }),
  ]],
];

describe("body checks", () => {
  let d1: TestD1;
  let app: Hono<{ Bindings: Env }>;
  let env: Env;
  let github: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00.000Z"));
    d1 = testD1({ migrations: "all" });
    env = { DB: d1.DB, VAULT_GITHUB_TOKEN: "test-token" } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.route("/v1/training", trainingRoute);
    app.route("/v1/documents", documentsRoute);
    app.route("/v1/capture", captureRoute);
    app.route("/v1/vault", vaultRoute);
    github = [];
    // GitHub answers every vault call with a 502, so a body that passes the
    // checks shows up here and as that error, never as a real request.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      github.push({ url: String(input), body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ message: "down" }), { status: 502 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    d1.db.close();
  });

  const stored = () => ({
    picks: d1.db.prepare("SELECT day, routine_id FROM training_picks ORDER BY day").all(),
    routines: d1.db.prepare("SELECT id, name, weekdays, exercises_json, position, archived FROM training_routines ORDER BY id").all(),
    sets: d1.db.prepare("SELECT routine_id, day, exercise, set_number, reps, weight, unit FROM training_sets ORDER BY day, exercise, set_number").all(),
    documents: d1.db.prepare("SELECT kind, title, body, folder, visibility FROM documents ORDER BY created_at, title").all(),
  });

  it.each(CASES)("%s %s", async (method, path, bodies) => {
    const answers = [];
    for (const body of bodies) {
      const res = await app.request(path, { method, body, headers: { "Content-Type": "application/json" } }, env);
      const text = await res.text();
      let json: unknown = text;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      // Documents carry random ids and slugs; what was stored says the rest.
      if (res.status < 300 && /documents|capture/.test(path)) json = Object.keys(json as object).sort();
      answers.push({ body: body && body.length > 200 ? `${body.slice(0, 60)}… (${body.length})` : body, status: res.status, json });
    }
    expect({ answers, stored: stored(), github: github.map((call) => [call.url.replace(/\?.*$/, ""), call.body]) }).toMatchSnapshot();
  });
});
