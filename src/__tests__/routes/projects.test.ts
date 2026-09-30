import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import projectsRoute from "../../routes/projects";

type SqliteStatement = {
  all: (...bindings: unknown[]) => unknown[];
  get: (...bindings: unknown[]) => unknown;
  run: (...bindings: unknown[]) => { changes: number | bigint };
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

class SqliteD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    readonly sql: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: {},
    };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

const LISTINGS_MIGRATION = "migrations/0022_project_listings.sql";

const LISTINGS = [
  { platform: "chatgpt", status: "available", url: "https://chatgpt.com/g/example" },
  { platform: "poke", status: "in_review", url: null },
];

describe("projects route listings, featured and highlight", () => {
  let database: SqliteDatabase;
  let env: Env;

  const readMigration = async (path: string) => {
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { readFile } = await import("node:fs/promises");
    return (await readFile(path, "utf8")) as string;
  };

  const request = (path: string, init?: RequestInit) =>
    projectsRoute.request(path, init, env);

  const send = (method: string, path: string, body: unknown) =>
    request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const getProject = async (id: number) => {
    const response = await request(`/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  const createProject = async (body: Record<string, unknown>) => {
    const response = await send("POST", "/", body);
    expect(response.status).toBe(201);
    const row = database.prepare("SELECT MAX(id) AS id FROM projects").get() as { id: number };
    return row.id;
  };

  beforeEach(async () => {
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(":memory:") as SqliteDatabase;
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { readdir } = await import("node:fs/promises");
    const migrations = ((await readdir("migrations")) as string[])
      .filter((name) => name.endsWith(".sql") && `migrations/${name}` < LISTINGS_MIGRATION)
      .sort();
    for (const name of migrations) {
      database.exec(await readMigration(`migrations/${name}`));
    }
    env = {
      DB: { prepare: (sql: string) => new SqliteD1Statement(database, sql) },
    } as unknown as Env;
  });

  afterEach(() => {
    database.close();
  });

  it("defaults old rows with NULL columns to not featured, no highlight and no listings", async () => {
    database
      .prepare("INSERT INTO projects (title, links_json, tags_json, created_at) VALUES (?, ?, ?, ?)")
      .run("Legacy", "[\"https://example.com\"]", "[\"web\"]", "2026-01-01T00:00:00.000Z");
    database.exec(await readMigration(LISTINGS_MIGRATION));
    database
      .prepare("INSERT INTO projects (title, listings_json, highlight, created_at) VALUES (?, ?, ?, ?)")
      .run("Corrupt", "{not json", "", "2026-01-02T00:00:00.000Z");
    database
      .prepare("INSERT INTO projects (title, listings_json, created_at) VALUES (?, ?, ?)")
      .run(
        "Mixed",
        JSON.stringify([{ platform: "chatgpt", status: "available", url: null }, { platform: "BAD" }, "x"]),
        "2026-01-03T00:00:00.000Z",
      );

    const response = await request("/?sort=created_at");
    expect(response.status).toBe(200);
    const projects = (await response.json()) as Record<string, unknown>[];
    const byTitle = Object.fromEntries(projects.map((project) => [project.title, project]));

    expect(byTitle.Legacy).toMatchObject({
      featured: false,
      highlight: null,
      listings: [],
      links: ["https://example.com"],
      tags: ["web"],
    });
    expect(byTitle.Legacy).not.toHaveProperty("listings_json");
    expect(byTitle.Corrupt).toMatchObject({ featured: false, highlight: null, listings: [] });
    expect(byTitle.Mixed.listings).toEqual([{ platform: "chatgpt", status: "available", url: null }]);

    const single = await getProject(byTitle.Legacy.id as number);
    expect(single).toMatchObject({ featured: false, highlight: null, listings: [] });
  });

  describe("after the listings migration", () => {
    beforeEach(async () => {
      database.exec(await readMigration(LISTINGS_MIGRATION));
    });

    it("defaults the new fields when create omits them", async () => {
      const id = await createProject({ title: "Plain" });
      expect(await getProject(id)).toMatchObject({ featured: false, highlight: null, listings: [] });
    });

    it("round-trips featured, highlight and listings through create, PUT and PATCH", async () => {
      const id = await createProject({
        title: "Transit",
        featured: true,
        highlight: "  2K+ daily riders  ",
        listings: LISTINGS,
      });
      expect(await getProject(id)).toMatchObject({
        featured: true,
        highlight: "2K+ daily riders",
        listings: LISTINGS,
      });

      const listResponse = await request("/");
      const listed = (await listResponse.json()) as Record<string, unknown>[];
      expect(listed.find((project) => project.id === id)).toMatchObject({
        featured: true,
        highlight: "2K+ daily riders",
        listings: LISTINGS,
      });

      // PATCH changes only the fields that are present.
      const patched = await send("PATCH", `/${id}`, {
        listings: [{ platform: "muse", status: "available", url: "https://muse.example/app" }],
      });
      expect(patched.status).toBe(200);
      expect(await getProject(id)).toMatchObject({
        featured: true,
        highlight: "2K+ daily riders",
        listings: [{ platform: "muse", status: "available", url: "https://muse.example/app" }],
      });

      // An empty highlight is stored as null; omitted listing url becomes null.
      const cleared = await send("PATCH", `/${id}`, {
        highlight: "   ",
        featured: false,
        listings: [{ platform: "poke", status: "in_review" }],
      });
      expect(cleared.status).toBe(200);
      expect(await getProject(id)).toMatchObject({
        featured: false,
        highlight: null,
        listings: [{ platform: "poke", status: "in_review", url: null }],
      });
      const stored = database
        .prepare("SELECT highlight, featured FROM projects WHERE id = ?")
        .get(id) as { highlight: unknown; featured: unknown };
      expect(stored).toEqual({ highlight: null, featured: 0 });

      // PUT is a full replacement, like the other optional fields.
      const put = await send("PUT", `/${id}`, {
        title: "Transit v2",
        featured: true,
        highlight: "Top 10 on Poke",
        listings: LISTINGS,
      });
      expect(put.status).toBe(200);
      expect(await getProject(id)).toMatchObject({
        title: "Transit v2",
        featured: true,
        highlight: "Top 10 on Poke",
        listings: LISTINGS,
      });

      const replaced = await send("PUT", `/${id}`, { title: "Transit v3" });
      expect(replaced.status).toBe(200);
      expect(await getProject(id)).toMatchObject({
        title: "Transit v3",
        featured: false,
        highlight: null,
        listings: [],
      });
    });

    it.each([
      ["a platform that is not a lowercase slug", { listings: [{ platform: "ChatGPT", status: "available", url: null }] }],
      ["a platform longer than 32 chars", { listings: [{ platform: "a".repeat(33), status: "available", url: null }] }],
      ["an unknown listing status", { listings: [{ platform: "chatgpt", status: "live", url: null }] }],
      ["a non-https listing url", { listings: [{ platform: "chatgpt", status: "available", url: "http://chatgpt.com" }] }],
      ["a listing url that is not a url", { listings: [{ platform: "chatgpt", status: "available", url: "chatgpt.com" }] }],
      [
        "a listing url longer than 500 chars",
        { listings: [{ platform: "chatgpt", status: "available", url: `https://example.com/${"a".repeat(490)}` }] },
      ],
      [
        "duplicate platforms",
        {
          listings: [
            { platform: "chatgpt", status: "available", url: null },
            { platform: "chatgpt", status: "in_review", url: null },
          ],
        },
      ],
      [
        "more than 12 listings",
        {
          listings: Array.from({ length: 13 }, (_, index) => ({
            platform: `platform-${index}`,
            status: "available",
            url: null,
          })),
        },
      ],
      ["a highlight longer than 80 chars", { highlight: "x".repeat(81) }],
      ["a non-boolean featured", { featured: "yes" }],
    ])("rejects %s on create, PUT and PATCH", async (_label, fields) => {
      const id = await createProject({ title: "Existing" });
      const before = database.prepare("SELECT * FROM projects WHERE id = ?").get(id);

      for (const [method, path] of [["POST", "/"], ["PUT", `/${id}`], ["PATCH", `/${id}`]] as const) {
        const response = await send(method, path, { title: "Changed", ...fields });
        expect(response.status, method).toBe(400);
        const body = (await response.json()) as { error: string; details: { fieldErrors: Record<string, unknown> } };
        expect(body.error, method).toBe("Validation error");
        expect(Object.keys(body.details.fieldErrors), method).toEqual(Object.keys(fields));
      }

      const count = database.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
      expect(count.n).toBe(1);
      expect(database.prepare("SELECT * FROM projects WHERE id = ?").get(id)).toEqual(before);
    });

    it("accepts exactly 12 listings and an 80 char highlight", async () => {
      const listings = Array.from({ length: 12 }, (_, index) => ({
        platform: `p-${index}`,
        status: "available",
        url: `https://example.com/${index}`,
      }));
      const id = await createProject({ title: "Max", highlight: "x".repeat(80), listings });
      expect(await getProject(id)).toMatchObject({ highlight: "x".repeat(80), listings });
    });
  });
});
