import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { testD1 } from "../helpers/d1";
import type { Env } from "../../types/env";
import watchRoute from "../../routes/watch";
import shelfRoute from "../../routes/shelf";

// TMDB as the tracker sees it: one film and one ended two-season show.
const TMDB: Record<string, unknown> = {
  "/3/movie/550": { id: 550, title: "Fight Club", release_date: "1999-10-15", runtime: 139, genres: [{ name: "Drama" }], poster_path: "/fc.jpg", status: "Released", imdb_id: "tt0137523" },
  "/3/tv/1396": {
    id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", episode_run_time: [47], genres: [{ name: "Drama" }, { name: "Crime" }],
    poster_path: "/bb.jpg", status: "Ended", external_ids: { tvdb_id: 81189 },
    seasons: [{ season_number: 0, episode_count: 4 }, { season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 2 }],
  },
  "/3/tv/1396/season/1": { episodes: [1, 2, 3].map((n) => ({ season_number: 1, episode_number: n, name: `One ${n}`, air_date: "2008-01-20", runtime: 50 })) },
  "/3/tv/1396/season/2": { episodes: [1, 2].map((n) => ({ season_number: 2, episode_number: n, name: `Two ${n}`, air_date: "2009-03-08", runtime: 45 })) },
  "/3/find/81189": { tv_results: [{ id: 1396 }], movie_results: [] },
};

function setup() {
  const { db, DB } = testD1({ migrations: "all" });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const found = TMDB[url.pathname];
    return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response("{}", { status: 404 });
  }));
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/watch", watchRoute);
  root.route("/v1/shelf", shelfRoute);
  const env = { DB, TMDB_ACCESS_TOKEN: "t" } as Env;
  const call = (path: string, init?: RequestInit) => root.request(path, init, env);
  const send = (method: string, path: string, payload?: unknown) =>
    call(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
  return { db, call, send };
}

type Json = Record<string, any>;
const read = async (res: Response) => (await res.json()) as Json;
/** A row from the test database. */
const row = (db: ReturnType<typeof setup>["db"], sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as Json;
const rows = (db: ReturnType<typeof setup>["db"], sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Json[];

afterEach(() => vi.unstubAllGlobals());

describe("watch: adding titles", () => {
  it("adds a TMDB film hidden by default, and finds it the second time", async () => {
    const { send, db } = setup();
    const first = await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 });
    expect(first.status).toBe(201);
    const item = await read(first);
    expect(item).toMatchObject({ type: "movie", title: "Fight Club", year: "1999", runtime: 139, genres: ["Drama"], published: false, created: true });
    expect(item.poster_url).toBe("https://image.tmdb.org/t/p/w500/fc.jpg");
    const again = await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 });
    expect(again.status).toBe(200);
    expect((await read(again)).id).toBe(item.id);
    expect(row(db, "SELECT COUNT(*) AS n FROM shelf_items").n).toBe(1);
  });

  it("finds a show from its TheTVDB id (what TV Time used)", async () => {
    const { send } = setup();
    const res = await send("POST", "/v1/watch/titles", { tvdb_id: 81189, status: "watching", published: true });
    expect(res.status).toBe(201);
    expect(await read(res)).toMatchObject({ type: "show", title: "Breaking Bad", status: "watching", published: true });
  });

  it("links shelf items already tagged with a TMDB id", async () => {
    const { db, call } = setup();
    db.exec(`INSERT INTO shelf_items (type, title, tags_json, published) VALUES ('movie', 'Fight Club', '["tmdb_id:550","status:watched","runtime_seconds:8340"]', 1)`);
    const list = await read(await call("/v1/watch/library"));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: "watched", runtime: 139 });
    // Linked on first sight of its page; the library then has TMDB's details.
    const page = await read(await call(`/v1/watch/titles/${list.items[0].id}`));
    expect(page.tmdb).toMatchObject({ media_type: "movie", id: 550 });
  });
});

describe("watch: films", () => {
  it("logs viewings; the second is a rewatch and the first is kept", async () => {
    const { send, db } = setup();
    const { id } = await read(await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 }));
    expect((await send("POST", `/v1/watch/films/${id}/watched`, { watched_at: "2024-05-01", rating: 4.5 })).status).toBe(201);
    const second = await read(await send("POST", `/v1/watch/films/${id}/watched`, { watched_at: "2025-02-02T21:00:00Z" }));
    expect(second.item.views).toBe(2);
    expect(second.item.watches.map((w: Json) => w.run)).toEqual([0, 1]);
    const saved = row(db, "SELECT status, rating, rating_scale, completed_at, last_watched_at FROM shelf_items WHERE id = ?", id);
    expect(saved).toMatchObject({ status: "watched", rating: 4.5, rating_scale: 5, completed_at: "2024-05-01T12:00:00.000Z", last_watched_at: "2025-02-02T21:00:00.000Z" });
    const diary = rows(db, "SELECT kind, rewatch, rating FROM shelf_log WHERE item_id = ? ORDER BY id", id);
    expect(diary).toEqual([{ kind: "finished", rewatch: 0, rating: 4.5 }, { kind: "finished", rewatch: 1, rating: null }]);
  });

  it("refuses a rating off the half-star scale and an import key twice", async () => {
    const { send } = setup();
    const { id } = await read(await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 }));
    expect((await send("POST", `/v1/watch/films/${id}/watched`, { rating: 4.3 })).status).toBe(400);
    const keyed = { watched_at: "2022-01-01", source: "tvtime", source_key: "tvtime:movie:x", update_item: false };
    expect((await send("POST", `/v1/watch/films/${id}/watched`, keyed)).status).toBe(201);
    const again = await read(await send("POST", `/v1/watch/films/${id}/watched`, keyed));
    expect(again.added).toBe(0);
    expect(again.item.views).toBe(1);
  });
});

describe("watch: shows", () => {
  async function show(send: ReturnType<typeof setup>["send"]) {
    return (await read(await send("POST", "/v1/watch/titles", { media_type: "tv", tmdb_id: 1396, published: true }))).id as number;
  }

  it("marks everything up to an episode, says what's next, and never doubles", async () => {
    const { send, call, db } = setup();
    const id = await show(send);
    const marked = await read(await send("POST", `/v1/watch/titles/${id}/episodes`, { up_to: { season: 1, episode: 3 }, watched_at: "2024-01-01" }));
    expect(marked.added).toBe(3);
    expect(marked.item.progress).toMatchObject({ watched: 3, total: 5, aired: 5, season: 1, episode: 3, next: { season_number: 2, episode_number: 1, aired: true } });
    expect(marked.item.episodes).toHaveLength(5);
    const repeat = await read(await send("POST", `/v1/watch/titles/${id}/episodes`, { up_to: { season: 1, episode: 3 } }));
    expect(repeat.added).toBe(0);
    expect(row(db, "SELECT status, progress_current, progress_total FROM shelf_items WHERE id = ?", id))
      .toEqual({ status: "watching", progress_current: 3, progress_total: 5 });
    const next = await read(await call("/v1/watch/up-next"));
    expect(next.items[0].episode).toMatchObject({ season: 2, episode: 1, name: "Two 1", left: 2 });
  });

  it("finishes an ended show when the last episode is watched, and writes the diary's milestones", async () => {
    const { send, db } = setup();
    const id = await show(send);
    await send("POST", `/v1/watch/titles/${id}/episodes`, { episodes: [{ season: 1, episode: 1, watched_at: "2024-01-01" }] });
    const done = await read(await send("POST", `/v1/watch/titles/${id}/episodes`, { up_to: { season: 2, episode: 2 }, watched_at: "2024-02-01" }));
    expect(done.item.status).toBe("completed");
    expect(done.item.progress.next).toBeNull();
    expect(rows(db, "SELECT kind FROM shelf_log WHERE item_id = ? ORDER BY id", id).map((r: Json) => r.kind)).toEqual(["started", "finished"]);
  });

  it("imports old viewings without moving the shelf item, once", async () => {
    const { send, db } = setup();
    const id = await show(send);
    const payload = {
      source: "tvtime", update_item: false,
      episodes: [{ season: 1, episode: 1, watched_at: "2018-03-04 20:01:02", source_key: "tvtime:ep:a" }, { season: 1, episode: 2, watched_at: "2018-03-05 20:01:02", source_key: "tvtime:ep:b" }],
    };
    expect((await read(await send("POST", `/v1/watch/titles/${id}/episodes`, payload))).added).toBe(2);
    expect((await read(await send("POST", `/v1/watch/titles/${id}/episodes`, payload))).added).toBe(0);
    expect(row(db, "SELECT status, progress_current FROM shelf_items WHERE id = ?", id)).toEqual({ status: null, progress_current: null });
    expect(row(db, "SELECT COUNT(*) AS n FROM shelf_log").n).toBe(0);
    expect(row(db, "SELECT watched_at FROM media_watches ORDER BY id LIMIT 1").watched_at).toBe("2018-03-04T20:01:02.000Z");
  });

  it("a rewatch starts a new run and keeps the first", async () => {
    const { send } = setup();
    const id = await show(send);
    await send("POST", `/v1/watch/titles/${id}/episodes`, { up_to: { season: 2, episode: 2 }, watched_at: "2020-01-01" });
    const again = await read(await send("POST", `/v1/watch/titles/${id}/episodes`, { episodes: [{ season: 1, episode: 1 }], rewatch: true }));
    expect(again.item.progress).toMatchObject({ run: 1, watched: 1, next: { season_number: 1, episode_number: 2 } });
    expect(again.item.watches).toHaveLength(6);
  });

  it("takes a viewing back", async () => {
    const { send, call } = setup();
    const id = await show(send);
    const marked = await read(await send("POST", `/v1/watch/titles/${id}/episodes`, { up_to: { season: 1, episode: 2 } }));
    const last = marked.item.watches[1].id;
    const res = await call(`/v1/watch/titles/${id}/watches?ids=${last}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await read(res)).item.progress).toMatchObject({ watched: 1, next: { season_number: 1, episode_number: 2 } });
    expect((await call(`/v1/watch/titles/${id}/watches?ids=abc`, { method: "DELETE" })).status).toBe(400);
  });

  it("won't log a show as a film or a film by episode", async () => {
    const { send } = setup();
    const id = await show(send);
    expect((await send("POST", `/v1/watch/films/${id}/watched`, {})).status).toBe(400);
    const film = (await read(await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 }))).id;
    expect((await send("POST", `/v1/watch/titles/${film}/episodes`, { up_to: { season: 1, episode: 1 } })).status).toBe(400);
  });
});

describe("watch: stats and picks", () => {
  it("counts a year's films, episodes and minutes", async () => {
    const { send, call } = setup();
    const film = (await read(await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 }))).id;
    const show = (await read(await send("POST", "/v1/watch/titles", { media_type: "tv", tmdb_id: 1396 }))).id;
    await send("GET", `/v1/watch/titles/${show}`);
    await send("POST", `/v1/watch/films/${film}/watched`, { watched_at: "2024-03-01" });
    await send("POST", `/v1/watch/titles/${show}/episodes`, { up_to: { season: 1, episode: 2 }, watched_at: "2024-03-02" });
    await send("POST", `/v1/watch/films/${film}/watched`, { watched_at: "2023-03-01" });
    const year = await read(await call("/v1/watch/stats?year=2024"));
    expect(year).toMatchObject({ films: 1, episodes: 2, titles: 2, minutes: 139 + 50 + 50 });
    expect(year.months[2]).toMatchObject({ month: 3, films: 1, episodes: 2 });
    expect(year.genres[0]).toEqual({ name: "Drama", count: 2 });
    expect((await read(await call("/v1/watch/stats"))).films).toBe(2);
  });

  it("records what the picker landed on", async () => {
    const { send, call } = setup();
    const film = (await read(await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 }))).id;
    expect((await send("POST", "/v1/watch/picks", { item_id: film, outcome: "not_tonight" })).status).toBe(201);
    expect((await send("POST", "/v1/watch/picks", { item_id: film, outcome: "maybe" })).status).toBe(400);
    expect((await read(await call("/v1/watch/picks"))).items[0]).toMatchObject({ item_id: film, outcome: "not_tonight" });
    await send("POST", "/v1/watch/picks", { item_id: film, outcome: "picked" });
    const passes = await read(await call("/v1/watch/picks?outcome=not_tonight&days=14"));
    expect(passes.items.map((p: Json) => p.outcome)).toEqual(["not_tonight"]);
    expect((await call("/v1/watch/picks?days=999")).status).toBe(400);
  });

  it("leaves the website's shelf reply alone (published only, same fields)", async () => {
    const { send, call } = setup();
    await send("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: 550 });
    await send("POST", "/v1/watch/titles", { media_type: "tv", tmdb_id: 1396, published: true });
    const shelf = (await read(await call("/v1/shelf"))) as unknown as Json[];
    expect(shelf.map((item) => item.title)).toEqual(["Breaking Bad"]);
    expect(Object.keys(shelf[0])).not.toContain("tmdb_id");
  });
});
