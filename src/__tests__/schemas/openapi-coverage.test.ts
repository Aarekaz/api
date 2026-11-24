import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";

type Operation = { security?: unknown[] };
type DocumentShape = { paths: Record<string, Record<string, Operation>> };

// Served outside the API proper: the index, the badge and the docs themselves.
const UNDOCUMENTED = new Set(["GET /", "GET /badge", "GET /openapi.json", "GET /docs"]);

let routes: Array<{ method: string; path: string }> = [];
let document: DocumentShape;

beforeAll(async () => {
  // index.ts doesn't export its Hono app, so catch it as it mounts /v1 routes.
  // Hono flattens every mounted sub-app into the root app's `routes`.
  let root: Hono | null = null;
  const route = Hono.prototype.route;
  Hono.prototype.route = function (this: Hono, path: string, app: Hono) {
    if (path.startsWith("/v1")) root = this;
    return route.call(this, path, app);
  } as typeof route;
  try {
    await import("../../index");
  } finally {
    Hono.prototype.route = route;
  }
  if (!root) throw new Error("Couldn't find the root Hono app");
  routes = (root as Hono).routes.filter((r) => r.method !== "ALL");

  const { getOpenApiDocument } = await import("../../schemas/openapi");
  document = JSON.parse(JSON.stringify(getOpenApiDocument("test"))) as DocumentShape;
});

const openApiPath = (path: string) => path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");

describe("OpenAPI coverage", () => {
  it("documents every route the worker serves", () => {
    expect(routes.length).toBeGreaterThan(200);
    const missing = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !UNDOCUMENTED.has(key))
      .filter((key) => {
        const [method, path] = key.split(" ");
        return !document.paths[openApiPath(path)]?.[method.toLowerCase()];
      });
    expect(missing).toEqual([]);
  });

  it.each([
    ["get", "/v1/documents"],
    ["put", "/v1/documents/{id}"],
    ["get", "/v1/search"],
    ["post", "/v1/capture"],
    ["get", "/v1/sync/status"],
    ["get", "/v1/journal"],
    ["get", "/v1/journal/stats"],
    ["patch", "/v1/journal/{id}"],
    ["get", "/v1/links"],
    ["put", "/v1/links/{id}/progress"],
    ["get", "/v1/highlights"],
    ["get", "/v1/recipes"],
    ["delete", "/v1/recipes/{id}/log/{logId}"],
    ["get", "/v1/sections"],
    ["patch", "/v1/site/profile"],
    ["patch", "/v1/site/shelf-sections"],
    ["get", "/v1/training/next"],
    ["put", "/v1/training/routines/{id}"],
    ["get", "/v1/visits/places"],
    ["post", "/v1/visits/journeys"],
    ["get", "/v1/vault/tree"],
    ["post", "/v1/app/signout"],
    ["get", "/v1/music/history"],
    ["get", "/v1/health/{date}"],
    ["post", "/v1/blog-images/presign"],
  ])("documents %s %s behind bearer auth", (method, path) => {
    const operation = document.paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  });

  it.each([
    ["get", "/auth/app/github/start"],
    ["get", "/auth/app/github/callback"],
    ["put", "/v1/photos/upload-presigned"],
    ["put", "/v1/blog-images/upload-presigned"],
  ])("documents %s %s without bearer auth", (method, path) => {
    const operation = document.paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation?.security).toBeUndefined();
  });
});
