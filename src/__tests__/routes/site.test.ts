import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import { allMigrations, testD1, type Sqlite } from "../helpers/d1";
import siteRoute from "../../routes/site";
import profileRoute from "../../routes/profile";
import settingsRoute from "../../routes/settings";

type SqliteDatabase = Sqlite;

describe("site control routes", () => {
  let database: SqliteDatabase;
  let env: Env;

  const send = (method: string, path: string, body: unknown) =>
    siteRoute.request(path, { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }, env);
  const getProfile = async () => (await (await profileRoute.request("/", undefined, env)).json()) as Record<string, unknown>;
  const getSettings = async () => (await (await settingsRoute.request("/", undefined, env)).json()) as Record<string, unknown>;

  beforeEach(() => {
    const d1 = testD1({ migrations: "all" });
    database = d1.db;
    env = { DB: d1.DB } as Env;
  });

  afterEach(() => database.close());

  describe("PATCH /profile", () => {
    const seed = () =>
      database
        .prepare(
          `INSERT INTO profile (id, name, bio, handles_json, contact_json, timezone, location, email, website, image_url, image_alt, summary_json, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "Anurag",
          "Builds things.",
          JSON.stringify({ github: "a", linkedin: "b", twitter: "c" }),
          JSON.stringify({ email: "hey@example.com" }),
          "America/New_York",
          "Washington, DC",
          "hey@example.com",
          "https://example.com",
          "https://example.com/me.jpg",
          "A portrait",
          JSON.stringify(["One", "Two"]),
          "2026-01-01T00:00:00.000Z",
        );

    it("changes only the fields sent and keeps the rest", async () => {
      seed();
      const before = await getProfile();
      const response = await send("PATCH", "/profile", { bio: "Builds calm things.", summary: ["One", "Two", "Three"] });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; profile: Record<string, unknown> };
      expect(json.ok).toBe(true);
      expect(json.profile.bio).toBe("Builds calm things.");

      const after = await getProfile();
      expect(after.bio).toBe("Builds calm things.");
      expect(after.summary).toEqual(["One", "Two", "Three"]);
      // Everything else the site reads is untouched, with the same keys.
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      for (const key of ["name", "email", "image_url", "image_alt", "handles", "contact", "location", "website", "timezone"]) {
        expect(after[key]).toEqual(before[key]);
      }
      expect(after.updated_at).not.toBe(before.updated_at);
    });

    it("clears a field with null and replaces handles as a whole", async () => {
      seed();
      const response = await send("PATCH", "/profile", { image_alt: null, handles: { github: "new", linkedin: null } });
      expect(response.status).toBe(200);
      const after = await getProfile();
      expect(after.image_alt).toBeNull();
      expect(after.handles).toEqual({ github: "new", linkedin: null });
      expect(after.name).toBe("Anurag");
    });

    it("creates the profile row when there is none", async () => {
      const response = await send("PATCH", "/profile", { name: "Anurag" });
      expect(response.status).toBe(200);
      expect((await getProfile()).name).toBe("Anurag");
    });

    it("rejects unknown keys, empty bodies, an empty name and bad JSON with the error shape", async () => {
      seed();
      for (const body of [{ nickname: "x" }, {}, { name: "  " }, "{not json"]) {
        const response = await send("PATCH", "/profile", body);
        expect(response.status).toBe(400);
        const json = (await response.json()) as { error: { code: string; message: string } };
        expect(typeof json.error.code).toBe("string");
        expect(typeof json.error.message).toBe("string");
      }
      expect((await getProfile()).bio).toBe("Builds things.");
    });
  });

  describe("PATCH /shelf-sections", () => {
    it("seeds the same defaults GET /v1/settings shows when no row exists", async () => {
      const before = await getSettings();
      const response = await send("PATCH", "/shelf-sections", { books: false });
      expect(response.status).toBe(200);
      const after = await getSettings();
      const config = after.shelf_config as { sections: Record<string, { visible: boolean }>; hiddenItems: unknown[] };
      expect(config.sections).toEqual({
        ...(before.shelf_config as { sections: Record<string, unknown> }).sections,
        books: { visible: false },
      });
      expect(config.hiddenItems).toEqual([]);
      expect(after.public_fields).toEqual([]);
      expect(after.flags).toEqual({});
      expect(Object.keys(after).sort()).toEqual(["flags", "id", "public_fields", "shelf_config", "theme", "updated_at"]);
    });

    it("merges into the stored config and keeps hiddenItems and other settings", async () => {
      database
        .prepare("INSERT INTO settings (id, public_fields_json, theme, flags_json, shelf_config_json, updated_at) VALUES (1, ?, ?, ?, ?, ?)")
        .run(
          JSON.stringify(["email"]),
          "paper",
          JSON.stringify({ beta: true }),
          JSON.stringify({ sections: { links: { visible: true }, quotes: { visible: false } }, hiddenItems: [4, 9], extra: "kept" }),
          "2026-01-01T00:00:00.000Z",
        );
      const response = await send("PATCH", "/shelf-sections", { quotes: true, movies: false, shows: true });
      expect(response.status).toBe(200);
      const after = await getSettings();
      expect(after.public_fields).toEqual(["email"]);
      expect(after.theme).toBe("paper");
      expect(after.flags).toEqual({ beta: true });
      expect(after.shelf_config).toEqual({
        sections: { links: { visible: true }, quotes: { visible: true }, movies: { visible: false }, shows: { visible: true } },
        hiddenItems: [4, 9],
        extra: "kept",
      });
    });

    it("starts from an empty config when the row has none (the site shows everything then)", async () => {
      database
        .prepare("INSERT INTO settings (id, public_fields_json, flags_json, updated_at) VALUES (1, ?, ?, ?)")
        .run("[]", "{}", "2026-01-01T00:00:00.000Z");
      await send("PATCH", "/shelf-sections", { visuals: false });
      expect((await getSettings()).shelf_config).toEqual({ sections: { visuals: { visible: false } } });
    });

    it("rejects unknown sections, non-booleans and empty bodies", async () => {
      for (const body of [{ podcasts: true }, { books: "no" }, {}]) {
        const response = await send("PATCH", "/shelf-sections", body);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid");
      }
      expect(database.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
    });
  });
});
