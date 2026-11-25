// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error same as above.
import process from "node:process";
import { describe, expect, it } from "vitest";
import "../../index";
import { getOpenApiDocument } from "../../schemas/openapi";

/**
 * The website (anuragd.me) freeze. Two files, both cut the way
 * anurag.me/scripts/check-api-contract.mjs cuts the API's OpenAPI document
 * (the GET endpoints the site reads and every schema they reach):
 *
 * - `website-openapi.snapshot.json` is a copy of anurag.me/contracts/api-openapi.json,
 *   the site's own contract. Every field in it must still be there, unchanged.
 * - `website-openapi.frozen.json` is the same slice as the API serves it today
 *   (the site's copy is older and lacks a few fields added since). It must match
 *   exactly, so any change to a shape the website reads, even an added field,
 *   fails here before it ships.
 *
 * Changing a website shape on purpose: change the site first, refresh its
 * contract, copy it here, then rewrite the frozen file with
 * `UPDATE_WEBSITE_FREEZE=1 npx vitest run src/__tests__/contracts`.
 */

type Json = Record<string, unknown>;
const snapshot = JSON.parse(readFileSync("src/__tests__/contracts/website-openapi.snapshot.json", "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
};
const document = JSON.parse(JSON.stringify(getOpenApiDocument("test"))) as {
  paths: Record<string, Record<string, { responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }> }>>;
  components?: { schemas?: Record<string, unknown> };
};

const PREFIX = "#/components/schemas/";

function stripExamples(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExamples);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Json)
    .filter(([key]) => key !== "example" && key !== "examples")
    .map(([key, nested]) => [key, stripExamples(nested)]));
}

/** The website's slice of the live document: same paths as the snapshot, and the schemas they reach. */
function websiteSlice() {
  const referenced = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object") return;
    const ref = (value as Json).$ref;
    if (typeof ref === "string" && ref.startsWith(PREFIX)) {
      const name = ref.slice(PREFIX.length);
      if (!referenced.has(name)) { referenced.add(name); collect(document.components?.schemas?.[name]); }
    }
    Object.values(value as Json).forEach(collect);
  };
  const paths = Object.fromEntries(Object.entries(snapshot.paths).map(([path, methods]) => [path,
    Object.fromEntries(Object.keys(methods).map((method) => {
      const response = document.paths[path]?.[method]?.responses?.["200"];
      const schema = response?.content?.["application/json"]?.schema;
      collect(schema);
      return [method, { responses: { "200": { description: response?.description ?? "OK", content: { "application/json": { schema } } } } }];
    }))]));
  const schemas = Object.fromEntries([...referenced].sort().map((name) => [name, document.components?.schemas?.[name]]));
  return stripExamples({ paths, components: { schemas } }) as typeof snapshot;
}

const FROZEN = "src/__tests__/contracts/website-openapi.frozen.json";
if (process.env.UPDATE_WEBSITE_FREEZE === "1") {
  writeFileSync(FROZEN, `${JSON.stringify(websiteSlice(), null, 2)}\n`);
}
const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as typeof snapshot;

type Schema = { $ref?: string; type?: string; nullable?: boolean; enum?: unknown[]; required?: string[];
  properties?: Record<string, Schema>; items?: Schema; additionalProperties?: unknown };

/** Problems that would break a reader of `old`: a field gone, retyped, made nullable or no longer required. */
function incompatibilities(old: Schema | undefined, now: Schema | undefined, at: string): string[] {
  if (!old) return [];
  if (!now) return [`${at}: missing`];
  const out: string[] = [];
  for (const key of ["$ref", "type", "format", "minLength", "maxLength", "minimum", "maximum"] as const) {
    const a = (old as Record<string, unknown>)[key], b = (now as Record<string, unknown>)[key];
    if (a !== undefined && a !== b) out.push(`${at}: ${key} ${JSON.stringify(a)} became ${JSON.stringify(b)}`);
  }
  if (!old.nullable && now.nullable) out.push(`${at}: became nullable`);
  if (old.enum && JSON.stringify(old.enum) !== JSON.stringify(now.enum)) out.push(`${at}: enum changed`);
  for (const field of old.required ?? []) if (!(now.required ?? []).includes(field)) out.push(`${at}.${field}: no longer required`);
  for (const [field, schema] of Object.entries(old.properties ?? {})) out.push(...incompatibilities(schema, now.properties?.[field], `${at}.${field}`));
  out.push(...incompatibilities(old.items, now.items, `${at}[]`));
  return out;
}

describe("website freeze", () => {
  const live = websiteSlice();

  it("serves exactly the frozen website slice", () => {
    expect(live).toEqual(frozen);
  });

  it("keeps every field of the website's own contract", () => {
    const problems = [
      ...Object.keys(snapshot.paths).flatMap((path) => Object.keys(snapshot.paths[path]).flatMap((method) => {
        const pick = (doc: typeof snapshot) => ((doc.paths[path]?.[method] as { responses: Record<string, { content: Record<string, { schema: Schema }> }> } | undefined)
          ?.responses["200"]?.content["application/json"]?.schema);
        return incompatibilities(pick(snapshot), pick(live), `${method.toUpperCase()} ${path}`);
      })),
      ...Object.entries(snapshot.components.schemas).flatMap(([name, schema]) =>
        incompatibilities(schema as Schema, live.components.schemas[name] as Schema | undefined, name)),
    ];
    expect(problems).toEqual([]);
  });

  it("covers the endpoints the website reads", () => {
    expect(Object.keys(snapshot.paths).sort()).toEqual([
      "/v1/education", "/v1/experience", "/v1/github", "/v1/now", "/v1/photos", "/v1/posts", "/v1/profile",
      "/v1/projects", "/v1/settings", "/v1/shelf", "/v1/skills", "/v1/uses", "/v1/wakatime", "/v1/wakatime/hourly",
    ]);
  });

  for (const path of Object.keys(frozen.paths)) {
    it(`keeps GET ${path} exactly as the website reads it`, () => {
      expect(live.paths[path]).toEqual(frozen.paths[path]);
    });
  }

  for (const name of Object.keys(frozen.components.schemas)) {
    it(`keeps schema ${name} exactly as the website reads it`, () => {
      expect(live.components.schemas[name]).toEqual(frozen.components.schemas[name]);
    });
  }

  // Read by the site but outside its contract file: they must stay mounted with
  // the same path (their bodies are guarded by their own route tests).
  it.each([
    "/v1/wrapped/2026", "/v1/traffic/{year}", "/v1/music/now", "/v1/status",
    "/v1/health/whoop/workouts",
  ])("still documents %s", (path) => {
    expect(document.paths[path]?.get).toBeTruthy();
  });
});
