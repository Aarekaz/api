// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireAuth, sameSecret } from "../../middleware/auth";
import { isSiteRead } from "../../lib/site-reads";

const env = { API_TOKEN: "owner-token", SITE_TOKEN: "site-token" };
const app = new Hono<{ Bindings: typeof env }>();
app.use("/v1/*", requireAuth);
app.all("/v1/*", (c) => c.json({ reached: true }));
const call = (method: string, path: string, token: string, bindings: Record<string, string> = env) =>
  app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, bindings);

const contract = JSON.parse(readFileSync("src/__tests__/contracts/website-openapi.snapshot.json", "utf8")) as { paths: Record<string, Record<string, unknown>> };
// The website's reads outside its contract (AGENTS.md), with a sample for each parameter.
const BEYOND_CONTRACT = ["/v1/wrapped/2026", "/v1/wrapped/2025", "/v1/traffic/2026", "/v1/status", "/v1/music/now",
  "/v1/health/whoop/cycles", "/v1/health/whoop/sleeps", "/v1/health/whoop/workouts/abc-123", "/v1/health/whoop/overview"];

describe("SITE_TOKEN", () => {
  it("reads every route in the website's contract", async () => {
    const reads = Object.entries(contract.paths).flatMap(([path, methods]) => Object.keys(methods).map((m) => [m.toUpperCase(), path]));
    expect(reads.length).toBeGreaterThan(10);
    for (const [method, path] of reads) {
      expect(isSiteRead(method, path), `${method} ${path}`).toBe(true);
      const res = await call(method, `${path}?limit=5`, "site-token");
      expect(res.status, path).toBe(200);
    }
  });

  it("reads the website's routes beyond the contract, by GET or HEAD", async () => {
    for (const path of BEYOND_CONTRACT) {
      expect((await call("GET", path, "site-token")).status, path).toBe(200);
      expect((await call("HEAD", path, "site-token")).status, path).toBe(200);
    }
  });

  it("can't write, not even to a route the website reads (the website's old error body)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(method, "/v1/profile", "site-token");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "This token can only read the website's data" });
    }
  });

  it("can't read the app's routes (the one error shape)", async () => {
    for (const path of ["/v1/visits", "/v1/visits/day", "/v1/links", "/v1/documents", "/v1/journal", "/v1/posts/drafts", "/v1/wrapped/day",
      "/v1/music/history", "/v1/health", "/v1/location", "/v1/admin/backup", "/v1/vault", "/v1/traffic/26", "/v1/profilex"]) {
      const res = await call("GET", path, "site-token");
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: "This token can only read the website's data" } });
    }
  });

  it("leaves API_TOKEN with full access", async () => {
    expect((await call("POST", "/v1/profile", "owner-token")).status).toBe(200);
    expect((await call("GET", "/v1/visits", "owner-token")).status).toBe(200);
  });

  it("does nothing when unset, and a wrong token is still refused", async () => {
    const res = await call("GET", "/v1/profile", "site-token", { API_TOKEN: "owner-token" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Invalid token" });
    expect((await call("GET", "/v1/profile", "site-tokem")).status).toBe(403);
  });
});

describe("sameSecret", () => {
  it("matches only the same secret, whatever the lengths", async () => {
    expect(await sameSecret("abc", "abc")).toBe(true);
    expect(await sameSecret("abd", "abc")).toBe(false);
    expect(await sameSecret("abc", "abcd")).toBe(false);
    expect(await sameSecret("", "abc")).toBe(false);
    expect(await sameSecret("abc", undefined)).toBe(false);
    expect(await sameSecret("abc", "")).toBe(false);
  });
});
