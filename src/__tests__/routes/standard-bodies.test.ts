import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import documentsRoute from "../../routes/documents";
import sectionsRoute from "../../routes/sections";
import highlightsRoute from "../../routes/highlights";
import linksRoute from "../../routes/links";
import journalRoute from "../../routes/journal";
import recipesRoute from "../../routes/recipes";
import visitsRoute from "../../routes/visits";
import siteRoute from "../../routes/site";
import { testD1, type TestD1 } from "../helpers/d1";

// The app's write routes read bodies through lib/http.ts (`body(c, schema)`,
// `objectBody(c)`): unreadable JSON is "Invalid JSON", a body that isn't an
// object is "Send a JSON object", both 400 in the one shape; nothing is
// written. A create answers 201.

const NOT_OBJECTS = ["true", "0", "1", '"text"', "[]", "[1]"];
const NOT_JSON = [undefined, "", "not json", "null"];

describe("request bodies on the app's write routes", () => {
  let d1: TestD1;
  let env: Env;
  let root: Hono<{ Bindings: Env }>;
  const send = (method: string, path: string, body?: string) =>
    root.request(path, { method, body, headers: { "Content-Type": "application/json" } }, env);
  const answer = async (res: Response) => [res.status, await res.json()];
  const invalid = (message: string) => [400, { error: { code: "invalid", message } }];
  const count = (table: string) => (d1.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    d1 = testD1({ migrations: "all" });
    env = { DB: d1.DB } as Env;
    root = new Hono<{ Bindings: Env }>();
    root.route("/v1/documents", documentsRoute);
    root.route("/v1/sections", sectionsRoute);
    root.route("/v1/highlights", highlightsRoute);
    root.route("/v1/links", linksRoute);
    root.route("/v1/journal", journalRoute);
    root.route("/v1/recipes", recipesRoute);
    root.route("/v1/visits", visitsRoute);
    root.route("/v1/site", siteRoute);
  });

  afterEach(() => d1.db.close());

  it("documents POST and PUT refuse a body that isn't an object instead of making an Untitled note", async () => {
    const created = await (await send("POST", "/v1/documents", JSON.stringify({ title: "Kept", body: "x" }))).json() as { id: string };
    for (const body of NOT_OBJECTS) {
      expect(await answer(await send("POST", "/v1/documents", body)), body).toEqual(invalid("Send a JSON object"));
      expect(await answer(await send("PUT", `/v1/documents/${created.id}`, body)), body).toEqual(invalid("Send a JSON object"));
    }
    for (const body of NOT_JSON) {
      expect(await answer(await send("POST", "/v1/documents", body)), String(body)).toEqual(invalid("Invalid JSON"));
      expect(await answer(await send("PUT", `/v1/documents/${created.id}`, body)), String(body)).toEqual(invalid("Invalid JSON"));
    }
    expect(count("documents")).toBe(1);
    expect(count("document_versions")).toBe(0);
  });

  it("every app write that reads fields refuses a body that isn't an object, before touching anything", async () => {
    const paths: Array<[string, string]> = [
      ["POST", "/v1/sections"], ["PATCH", "/v1/sections"], ["DELETE", "/v1/sections"],
      ["PATCH", "/v1/highlights/h1"], ["POST", "/v1/visits/saved"], ["PATCH", "/v1/visits/journeys/1"],
      ["POST", "/v1/visits"], ["POST", "/v1/visits/journeys"],
    ];
    for (const [method, path] of paths) {
      for (const body of NOT_OBJECTS) {
        const [status, json] = await answer(await send(method, path, body));
        expect(status, `${method} ${path} ${body}`).toBe(400);
        expect((json as { error: { code: string } }).error.code, `${method} ${path} ${body}`).toBe("invalid");
      }
    }
    expect(count("saved_places")).toBe(0);
  });

  it("schema-checked writes answer unreadable JSON with Invalid JSON, not a schema message", async () => {
    for (const [method, path] of [
      ["POST", "/v1/highlights"], ["PATCH", "/v1/links/l1"], ["PUT", "/v1/links/l1/progress"],
      ["POST", "/v1/journal"], ["PATCH", "/v1/journal/j1"],
      ["POST", "/v1/recipes"], ["PATCH", "/v1/recipes/r1"], ["POST", "/v1/recipes/import"],
      ["PATCH", "/v1/site/profile"], ["PATCH", "/v1/site/shelf-sections"],
    ]) {
      expect(await answer(await send(method, path, "not json")), `${method} ${path}`).toEqual(invalid("Invalid JSON"));
      const [status] = await answer(await send(method, path, "[1]"));
      expect(status, `${method} ${path} [1]`).toBe(400);
    }
  });

  it("visits and journeys drop items that aren't objects (they were a 500)", async () => {
    const visits = await send("POST", "/v1/visits", JSON.stringify({ visits: [null, 3, "x", []] }));
    expect(await answer(visits)).toEqual([200, { received: 4, valid: 0, added: 0 }]);
    const journeys = await send("POST", "/v1/visits/journeys", JSON.stringify({ journeys: [null] }));
    expect(await answer(journeys)).toEqual([200, { received: 1, valid: 0, added: 0 }]);
    const names = await send("POST", "/v1/visits/names", JSON.stringify({ names: [null, 7, { key: "1.000,2.000", name: "Home" }] }));
    expect(await answer(names)).toEqual([200, { received: 3, saved: 1 }]);
  });

  it("a saved place is created with 201", async () => {
    const res = await send("POST", "/v1/visits/saved", JSON.stringify({ name: "Home", latitude: 1, longitude: 2 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Home", latitude: 1, longitude: 2 });
  });
});
