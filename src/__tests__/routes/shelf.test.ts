import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import shelfRoute from "../../routes/shelf";

type UpdateCall = { sql: string; bindings: unknown[] };

function createShelfDb(row: Record<string, unknown>) {
  const updates: UpdateCall[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          if (sql.startsWith("SELECT")) {
            return {
              all: vi.fn().mockResolvedValue({ results: [row] }),
            };
          }
          return {
            run: vi.fn().mockImplementation(() => {
              updates.push({ sql, bindings });
              return Promise.resolve({ meta: { changes: 1 } });
            }),
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, updates };
}

function envFor(db: D1Database): Env {
  return {
    DB: db,
    TMDB_ACCESS_TOKEN: "tmdb-token",
  } as Env;
}

function mockTmdbSearch(status = 200, body: unknown = tmdbSearchBody()) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        statusText: status === 200 ? "OK" : "Bad Gateway",
        headers: { "content-type": "application/json" },
      })
    )
  );
}

function tmdbSearchBody() {
  return {
    results: [
      {
        id: 42,
        title: "The Batman",
        release_date: "2022-03-04",
        poster_path: "/batman.jpg",
        backdrop_path: "/batman-backdrop.jpg",
        popularity: 100,
        vote_count: 1000,
      },
    ],
  };
}

describe("shelf route enrichment", () => {
  beforeEach(() => {
    mockTmdbSearch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sets image_url when the item has no image", async () => {
    const { db, updates } = createShelfDb({
      id: 1,
      type: "movie",
      title: "The Batman",
      image_url: null,
      tags_json: JSON.stringify(["kind:movie"]),
      metadata_json: null,
    });

    const res = await shelfRoute.request("/1/enrich", { method: "POST" }, envFor(db));

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].bindings[0]).toBe("https://image.tmdb.org/t/p/w500/batman.jpg");
  });

  it("preserves a manually curated image_url while adding TMDB metadata", async () => {
    const manualImage = "https://example.com/manual-poster.jpg";
    const { db, updates } = createShelfDb({
      id: 1,
      type: "movie",
      title: "The Batman",
      image_url: manualImage,
      tags_json: JSON.stringify(["kind:movie"]),
      metadata_json: JSON.stringify({ curator: "os" }),
    });

    const res = await shelfRoute.request("/1/enrich", { method: "POST" }, envFor(db));

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].bindings[0]).toBe(manualImage);
    expect(JSON.parse(updates[0].bindings[2] as string)).toMatchObject({
      curator: "os",
      tmdb: {
        id: 42,
        media_type: "movie",
        poster_url: "https://image.tmdb.org/t/p/w500/batman.jpg",
      },
    });
  });

  it("replaces image_url when the current image is already TMDB-owned", async () => {
    const { db, updates } = createShelfDb({
      id: 1,
      type: "movie",
      title: "The Batman",
      image_url: "https://image.tmdb.org/t/p/w500/old.jpg",
      tags_json: JSON.stringify(["kind:movie", "poster_source:tmdb"]),
      metadata_json: null,
    });

    const res = await shelfRoute.request("/1/enrich", { method: "POST" }, envFor(db));

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].bindings[0]).toBe("https://image.tmdb.org/t/p/w500/batman.jpg");
  });

  it("does not expose raw TMDB response bodies on upstream failures", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockTmdbSearch(502, "SECRET_UPSTREAM_BODY");
    const { db } = createShelfDb({
      id: 1,
      type: "movie",
      title: "The Batman",
      tags_json: JSON.stringify(["kind:movie"]),
      metadata_json: null,
    });

    const res = await shelfRoute.request("/1/enrich", { method: "POST" }, envFor(db));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(502);
    expect(body.error).toBe("TMDB request failed");
    expect(JSON.stringify(body)).not.toContain("SECRET_UPSTREAM_BODY");
    expect(consoleSpy).toHaveBeenCalledWith(
      "[tmdb] request failed",
      expect.objectContaining({ status: 502, statusText: "Bad Gateway" })
    );
  });
});
