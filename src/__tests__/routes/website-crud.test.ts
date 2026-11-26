import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { Env } from "../../types/env";
import { testD1, type TestD1 } from "../helpers/d1";
import experienceRoute from "../../routes/experience";
import educationRoute from "../../routes/education";
import skillsRoute from "../../routes/skills";
import usesRoute from "../../routes/uses";
import projectsRoute from "../../routes/projects";
import postsRoute from "../../routes/posts";
import photosRoute from "../../routes/photos";
import shelfRoute from "../../routes/shelf";
import locationRoute from "../../routes/location";

// Characterisation of the website's CRUD routes (and location, which shares
// their helpers): every status, body and header a client sees for list, get,
// create, replace, patch and delete, including each error body. Written
// before the shared helpers replaced the copies in each file; the snapshots
// are the contract, so a refactor must leave them unchanged.

interface Case {
  name: string;
  route: Hono<{ Bindings: Env }>;
  table: string;
  create: Record<string, unknown>;
  replace: Record<string, unknown>;
  patch: Record<string, unknown>;
  invalid: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "experience", route: experienceRoute, table: "experience",
    create: { company: "Acme", role: "Engineer", location: "NYC", start_date: "2024-01-01", published: true },
    replace: { company: "Acme", role: "Staff", description: "More", published: false },
    patch: { role: "Principal", end_date: "2026-01-01", published: true },
    invalid: { company: "" },
  },
  {
    name: "education", route: educationRoute, table: "education",
    create: { institution: "School", degree: "BS", field: "CS", start_date: "2018-09-01" },
    replace: { institution: "School", degree: "MS", published: false },
    patch: { field: "Maths", published: true },
    invalid: { degree: "BS" },
  },
  {
    name: "skills", route: skillsRoute, table: "skills",
    create: { category: "Languages", items: ["TypeScript", "Swift"] },
    replace: { category: "Languages", items: ["Rust"], published: false },
    patch: { items: ["Go"], published: true },
    invalid: { items: "not a list" },
  },
  {
    name: "uses", route: usesRoute, table: "uses_items",
    create: { category: "Desk", name: "Chair", url: "https://example.com/chair", note: "Comfy" },
    replace: { category: "Desk", name: "Stool", published: false },
    patch: { note: "Less comfy", published: true },
    invalid: { category: "Desk", name: "Chair", url: "not a url" },
  },
  {
    name: "projects", route: projectsRoute, table: "projects",
    create: { title: "Thing", description: "A thing", links: ["https://example.com"], tags: ["a", "b"], sort_order: 2 },
    replace: { title: "Thing 2", tags: ["c"], published: false, featured: true, highlight: "Best" },
    patch: { description: "Changed", published: true, highlight: null },
    invalid: { title: 7 },
  },
  {
    name: "posts", route: postsRoute, table: "posts",
    create: { slug: "hello", title: "Hello", summary: "Hi", tags: ["intro"], published_at: "2026-01-01T00:00:00.000Z" },
    replace: { slug: "hello", title: "Hello again", pinned: true },
    patch: { summary: "Changed", pinned: false },
    invalid: { slug: "" },
  },
  {
    name: "photos", route: photosRoute, table: "photos",
    create: { title: "Sky", url: "https://media.example.com/sky.jpg", width: 100, height: 50, tags: ["blue"], shot_at: "2025-06-01T12:00:00Z" },
    replace: { title: "Sea", url: "https://media.example.com/sea.jpg", published: false },
    patch: { title: "Sea at dusk", published: true, tags: ["dusk"] },
    invalid: { url: "nope" },
  },
  {
    name: "shelf", route: shelfRoute, table: "shelf_items",
    create: { type: "book", title: "Dune", author: "Herbert", tags: ["scifi"], status: "reading", rating: 4, rating_scale: 5 },
    replace: { type: "book", title: "Dune Messiah", status: "completed", published: false },
    patch: { note: "Reread", published: true, rating: 5 },
    invalid: { type: "book", status: "watching" },
  },
  {
    name: "location", route: locationRoute, table: "location_history",
    create: { latitude: 40.7, longitude: -74, recorded_at: "2026-11-20T10:00:00.000Z", city: "New York", label: "home" },
    replace: { latitude: 40.8, longitude: -73.9, recorded_at: "2026-11-20T11:00:00.000Z", notes: "moved" },
    patch: { label: "work", accuracy: 5 },
    invalid: { latitude: 200, longitude: 0, recorded_at: "2026-11-20T10:00:00.000Z" },
  },
];

let d1: TestD1;
let env: Env;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
  d1 = testD1({ migrations: "all" });
  env = { DB: d1.DB } as Env;
});

afterEach(() => {
  vi.useRealTimers();
  d1.db.close();
});

/** Everything a client sees: status, content type and the exact body text. */
async function seen(res: Response) {
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

describe.each(CASES)("$name (website CRUD characterisation)", (t) => {
  const call = (method: string, path: string, body?: unknown, raw?: string) =>
    t.route.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }, env);
  const lastId = () => (d1.db.prepare(`SELECT MAX(id) AS id FROM ${t.table}`).get() as { id: number }).id;

  it("creates, reads, replaces, patches and deletes", async () => {
    const steps: Record<string, unknown> = {};
    steps.create = await seen(await call("POST", "/", t.create));
    const id = lastId();
    steps.get = await seen(await call("GET", `/${id}`));
    steps.list = await seen(await call("GET", "/"));
    steps.replace = await seen(await call("PUT", `/${id}`, t.replace));
    steps.afterReplace = await seen(await call("GET", `/${id}?include_unpublished=true`));
    steps.patch = await seen(await call("PATCH", `/${id}`, t.patch));
    steps.afterPatch = await seen(await call("GET", `/${id}`));
    steps.delete = await seen(await call("DELETE", `/${id}`));
    steps.afterDelete = await seen(await call("GET", `/${id}`));
    expect(steps).toMatchSnapshot();
  });

  it("answers every bad request with the website's error bodies", async () => {
    await call("POST", "/", t.create);
    const id = lastId();
    const errors = {
      createBadJson: await seen(await call("POST", "/", undefined, "{not json")),
      createInvalid: await seen(await call("POST", "/", t.invalid)),
      getBadId: await seen(await call("GET", "/abc")),
      getZeroId: await seen(await call("GET", "/0")),
      getMissing: await seen(await call("GET", "/9999")),
      putBadId: await seen(await call("PUT", "/abc", t.replace)),
      putBadJson: await seen(await call("PUT", `/${id}`, undefined, "nope")),
      putInvalid: await seen(await call("PUT", `/${id}`, t.invalid)),
      putMissing: await seen(await call("PUT", "/9999", t.replace)),
      patchBadId: await seen(await call("PATCH", "/1.5", t.patch)),
      patchBadJson: await seen(await call("PATCH", `/${id}`, undefined, "[")),
      patchEmpty: await seen(await call("PATCH", `/${id}`, {})),
      patchMissing: await seen(await call("PATCH", "/9999", t.patch)),
      deleteBadId: await seen(await call("DELETE", "/-1")),
      deleteMissing: await seen(await call("DELETE", "/9999")),
    };
    expect(errors).toMatchSnapshot();
  });

  it("pages and bounds ?limit= and ?offset=", async () => {
    for (let i = 0; i < 5; i++) await call("POST", "/", typeof t.create.slug === "string" ? { ...t.create, slug: `${t.create.slug}-${i}` } : t.create);
    const count = async (query: string) => {
      const res = await call("GET", `/${query}`);
      const body = await res.json() as unknown;
      return Array.isArray(body) ? body.length : (body as { error?: unknown });
    };
    expect({
      none: await count(""),
      two: await count("?limit=2"),
      offset: await count("?limit=2&offset=4"),
      zero: await count("?limit=0"),
      junk: await count("?limit=abc"),
      negativeOffset: await count("?limit=2&offset=-3"),
    }).toMatchSnapshot();
  });
});

describe("an error nothing catches", () => {
  // Hono's own handler answers: plain text, no JSON, no stack. (The old
  // middleware/error-handler.ts never ran; see docs/audit-2026-11.md 2.1.)
  it("is a text 500 on a website route", async () => {
    const send = () => postsRoute.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "same", title: "T" }) }, env);
    expect((await send()).status).toBe(201);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await seen(await send())).toEqual({ status: 500, type: "text/plain; charset=UTF-8", body: "Internal Server Error" });
    spy.mockRestore();
  });
});

describe("limit bounds on the website's lists", () => {
  // `?limit=-1` used to reach SQL as LIMIT -1 (no limit at all), and
  // `?limit=1.5` as a REAL (a 500). Now: rounded down, at least 1.
  it.each(CASES.filter((t) => t.name !== "location"))("$name", async (t) => {
    for (let i = 0; i < 3; i++) {
      const body = typeof t.create.slug === "string" ? { ...t.create, slug: `${t.create.slug}-${i}` } : t.create;
      await t.route.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    }
    const rows = async (query: string) => {
      const res = await t.route.request(`/${query}`, {}, env);
      expect(res.status, query).toBe(200);
      return (await res.json() as unknown[]).length;
    };
    expect(await rows("?limit=-1")).toBe(1);
    expect(await rows("?limit=1.5")).toBe(1);
    expect(await rows("?limit=2.9")).toBe(2);
    expect(await rows("?limit=2&offset=1.5")).toBe(2);
  });
});

describe("clampLimit", () => {
  it("is limitFrom's rule: floor, at least 1, at most max, fallback for 0 or junk", async () => {
    const { clampLimit, clampOffset } = await import("../../utils/query");
    expect([undefined, "", "abc", "0", "-1", "-0.5", "0.5", "1.9", "50", "5000", "Infinity"].map((v) => clampLimit(v, 100, 1000)))
      .toEqual([100, 100, 100, 100, 1, 1, 100, 1, 50, 1000, 1000]);
    expect([undefined, "-3", "2.7", "abc"].map(clampOffset)).toEqual([0, 0, 2, 0]);
  });
});
