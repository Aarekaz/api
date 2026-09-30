import { describe, expect, it } from "vitest";
import "../../index";
import { getOpenApiDocument } from "../../schemas/openapi";
import { createSpotifyDatabase } from "./fixtures";

type SchemaObject = {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  format?: string;
  required?: string[];
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  additionalProperties?: boolean | SchemaObject;
};

type Operation = {
  security?: unknown[];
  responses?: Record<string, { content?: { "application/json"?: { schema?: SchemaObject } } }>;
};

const document = JSON.parse(JSON.stringify(getOpenApiDocument("test"))) as {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, SchemaObject> };
};

describe("Spotify OpenAPI contract", () => {
  it("registers MusicNowResponse as a named component used by GET /v1/music/now", () => {
    const operation = document.paths["/v1/music/now"]?.get;
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(operation?.responses?.["200"]?.content?.["application/json"]?.schema)
      .toEqual({ $ref: "#/components/schemas/MusicNowResponse" });

    const schema = document.components!.schemas!.MusicNowResponse;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required?.sort()).toEqual(["fetched_at", "state", "track"]);
    expect(schema.properties!.state.enum).toEqual(["playing", "recent", "idle", "disconnected"]);
    expect(schema.properties!.fetched_at).toMatchObject({ type: "string", format: "date-time" });

    const track = schema.properties!.track;
    expect(track).toMatchObject({ type: "object", nullable: true, additionalProperties: false });
    expect(track.required?.sort()).toEqual([
      "album", "artists", "duration_ms", "image_url", "kind", "played_at", "progress_ms", "title", "url",
    ]);
    const property = (name: string) => track.properties![name];
    expect(property("title")).toMatchObject({ type: "string" });
    expect(property("title").nullable).toBeUndefined();
    expect(property("artists")).toMatchObject({ type: "array", items: { type: "string" } });
    expect(property("album")).toMatchObject({ type: "string", nullable: true });
    expect(property("image_url")).toMatchObject({ type: "string", nullable: true });
    expect(property("url")).toMatchObject({ type: "string" });
    expect(property("url").nullable).toBeUndefined();
    for (const name of ["duration_ms", "progress_ms"]) {
      expect(property(name)).toMatchObject({ type: "integer", nullable: true });
    }
    expect(property("played_at")).toMatchObject({ type: "string", format: "date-time", nullable: true });
  });

  it("registers the Spotify integration routes with bearer auth except the provider callback", () => {
    expect(document.paths["/v1/integrations/spotify"]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/v1/integrations/spotify"]?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/v1/integrations/spotify/connect"]?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/v1/integrations/spotify/connect"]?.post?.responses?.["200"]
      ?.content?.["application/json"]?.schema?.properties?.authorization_url).toMatchObject({ type: "string" });
    const callback = document.paths["/integrations/spotify/callback"]?.get;
    expect(callback?.security).toBeUndefined();
    expect(Object.keys(callback?.responses ?? {})).toEqual(["302"]);
  });
});

describe("Spotify migration", () => {
  it("allows exactly one connection row with a constrained status", async () => {
    const { sqlite } = await createSpotifyDatabase();
    const insert = (id: number, status: string) => sqlite.prepare(`
      INSERT INTO spotify_connections (id, status, granted_scopes, created_at, updated_at)
      VALUES (?, ?, '', '2026-09-30T12:00:00.000Z', '2026-09-30T12:00:00.000Z')
    `).run(id, status);

    expect(() => insert(1, "bogus")).toThrow(/CHECK constraint failed/i);
    expect(() => insert(2, "active")).toThrow(/CHECK constraint failed/i);
    insert(1, "active");
    sqlite.close();
  });
});
