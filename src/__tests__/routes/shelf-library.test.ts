// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { testD1 } from "../helpers/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import shelfRoute from "../../routes/shelf";
import mediaRoute from "../../routes/media";

/** shelf_items exactly as the live migrations build it, plus 0033's diary. */
function d1(): D1Database {
  const { db, DB } = testD1();
  db.exec(`CREATE TABLE shelf_items (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT, quote TEXT,
    author TEXT, source TEXT, url TEXT, note TEXT, image_url TEXT, drawer TEXT, tags_json TEXT, date_added TEXT);`);
  db.exec("ALTER TABLE shelf_items ADD COLUMN created_at TEXT; ALTER TABLE shelf_items ADD COLUMN updated_at TEXT;");
  db.exec("ALTER TABLE shelf_items ADD COLUMN published INTEGER NOT NULL DEFAULT 1;");
  db.exec(readFileSync("migrations/0015_add_shelf_state_fields.sql", "utf8"));
  db.exec(readFileSync("migrations/0017_add_shelf_control_fields.sql", "utf8"));
  db.exec(readFileSync("migrations/0033_shelf_log.sql", "utf8"));
  return DB;
}

function setup() {
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/shelf", shelfRoute);
  root.route("/v1/media", mediaRoute);
  const env = { DB: d1(), TMDB_ACCESS_TOKEN: "tmdb-token" } as Env;
  const call = (path: string, init?: RequestInit) => root.request(path, init, env);
  const send = (method: string, path: string, body: unknown) =>
    call(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return { call, send, env };
}

type Item = Record<string, unknown>;

async function seed(send: ReturnType<typeof setup>["send"]) {
  const items = [
    { type: "book", title: "Piranesi", author: "Susanna Clarke", status: "reading", progress_current: 40, progress_total: 272, progress_unit: "page" },
    { type: "movie", title: "Past Lives", status: "watched", rating: 4.5, rating_scale: 5 },
    { type: "show", title: "Severance", status: "watching", progress_total: 19, progress_unit: "episode", metadata: { tmdb_id: "95396" } },
    { type: "quote", quote: "Be kind." },
    { type: "book", title: "Private draft", published: false },
    { type: "anime", title: "Frieren", status: "watching", progress_total: 28, progress_unit: "episode", metadata: { anilist_id: "154587" } },
  ];
  for (const item of items) {
    const res = await send("POST", "/v1/shelf", item);
    expect(res.status).toBe(201);
  }
}

const titles = (list: Item[]) => list.map((item) => item.title ?? item.quote).sort();

describe("shelf: what the website sees stays the same", () => {
  it("lists every type but anime when no type is given, and only published items", async () => {
    const { call, send } = setup();
    await seed(send);
    const list = (await (await call("/v1/shelf?limit=1000&offset=0")).json()) as Item[];
    expect(titles(list)).toEqual(["Be kind.", "Past Lives", "Piranesi", "Severance"]);
    expect(list.some((item) => item.type === "anime")).toBe(false);
  });

  it("filters one type exactly as before", async () => {
    const { call, send } = setup();
    await seed(send);
    const books = (await (await call("/v1/shelf?limit=1000&offset=0&type=book")).json()) as Item[];
    expect(titles(books)).toEqual(["Piranesi"]);
    const shows = (await (await call("/v1/shelf?type=show")).json()) as Item[];
    expect(titles(shows)).toEqual(["Severance"]);
  });

  it("keeps the item shape: no new fields on shelf items", async () => {
    const { call, send } = setup();
    await seed(send);
    const [book] = (await (await call("/v1/shelf?type=book")).json()) as Item[];
    expect(Object.keys(book).sort()).toEqual([
      "apple_books_id", "author", "completed_at", "cover_override_url", "created_at", "date_added", "display_order",
      "drawer", "favorite_rank", "goodreads_id", "id", "image_url", "isbn", "last_watched_at", "metadata", "note",
      "progress_current", "progress_total", "progress_unit", "published", "quote", "rating", "rating_scale",
      "shelf_group", "showcase", "source", "spine_image_url", "started_at", "status", "tags", "title", "type",
      "updated_at", "url",
    ]);
  });

  it("returns anime only when asked: type=anime, a list naming it, or type=all", async () => {
    const { call, send } = setup();
    await seed(send);
    const anime = (await (await call("/v1/shelf?type=anime")).json()) as Item[];
    expect(titles(anime)).toEqual(["Frieren"]);
    const screen = (await (await call("/v1/shelf?type=movie,show,anime")).json()) as Item[];
    expect(titles(screen)).toEqual(["Frieren", "Past Lives", "Severance"]);
    const all = (await (await call("/v1/shelf?type=all&include_unpublished=1")).json()) as Item[];
    expect(all).toHaveLength(6);
  });
});

describe("shelf: create", () => {
  it("returns the new id so the apps can log it at once", async () => {
    const { send } = setup();
    const body = (await (await send("POST", "/v1/shelf", { type: "movie", title: "Perfect Days" })).json()) as Item;
    expect(body).toMatchObject({ ok: true, id: 1 });
  });
});

describe("shelf: patch", () => {
  it("clears a rating, a date or a note with null", async () => {
    const { call, send } = setup();
    await seed(send);
    const [movie] = (await (await call("/v1/shelf?type=movie")).json()) as Item[];
    await send("PATCH", `/v1/shelf/${movie.id}`, { completed_at: "2026-11-01", note: "Twice." });
    const res = await send("PATCH", `/v1/shelf/${movie.id}`, { rating: null, completed_at: null, note: null });
    expect(res.status).toBe(200);
    const item = (await (await call(`/v1/shelf/${movie.id}`)).json()) as Item;
    expect(item).toMatchObject({ rating: null, completed_at: null, note: null, status: "watched", title: "Past Lives" });
    expect((await send("PATCH", `/v1/shelf/${movie.id}`, { type: null })).status).toBe(400);
  });
});

describe("shelf: anime statuses", () => {
  it("accepts the show statuses for anime and nothing else", async () => {
    const { send } = setup();
    for (const status of ["want_to_watch", "watching", "completed", "paused", "dropped"]) {
      expect((await send("POST", "/v1/shelf", { type: "anime", title: "A", status })).status).toBe(201);
    }
    expect((await send("POST", "/v1/shelf", { type: "anime", title: "A", status: "reading" })).status).toBe(400);
    expect((await send("POST", "/v1/shelf", { type: "anime", title: "A", status: "watched" })).status).toBe(400);
  });

  it("checks a PATCH against the anime statuses", async () => {
    const { call, send } = setup();
    await seed(send);
    const [frieren] = (await (await call("/v1/shelf?type=anime")).json()) as Item[];
    expect((await send("PATCH", `/v1/shelf/${frieren.id}`, { status: "dnf" })).status).toBe(400);
    expect((await send("PATCH", `/v1/shelf/${frieren.id}`, { status: "paused" })).status).toBe(200);
  });
});

describe("shelf: logging and the diary", () => {
  it("finishing a book completes it, fills the pages and writes the diary", async () => {
    const { call, send } = setup();
    await seed(send);
    const [book] = (await (await call("/v1/shelf?type=book")).json()) as Item[];
    const res = await send("POST", `/v1/shelf/${book.id}/log`, { kind: "finished", logged_at: "2026-11-20", rating: 4.5, note: "Lovely." });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: Item; status: string; log_id: number };
    expect(body.status).toBe("completed");
    expect(body.log_id).toBeGreaterThan(0);
    expect(body.item).toMatchObject({ status: "completed", completed_at: "2026-11-20", progress_current: 272, rating: 4.5, rating_scale: 5 });
    // The item's own note is left alone; the diary keeps the line.
    expect(body.item.note).toBeNull();
    const diary = (await (await call("/v1/shelf/diary")).json()) as { items: Item[] };
    expect(diary.items).toHaveLength(1);
    expect(diary.items[0]).toMatchObject({ kind: "finished", title: "Piranesi", type: "book", note: "Lovely.", rewatch: false });
  });

  it("an episode moves a show along and keeps the season and episode with its other metadata", async () => {
    const { call, send } = setup();
    await seed(send);
    const [show] = (await (await call("/v1/shelf?type=show")).json()) as Item[];
    const res = await send("POST", `/v1/shelf/${show.id}/log`, { kind: "progress", season: 2, episode: 3, progress_current: 12, logged_at: "2026-11-21T21:00:00Z" });
    const body = (await res.json()) as { item: Item };
    expect(body.item).toMatchObject({ status: "watching", progress_current: 12, last_watched_at: "2026-11-21T21:00:00Z", started_at: "2026-11-21T21:00:00Z" });
    expect(body.item.metadata).toMatchObject({ tmdb_id: "95396", progress: { season: 2, episode: 3 } });
  });

  it("a want-to-watch anime starts when you log its first episode", async () => {
    const { call, send } = setup();
    await send("POST", "/v1/shelf", { type: "anime", title: "Mushishi", status: "want_to_watch", published: false });
    const [anime] = (await (await call("/v1/shelf?type=anime&include_unpublished=1")).json()) as Item[];
    const body = (await (await send("POST", `/v1/shelf/${anime.id}/log`, { kind: "progress", episode: 1, progress_current: 1 })).json()) as { item: Item };
    expect(body.item.status).toBe("watching");
  });

  it("refuses statuses a type doesn't have, and things that aren't media", async () => {
    const { call, send } = setup();
    await seed(send);
    const [movie] = (await (await call("/v1/shelf?type=movie")).json()) as Item[];
    expect((await send("POST", `/v1/shelf/${movie.id}/log`, { kind: "rated", status: "paused" })).status).toBe(400);
    // Movies have no paused state: the log is kept, the status is left alone.
    const paused = (await (await send("POST", `/v1/shelf/${movie.id}/log`, { kind: "paused" })).json()) as { item: Item };
    expect(paused.item.status).toBe("watched");
    const [quote] = ((await (await call("/v1/shelf")).json()) as Item[]).filter((item) => item.type === "quote");
    expect((await send("POST", `/v1/shelf/${quote.id}/log`, { kind: "finished" })).status).toBe(400);
    expect((await send("POST", "/v1/shelf/9999/log", { kind: "finished" })).status).toBe(404);
  });

  it("rewatches keep the first start and mark the diary", async () => {
    const { call, send } = setup();
    await seed(send);
    const [movie] = (await (await call("/v1/shelf?type=movie")).json()) as Item[];
    await send("POST", `/v1/shelf/${movie.id}/log`, { kind: "finished", logged_at: "2025-01-02" });
    await send("POST", `/v1/shelf/${movie.id}/log`, { kind: "finished", logged_at: "2026-11-01", rewatch: true });
    const item = (await (await call(`/v1/shelf/${movie.id}`)).json()) as Item;
    expect(item).toMatchObject({ started_at: "2025-01-02", completed_at: "2026-11-01", last_watched_at: "2026-11-01" });
    const diary = (await (await call(`/v1/shelf/diary?item_id=${movie.id}`)).json()) as { items: Item[] };
    expect(diary.items.map((entry) => [entry.logged_at, entry.rewatch])).toEqual([["2026-11-01", true], ["2025-01-02", false]]);
  });

  it("filters the diary by type and date, fixes and deletes entries, and drops them with their item", async () => {
    const { call, send } = setup();
    await seed(send);
    const all = (await (await call("/v1/shelf?type=all")).json()) as Item[];
    const byTitle = Object.fromEntries(all.map((item) => [item.title, item.id]));
    await send("POST", `/v1/shelf/${byTitle.Piranesi}/log`, { kind: "progress", progress_current: 100, logged_at: "2026-10-01" });
    await send("POST", `/v1/shelf/${byTitle.Frieren}/log`, { kind: "progress", episode: 5, logged_at: "2026-11-05" });
    await send("POST", `/v1/shelf/${byTitle["Past Lives"]}/log`, { kind: "finished", logged_at: "2026-11-10" });

    const anime = (await (await call("/v1/shelf/diary?type=anime")).json()) as { items: Item[] };
    expect(anime.items.map((entry) => entry.title)).toEqual(["Frieren"]);
    const november = (await (await call("/v1/shelf/diary?start=2026-11-01&end=2026-11-30")).json()) as { items: Item[] };
    expect(november.items.map((entry) => entry.title)).toEqual(["Past Lives", "Frieren"]);

    const entry = november.items[0];
    expect((await send("PATCH", `/v1/shelf/log/${entry.id}`, { note: "Again soon.", logged_at: "2026-11-11" })).status).toBe(200);
    const fixed = (await (await call(`/v1/shelf/diary?item_id=${byTitle["Past Lives"]}`)).json()) as { items: Item[] };
    expect(fixed.items[0]).toMatchObject({ note: "Again soon.", logged_at: "2026-11-11" });
    expect((await send("PATCH", `/v1/shelf/log/${entry.id}`, {})).status).toBe(400);

    expect((await call(`/v1/shelf/log/${entry.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/v1/shelf/log/${entry.id}`, { method: "DELETE" })).status).toBe(404);

    expect((await call(`/v1/shelf/${byTitle.Frieren}`, { method: "DELETE" })).status).toBe(200);
    const rest = (await (await call("/v1/shelf/diary")).json()) as { items: Item[] };
    expect(rest.items.map((entry) => entry.title)).toEqual(["Piranesi"]);
  });
});

describe("media: show seasons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns regular seasons with episode counts and what airs next", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 95396,
      name: "Severance",
      status: "Returning Series",
      number_of_seasons: 2,
      number_of_episodes: 19,
      poster_path: "/sev.jpg",
      seasons: [
        { season_number: 0, episode_count: 3, name: "Specials" },
        { season_number: 2, episode_count: 10, name: "Season 2" },
        { season_number: 1, episode_count: 9, name: "Season 1", air_date: "2022-02-18" },
      ],
      next_episode_to_air: { season_number: 3, episode_number: 1, air_date: "2027-01-01" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const { call } = setup();
    const res = await call("/v1/media/tv/95396");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tmdb_id: 95396,
      number_of_episodes: 19,
      seasons: [{ season_number: 1, episode_count: 9 }, { season_number: 2, episode_count: 10 }],
      next_episode_to_air: { season_number: 3, episode_number: 1 },
      poster_url: "https://image.tmdb.org/t/p/w500/sev.jpg",
    });
    expect((await call("/v1/media/tv/abc")).status).toBe(400);
  });
});
