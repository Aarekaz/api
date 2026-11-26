// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { testD1 } from "../helpers/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import linksRoute from "../../routes/links";
import { creditedSeconds } from "../../services/links/state";

// Time read from the seconds the app measures (docs/adr/0006): clamped to the
// wall clock, counted when progress doesn't move or loses the race, once per
// report_id; `words` raises reading_minutes; no `seconds` keeps the old formula.

const PAGE = `<html><head><meta property="og:title" content="Memorized Rules"></head>
<body><article><p>The first paragraph is long enough to count as the start of a real article you would read.</p>
<p>The second paragraph keeps going so there is more than one block to place a reader in.</p></article></body></html>`;

function d1(withReports = true): D1Database {
  const { db, DB } = testD1();
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  for (const file of ["0025_documents", "0026_highlights", "0036_links_state", "0038_reading_days", ...(withReports ? ["0051_reading_reports"] : [])]) {
    db.exec(readFileSync(`migrations/${file}.sql`, "utf8"));
  }
  return DB;
}

function setup(withReports = true) {
  const env = { DB: d1(withReports) } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/links", linksRoute);
  const send = (path: string, method = "GET", body?: unknown) =>
    root.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  const save = async (url: string) => (await (await send("/v1/links", "POST", { url })).json()) as { id: string; reading_minutes: number };
  const minutes = async (day: string) =>
    (await env.DB.prepare("SELECT COALESCE(SUM(minutes), 0) AS m FROM reading_days WHERE day = ?").bind(day).first<{ m: number }>())!.m;
  return { env, send, save, minutes };
}

const at = (time: string) => vi.setSystemTime(new Date(`2026-11-20T${time}.000Z`));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("links: time read from seconds", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("09:00:00");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("credits the seconds read on the sent day, not progress times reading_minutes", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://julian.com/blog/memorized-rules");
    at("10:00:00");
    const res = await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.57, seconds: 300, day: "2026-11-19", report_id: uuid(1) });
    expect(res.status).toBe(200);
    // The reply is the same shape as before.
    expect(Object.keys(await res.json() as object).sort()).toEqual(["applied", "opened_at", "progress", "progress_anchor", "progress_device", "progress_updated_at"]);
    expect(await minutes("2026-11-19")).toBeCloseTo(5, 5);
  });

  it("counts re-reading: progress that doesn't move, or goes back, still adds the seconds", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://example.com/essay");
    const put = (body: object) => send(`/v1/links/${link.id}/progress`, "PUT", { day: "2026-11-20", ...body });
    at("10:00:00");
    await put({ progress: 1, seconds: 120, report_id: uuid(1) });
    at("10:05:00");
    await put({ progress: 1, seconds: 240, report_id: uuid(2) });
    at("10:10:00");
    await put({ progress: 0.2, seconds: 60, report_id: uuid(3) });
    expect(await minutes("2026-11-20")).toBeCloseTo(7, 5);
  });

  it("counts a report that lost the last-write-wins race", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://example.com/essay");
    at("11:00:00");
    await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.7, updated_at: "2026-11-20T11:00:00.000Z", seconds: 60, report_id: uuid(1), day: "2026-11-20" });
    at("11:04:00");
    const stale = await (await send(`/v1/links/${link.id}/progress`, "PUT", {
      progress: 0.4, updated_at: "2026-11-20T10:30:00.000Z", seconds: 180, report_id: uuid(2), day: "2026-11-20",
    })).json() as { applied: boolean; progress: number };
    expect(stale).toMatchObject({ applied: false, progress: 0.7 });
    expect(await minutes("2026-11-20")).toBeCloseTo(4, 5);
  });

  it("clamps to the time since the previous progress plus 30 s, and 10 minutes a report", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://example.com/essay");
    const put = (body: object) => send(`/v1/links/${link.id}/progress`, "PUT", { day: "2026-11-20", progress: 0.1, ...body });
    // No previous progress: the 10-minute cap.
    at("10:00:00");
    await put({ seconds: 3600, report_id: uuid(1) });
    expect(await minutes("2026-11-20")).toBeCloseTo(10, 5);
    // 60 s later a report claims 5 minutes: 60 + 30 s.
    at("10:01:00");
    await put({ seconds: 300, report_id: uuid(2) });
    expect(await minutes("2026-11-20")).toBeCloseTo(11.5, 5);
    // An hour later, a clock-confused 2 hours: still 10 minutes.
    at("11:01:00");
    await put({ seconds: 7200, report_id: uuid(3) });
    expect(await minutes("2026-11-20")).toBeCloseTo(21.5, 5);
  });

  it("counts a retried report once, by report_id", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://example.com/essay");
    at("10:00:00");
    const body = { progress: 0.3, seconds: 120, report_id: uuid(7), day: "2026-11-20" };
    expect((await send(`/v1/links/${link.id}/progress`, "PUT", body)).status).toBe(200);
    at("10:00:05");
    expect((await send(`/v1/links/${link.id}/progress`, "PUT", body)).status).toBe(200);
    expect(await minutes("2026-11-20")).toBeCloseTo(2, 5);
    // The same id on another link is another report.
    const other = await save("https://example.com/other");
    await send(`/v1/links/${other.id}/progress`, "PUT", body);
    expect(await minutes("2026-11-20")).toBeCloseTo(4, 5);
  });

  it("counts reports without a report_id, and every report before migration 0051 is applied", async () => {
    const { send, save, minutes } = setup(false);
    const link = await save("https://example.com/essay");
    at("10:00:00");
    const res = await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.3, seconds: 90, report_id: uuid(1), day: "2026-11-20" });
    expect(res.status).toBe(200);
    at("10:02:00");
    await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.3, seconds: 30, day: "2026-11-20" });
    expect(await minutes("2026-11-20")).toBeCloseTo(2, 5);
  });

  it("accepts POST as well as PUT", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://example.com/essay");
    const res = await send(`/v1/links/${link.id}/progress`, "POST", { progress: 0.5, seconds: 60, report_id: uuid(1), day: "2026-11-20" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: true, progress: 0.5 });
    expect(await minutes("2026-11-20")).toBeCloseTo(1, 5);
  });

  it("refuses bad seconds, words and report_id with the one error shape", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/essay");
    for (const bad of [{ seconds: -1 }, { seconds: "60" }, { words: 1.5 }, { words: -3 }, { report_id: "not-a-uuid" }]) {
      const res = await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.2, ...bad });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid");
    }
  });
});

describe("links: words and the old formula", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("09:00:00");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("without seconds keeps progress gained times reading_minutes", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://example.com/essay");
    expect(link.reading_minutes).toBe(1);
    await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.5, day: "2026-11-20" });
    expect(await minutes("2026-11-20")).toBeCloseTo(0.5, 5);
  });

  it("words raise reading_minutes (230 a minute) and the old formula uses it", async () => {
    const { send, save, minutes } = setup();
    const link = await save("https://julian.com/blog/memorized-rules");
    await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.5, words: 9200, day: "2026-11-20" });
    const got = await (await send(`/v1/links/${link.id}`)).json() as { reading_minutes: number };
    expect(got.reading_minutes).toBe(40);
    expect(await minutes("2026-11-20")).toBeCloseTo(20, 5);
  });

  it("words never lower reading_minutes", async () => {
    const { env, send, save } = setup();
    const link = await save("https://example.com/essay");
    await env.DB.prepare("UPDATE links SET reading_minutes = 25 WHERE document_id = ?").bind(link.id).run();
    await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.1, words: 460 });
    const got = await (await send(`/v1/links/${link.id}`)).json() as { reading_minutes: number };
    expect(got.reading_minutes).toBe(25);
  });
});

describe("creditedSeconds", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");
  it("takes the least of what was sent, the window plus slack, and ten minutes", () => {
    expect(creditedSeconds(100, "2026-11-20T09:59:00.000Z", now)).toBe(90);
    expect(creditedSeconds(50, "2026-11-20T09:59:00.000Z", now)).toBe(50);
    expect(creditedSeconds(5000, "2026-11-20T08:00:00.000Z", now)).toBe(600);
    expect(creditedSeconds(5000, null, now)).toBe(600);
    // A previous time from a fast clock leaves only the slack.
    expect(creditedSeconds(100, "2026-11-20T10:00:50.000Z", now)).toBe(30);
    expect(creditedSeconds(0, null, now)).toBe(0);
  });
});
