import { describe, expect, it } from "vitest";
import "../../index";
import { getOpenApiDocument } from "../../schemas/openapi";

type SchemaObject = {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  required?: string[];
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  additionalProperties?: boolean | SchemaObject;
};

type DocumentShape = {
  paths: Record<
    string,
    {
      get?: {
        responses?: Record<
          string,
          {
            content?: {
              "application/json"?: { schema?: SchemaObject };
            };
          }
        >;
      };
    }
  >;
  components?: {
    schemas?: Record<string, SchemaObject>;
  };
};

const document = getOpenApiDocument("test") as unknown as DocumentShape;

function resolveSchema(schema: SchemaObject): SchemaObject {
  if (!schema.$ref) return schema;

  const name = schema.$ref.split("/").at(-1);
  const resolved = name ? document.components?.schemas?.[name] : undefined;
  if (!resolved) throw new Error(`Unresolved schema reference: ${schema.$ref}`);
  return resolveSchema(resolved);
}

function responseSchema(path: string): SchemaObject {
  const schema = document.paths[path]?.get?.responses?.["200"]?.content?.[
    "application/json"
  ]?.schema;
  if (!schema) throw new Error(`Missing GET 200 application/json schema: ${path}`);
  return resolveSchema(schema);
}

function itemOrObjectSchema(path: string): SchemaObject {
  const schema = responseSchema(path);
  return schema.type === "array" && schema.items
    ? resolveSchema(schema.items)
    : schema;
}

function property(schema: SchemaObject, name: string): SchemaObject {
  const value = resolveSchema(schema).properties?.[name];
  if (!value) throw new Error(`Missing property: ${name}`);
  return resolveSchema(value);
}

describe("website-consumed OpenAPI response contracts", () => {
  it.each([
    [
      "/v1/profile",
      [
        "id",
        "name",
        "bio",
        "handles",
        "contact",
        "timezone",
        "avatar_url",
        "location",
        "email",
        "website",
        "image_url",
        "image_alt",
        "summary",
        "updated_at",
      ],
    ],
    [
      "/v1/projects",
      [
        "id",
        "title",
        "description",
        "links",
        "tags",
        "status",
        "sort_order",
        "published",
        "created_at",
        "updated_at",
      ],
    ],
    [
      "/v1/posts",
      [
        "id",
        "slug",
        "title",
        "summary",
        "content",
        "tags",
        "published_at",
        "pinned",
        "published",
        "created_at",
        "updated_at",
      ],
    ],
    [
      "/v1/photos",
      [
        "id",
        "title",
        "description",
        "url",
        "thumb_url",
        "width",
        "height",
        "shot_at",
        "camera",
        "lens",
        "settings",
        "location",
        "tags",
        "published",
        "created_at",
        "updated_at",
      ],
    ],
    [
      "/v1/experience",
      [
        "id",
        "company",
        "role",
        "location",
        "start_date",
        "end_date",
        "employment_type",
        "description",
        "published",
        "created_at",
        "updated_at",
      ],
    ],
    [
      "/v1/education",
      [
        "id",
        "institution",
        "degree",
        "field",
        "start_date",
        "end_date",
        "description",
        "published",
        "created_at",
        "updated_at",
      ],
    ],
    [
      "/v1/skills",
      ["id", "category", "items", "published", "created_at", "updated_at"],
    ],
    [
      "/v1/now",
      [
        "id",
        "focus",
        "status",
        "availability",
        "mood",
        "current_song",
        "learning",
        "projects",
        "life",
        "reading_goal",
        "last_updated",
        "updated_at",
      ],
    ],
    [
      "/v1/uses",
      [
        "id",
        "category",
        "name",
        "url",
        "note",
        "published",
        "created_at",
        "updated_at",
      ],
    ],
    [
      "/v1/settings",
      ["id", "public_fields", "theme", "flags", "shelf_config", "updated_at"],
    ],
    [
      "/v1/shelf",
      [
        "id",
        "type",
        "title",
        "quote",
        "author",
        "source",
        "url",
        "note",
        "image_url",
        "drawer",
        "tags",
        "date_added",
        "published",
        "status",
        "rating",
        "rating_scale",
        "started_at",
        "completed_at",
        "last_watched_at",
        "progress_current",
        "progress_total",
        "progress_unit",
        "favorite_rank",
        "showcase",
        "metadata",
        "shelf_group",
        "display_order",
        "cover_override_url",
        "spine_image_url",
        "goodreads_id",
        "isbn",
        "apple_books_id",
        "created_at",
        "updated_at",
      ],
    ],
    ["/v1/github", ["start", "end", "daily", "repos"]],
    [
      "/v1/wakatime",
      ["start", "end", "days", "languages", "projects", "editors"],
    ],
    ["/v1/wakatime/hourly", ["start", "end", "hours"]],
  ])("declares the existing fields for GET %s", (path, fields) => {
    const schema = itemOrObjectSchema(path);
    expect(schema.properties).toBeDefined();
    for (const field of fields) {
      expect(schema.properties).toHaveProperty(field);
    }
  });

  it("declares nested fields consumed by the website", () => {
    const profile = responseSchema("/v1/profile");
    expect(property(profile, "handles").properties).toEqual(
      expect.objectContaining({
        github: expect.any(Object),
        linkedin: expect.any(Object),
        twitter: expect.any(Object),
      })
    );
    expect(property(profile, "contact").properties).toEqual(
      expect.objectContaining({ email: expect.any(Object) })
    );

    const now = responseSchema("/v1/now");
    const nowProject = resolveSchema(property(now, "projects").items!);
    expect(nowProject.properties).toEqual(
      expect.objectContaining({
        name: expect.any(Object),
        status: expect.any(Object),
        description: expect.any(Object),
      })
    );

    const settings = responseSchema("/v1/settings");
    const sections = property(property(settings, "shelf_config"), "sections");
    for (const section of [
      "links",
      "quotes",
      "visuals",
      "wallpapers",
      "books",
      "movies",
      "shows",
    ]) {
      expect(property(sections, section).properties).toHaveProperty("visible");
    }

    const githubDaily = resolveSchema(property(responseSchema("/v1/github"), "daily").items!);
    expect(githubDaily.properties).toEqual(
      expect.objectContaining({
        date: expect.any(Object),
        count: expect.any(Object),
        personal_count: expect.any(Object),
        work_count: expect.any(Object),
      })
    );

    const wakatime = responseSchema("/v1/wakatime");
    expect(
      resolveSchema(property(wakatime, "languages").items!).properties
    ).toEqual(
      expect.objectContaining({
        date: expect.any(Object),
        name: expect.any(Object),
        total_seconds: expect.any(Object),
        total_minutes: expect.any(Object),
        percent: expect.any(Object),
      })
    );

    const hour = resolveSchema(
      property(responseSchema("/v1/wakatime/hourly"), "hours").items!
    );
    expect(hour.properties).toEqual(
      expect.objectContaining({
        date: expect.any(Object),
        hour: expect.any(Object),
        seconds: expect.any(Object),
        languages: expect.any(Object),
      })
    );
    expect(property(hour, "languages").additionalProperties).toEqual({
      type: "number",
    });
  });

  it("distinguishes normalized booleans from raw D1 integer flags", () => {
    expect(property(itemOrObjectSchema("/v1/posts"), "published")).toMatchObject({
      type: "boolean",
    });
    expect(property(itemOrObjectSchema("/v1/shelf"), "showcase")).toMatchObject({
      type: "boolean",
    });
    expect(property(itemOrObjectSchema("/v1/projects"), "published")).toMatchObject({
      type: "integer",
      enum: [0, 1],
    });
  });

  it("documents singleton fallbacks and nullable database values", () => {
    const profile = responseSchema("/v1/profile");
    expect(profile.required ?? []).not.toContain("name");

    const now = responseSchema("/v1/now");
    expect(now.required ?? []).not.toContain("focus");

    const project = itemOrObjectSchema("/v1/projects");
    expect(project.required).toEqual(expect.arrayContaining(["id", "title", "description"]));
    expect(property(project, "description")).toMatchObject({
      type: "string",
      nullable: true,
    });
  });
});
