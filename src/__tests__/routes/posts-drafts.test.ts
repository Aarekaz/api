import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import { testD1, type TestD1 } from "../helpers/d1";
import { requireAuth } from "../../middleware/auth";
import postsRoute from "../../routes/posts";

// The website's token never sees a draft (a post with no published_at); the owner's token sees every post.
let d1: TestD1;
let env: Env;
const app = new Hono<{ Bindings: Env }>();
app.use("/v1/*", requireAuth);
app.route("/v1/posts", postsRoute);
const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env);

beforeEach(() => {
  d1 = testD1({ migrations: "all" });
  env = { DB: d1.DB, API_TOKEN: "owner-token", SITE_TOKEN: "site-token" } as Env;
  const now = "2026-11-26T00:00:00.000Z";
  d1.db.exec(`INSERT INTO posts (id, slug, title, published_at, created_at, updated_at) VALUES
    (1, 'out', 'Out', '2026-11-01T00:00:00.000Z', '${now}', '${now}'),
    (2, 'draft', 'Draft', NULL, '${now}', '${now}')`);
});
afterEach(() => d1.db.close());

describe("drafts and the website's token", () => {
  it("lists only published posts to the site token", async () => {
    const res = await get("/v1/posts", "site-token");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { slug: string }[]).map((p) => p.slug)).toEqual(["out"]);
  });

  it("can't open a post by id at all (the website only reads the list)", async () => {
    expect((await get("/v1/posts/2", "site-token")).status).toBe(403);
  });

  it("shows drafts to the owner's token", async () => {
    const res = await get("/v1/posts", "owner-token");
    expect(((await res.json()) as { slug: string }[]).map((p) => p.slug).sort()).toEqual(["draft", "out"]);
    expect((await get("/v1/posts/2", "owner-token")).status).toBe(200);
  });
});
