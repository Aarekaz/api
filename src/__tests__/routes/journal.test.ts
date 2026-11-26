// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { testD1 } from "../helpers/d1";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import journalRoute, { countWords, dayIn, moodFor, streakOf } from "../../routes/journal";

/** A real SQLite database behind the subset of the D1 API the code uses. */
function d1(): D1Database {
  const { db, DB } = testD1();
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  db.exec(readFileSync("migrations/0025_documents.sql", "utf8"));
  return DB;
}

/** An in-memory R2 bucket with put/get. */
function r2() {
  const objects = new Map<string, { data: Uint8Array; contentType?: string }>();
  return {
    objects,
    bucket: {
      async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
        objects.set(key, { data: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
        return {};
      },
      async get(key: string) {
        const o = objects.get(key);
        return o ? { body: o.data, httpMetadata: { contentType: o.contentType } } : null;
      },
    } as unknown as R2Bucket,
  };
}

function setup() {
  const storage = r2();
  const old = r2();
  const env = { DB: d1(), R2_BUCKET: old.bucket, R2_PRIVATE: storage.bucket } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/journal", journalRoute);
  const send = (path: string, method = "GET", body?: unknown) =>
    root.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  return { env, root, send, storage, old };
}

type Entry = {
  id: string; version: number; body: string; happened_at: string; mood: string | null;
  state_of_mind: { valence: number; labels: string[]; kind: string; hk_uuid?: string | null } | null;
  attachments: Array<{ kind: string; ref: string; title?: string | null }>;
  source: string; external_id: string | null; prompt: string | null; words: number;
};

describe("journal helpers", () => {
  it("maps valence to the five weather words", () => {
    expect([1, 0.6, 0.3, 0, -0.3, -0.6, -1].map(moodFor)).toEqual(["great", "great", "good", "okay", "low", "rough", "rough"]);
  });

  it("counts words, not spaces", () => {
    expect(countWords("  A cold run,\n\nthen coffee — it's fine. ")).toBe(7);
    expect(countWords("")).toBe(0);
  });

  it("puts instants on local days", () => {
    expect(dayIn("America/New_York")("2026-11-25T03:00:00Z")).toBe("2026-11-24");
    expect(dayIn(undefined, "-300")("2026-11-25T03:00:00Z")).toBe("2026-11-24");
    expect(dayIn("Not/AZone")("2026-11-25T03:00:00Z")).toBe("2026-11-25");
  });

  it("forgives today, counts weeks, remembers the longest run", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-20", "2026-11-22", "2026-11-23"];
    // Today (the 24th) isn't written yet: the streak still stands at 2.
    expect(streakOf(days, "2026-11-24")).toEqual({ days: 2, weeks: 2, longest_days: 4, today: false });
    expect(streakOf([...days, "2026-11-24"], "2026-11-24")).toMatchObject({ days: 3, today: true });
    // Two days missed: the daily streak is over, the weekly one isn't.
    expect(streakOf(days, "2026-11-25")).toMatchObject({ days: 0, weeks: 2 });
    expect(streakOf([], "2026-11-24")).toEqual({ days: 0, weeks: 0, longest_days: 0, today: false });
  });
});

describe("/v1/journal", () => {
  it("keeps State of Mind alongside the old mood word, both ways", async () => {
    const { send } = setup();
    // New client: a State of Mind; the mood word follows.
    const a = await (await send("/v1/journal", "POST", {
      body: "Calm morning.", happened_at: "2026-11-24T08:00:00-05:00",
      state_of_mind: { valence: 0.7, labels: ["calm", "grateful"], kind: "momentary", hk_uuid: "HK-1" },
    })).json() as Entry;
    expect(a).toMatchObject({ mood: "great", state_of_mind: { valence: 0.7, labels: ["calm", "grateful"], hk_uuid: "HK-1" }, source: "native", attachments: [], words: 2 });

    // Old client: only the word; it reads back with a State of Mind placed on the line.
    const b = await (await send("/v1/journal", "POST", { body: "Tired.", mood: "low" })).json() as Entry;
    expect(b.state_of_mind).toMatchObject({ valence: -0.4, labels: [], kind: "momentary" });

    // Old client re-saves with the same word: the labels survive.
    const same = await (await send(`/v1/journal/${a.id}`, "PATCH", { version: a.version, body: "Calm morning!", mood: "great" })).json() as Entry;
    expect(same.state_of_mind).toMatchObject({ valence: 0.7, labels: ["calm", "grateful"], hk_uuid: "HK-1" });
    // A different word replaces it but keeps the Health sample id, so the app can rewrite it.
    const changed = await (await send(`/v1/journal/${a.id}`, "PATCH", { version: same.version, mood: "rough" })).json() as Entry;
    expect(changed).toMatchObject({ mood: "rough", state_of_mind: { valence: -0.8, labels: [], hk_uuid: "HK-1" }, body: "Calm morning!" });
    // Clearing.
    const cleared = await (await send(`/v1/journal/${a.id}`, "PATCH", { version: changed.version, state_of_mind: null })).json() as Entry;
    expect(cleared).toMatchObject({ mood: null, state_of_mind: null });

    const bad = await send("/v1/journal", "POST", { body: "x", state_of_mind: { valence: 2 } });
    expect(bad.status).toBe(400);
  });

  it("keeps attachments, the prompt and where an entry came from; imports don't double", async () => {
    const { send } = setup();
    const entry = {
      body: "Lifted, then the river.", happened_at: "2026-11-23T18:00:00Z",
      attachments: [
        { kind: "workout", ref: "2026-11-23", title: "Upper A", meta: { sets: 18 } },
        { kind: "song", ref: "spotify:track:1", title: "Holocene", meta: { artist: "Bon Iver" } },
      ],
      prompt: "What made today good?", source: "apple_import", external_id: "Entries/2026-11-23.html",
    };
    const first = await send("/v1/journal", "POST", entry);
    expect(first.status).toBe(201);
    const created = await first.json() as Entry;
    expect(created).toMatchObject({ source: "apple_import", external_id: "Entries/2026-11-23.html", prompt: "What made today good?" });
    expect(created.attachments.map((a) => a.kind)).toEqual(["workout", "song"]);

    const again = await send("/v1/journal", "POST", entry);
    expect(again.status).toBe(200);
    expect((await again.json() as Entry).id).toBe(created.id);

    // Editing the body leaves attachments, source and the import id alone.
    const edited = await (await send(`/v1/journal/${created.id}`, "PATCH", { version: created.version, body: "Lifted. River after." })).json() as Entry;
    expect(edited).toMatchObject({ source: "apple_import", external_id: "Entries/2026-11-23.html" });
    expect(edited.attachments).toHaveLength(2);
    const fetched = await (await send(`/v1/journal/${created.id}`)).json() as Entry;
    expect(fetched.body).toBe("Lifted. River after.");

    const badPhoto = await send("/v1/journal", "POST", { body: "x", attachments: [{ kind: "photo", ref: "blog/x.jpg" }] });
    expect(badPhoto.status).toBe(400);
  });

  it("stores photos privately and serves them back", async () => {
    const { root, env, send, storage } = setup();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const up = await root.request("/v1/journal/photos", { method: "POST", body: bytes, headers: { "Content-Type": "image/jpeg" } }, env);
    expect(up.status).toBe(201);
    const { ref } = await up.json() as { ref: string };
    expect(ref).toMatch(/^journal\/.+\.jpg$/);
    expect(storage.objects.has(ref)).toBe(true);

    const entry = await (await send("/v1/journal", "POST", { body: "The view.", attachments: [{ kind: "photo", ref }] })).json() as Entry;
    expect(entry.attachments[0].ref).toBe(ref);

    const back = await root.request(`/v1/${ref}`.replace("/v1/journal/", "/v1/journal/photos/"), {}, env);
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);

    expect((await root.request("/v1/journal/photos/..%2Fsecret.jpg", {}, env)).status).toBe(404);
    const text = await root.request("/v1/journal/photos", { method: "POST", body: "hi", headers: { "Content-Type": "text/plain" } }, env);
    expect(text.status).toBe(415);
    // The bodies the app reads: 415 keeps code "invalid" (not "unsupported").
    expect(await text.json()).toEqual({ error: { code: "invalid", message: "Send a JPEG, PNG, HEIC or WebP image" } });
    const empty = await root.request("/v1/journal/photos", { method: "POST", body: new Uint8Array(0), headers: { "Content-Type": "image/png" } }, env);
    expect([empty.status, await empty.json()]).toEqual([400, { error: { code: "invalid", message: "The image is empty" } }]);
    const big = await root.request("/v1/journal/photos", { method: "POST", body: "x", headers: { "Content-Type": "image/png", "Content-Length": String(16 * 1024 * 1024) } }, env);
    expect([big.status, await big.json()]).toEqual([413, { error: { code: "too_large", message: "Photos can be up to 15 MB" } }]);
    const missing = await root.request("/v1/journal/photos/01HZZZZZZZZZZZZZZZZZZZZZZZ-none.jpg", {}, env);
    expect([missing.status, await missing.json()]).toEqual([404, { error: { code: "not_found", message: "No such photo" } }]);
  });

  it("still serves photos saved in the public bucket before the private one", async () => {
    const { root, env, old, storage } = setup();
    const ref = "journal/01HZZZZZZZZZZZZZZZZZZZZZZZ-older.jpg";
    await old.bucket.put(ref, new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
    const back = await root.request(`/v1/journal/photos/${ref.slice(8)}`, {}, env);
    expect(back.status).toBe(200);
    expect(storage.objects.size).toBe(0);
  });

  it("answers per-day stats with a forgiving streak, in your time zone", async () => {
    const { send } = setup();
    // 23:30 in New York on the 21st is the 22nd in UTC.
    for (const at of ["2026-11-21T23:30:00-05:00", "2026-11-22T09:00:00-05:00", "2026-11-22T21:00:00-05:00", "2026-11-23T07:00:00-05:00"]) {
      await send("/v1/journal", "POST", { body: "one two three", happened_at: at });
    }
    await send("/v1/journal", "POST", { body: "Last year.", happened_at: "2025-06-01T12:00:00Z" });
    const stats = await (await send("/v1/journal/stats?tz=America/New_York&today=2026-11-24")).json() as {
      from: string; to: string; days: Array<{ day: string; entries: number; words: number }>;
      totals: { entries: number; words: number; days: number }; all_time: { entries: number; first_day: string };
      streak: { days: number; weeks: number; today: boolean };
    };
    expect(stats.from).toBe("2025-11-25");
    expect(stats.days).toEqual([
      { day: "2026-11-21", entries: 1, words: 3 },
      { day: "2026-11-22", entries: 2, words: 6 },
      { day: "2026-11-23", entries: 1, words: 3 },
    ]);
    expect(stats.totals).toEqual({ entries: 4, words: 12, days: 3 });
    expect(stats.all_time).toMatchObject({ entries: 5, first_day: "2025-06-01" });
    expect(stats.streak).toMatchObject({ days: 3, today: false });

    // The same instants in UTC fall on other days.
    const utc = await (await send("/v1/journal/stats?today=2026-11-24")).json() as typeof stats;
    expect(utc.days.map((d) => d.day)).toEqual(["2026-11-22", "2026-11-23"]);
  });

  it("finds entries on this day in earlier years, and by their words", async () => {
    const { send } = setup();
    await send("/v1/journal", "POST", { body: "First snow in Boston.", happened_at: "2024-11-24T15:00:00Z", place: { name: "Boston" } });
    await send("/v1/journal", "POST", { body: "Thanksgiving prep.", happened_at: "2025-11-24T22:00:00-05:00" });
    await send("/v1/journal", "POST", { body: "Not this day.", happened_at: "2025-11-25T15:00:00Z" });
    await send("/v1/journal", "POST", { body: "Today itself.", happened_at: "2026-11-24T15:00:00Z" });
    const otd = await (await send("/v1/journal/on-this-day?date=2026-11-24&tz=America/New_York")).json() as { items: Array<Entry & { years_ago: number }> };
    expect(otd.items.map((i) => [i.body, i.years_ago])).toEqual([["Thanksgiving prep.", 1], ["First snow in Boston.", 2]]);

    const found = await (await send("/v1/journal?q=snow%20boston")).json() as { items: Entry[] };
    expect(found.items.map((i) => i.body)).toEqual(["First snow in Boston."]);
    const byPlace = await (await send("/v1/journal?q=Boston")).json() as { items: Entry[] };
    expect(byPlace.items).toHaveLength(1);
    const literal = await (await send("/v1/journal?q=100%25")).json() as { items: Entry[] };
    expect(literal.items).toHaveLength(0);
  });
});
