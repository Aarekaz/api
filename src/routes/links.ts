import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { DocumentError } from "../services/documents";
import {
  fetchArticle, getLink, linkTags, listLinks, markRead, presentLink, readingOf, saveLink, saveProgress, setLinkNote, updateLink,
  type LinkListState,
} from "../services/links";

// /v1/links: read later. Every link lands in the Inbox; archiving it (when
// you've finished) moves it to the Archive. Progress and a note per article
// sync between devices. Deleting a link is DELETE /v1/documents/:id (soft, with
// restore). Every field added since v1 is additive, so older clients keep working.

const app = new Hono<{ Bindings: Env }>();

const STATES = ["unread", "read", "starred", "all", "inbox", "archived"] as const;
const Tag = z.string().trim().max(40).transform((t) => t.replace(/^#+/, "").toLowerCase());

const UpdateLink = z.object({
  starred: z.boolean().optional(),
  tags: z.array(Tag).max(30).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  state: z.enum(["inbox", "archived"]).optional(),
  note: z.string().max(20_000).nullable().optional(),
});

const Progress = z.object({
  progress: z.number().min(0).max(1),
  anchor: z.string().max(500).nullish(),
  /** When you were there (the device's clock), for last-write-wins. Defaults to now. */
  updated_at: z.string().datetime({ offset: true }).optional(),
  device: z.string().trim().max(60).nullish(),
});

const SaveLink = z.object({ url: z.string().min(1).max(4000) });

/** One error shape: { error: { code, message } }. */
function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof z.ZodError) {
    return c.json({ error: { code: "invalid", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
  }
  if (error instanceof DocumentError) {
    const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
    return c.json({ error: { code, message: error.message } }, error.status);
  }
  console.error("links route failed", error);
  return c.json({ error: { code: "server", message: "Links request failed" } }, 500);
}

const invalidJson = (c: Context<{ Bindings: Env }>) => c.json({ error: { code: "invalid", message: "Invalid JSON" } }, 400);

/** GET /v1/links?state=inbox|archived|starred|all (unread/read still work)&tag=&limit= */
app.get("/", async (c) => {
  const raw = c.req.query("state");
  const state: LinkListState = (STATES as readonly string[]).includes(raw ?? "") ? raw as LinkListState : "all";
  try {
    const rows = await listLinks(c.env, state, Number(c.req.query("limit")) || undefined, c.req.query("tag") || undefined);
    return c.json({ links: rows.map((row) => presentLink(row)) });
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/links/tags: every tag with how many links carry it (and how many are in the Inbox). */
app.get("/tags", async (c) => {
  try {
    return c.json({ items: await linkTags(c.env) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return c.json({ error: { code: "invalid", message: "url is required" } }, 400);
  try {
    const { url } = SaveLink.parse(body);
    return c.json(presentLink(await saveLink(c.env, url), true), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/:id", async (c) => {
  try {
    return c.json(presentLink(await getLink(c.env, c.req.param("id")), true));
  } catch (error) {
    return fail(c, error);
  }
});

/** PATCH /v1/links/:id { starred?, tags?, title?, state?, note? } */
app.patch("/:id", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  const id = c.req.param("id");
  try {
    const input = UpdateLink.parse(body);
    const current = await getLink(c.env, id);
    if (input.starred !== undefined || input.tags !== undefined || input.title !== undefined) {
      await updateLink(c.env, id, { starred: input.starred, tags: input.tags, title: input.title });
    }
    if (input.state && (input.state === "archived") !== (current.read_at !== null)) {
      await markRead(c.env, id, input.state === "archived");
    }
    if (input.note !== undefined) await setLinkNote(c.env, id, input.note);
    return c.json(presentLink(await getLink(c.env, id)));
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/links/:id/progress: where you are, without the article's text. */
app.get("/:id/progress", async (c) => {
  try {
    return c.json(readingOf(await getLink(c.env, c.req.param("id"))));
  } catch (error) {
    return fail(c, error);
  }
});

/** PUT /v1/links/:id/progress { progress, anchor?, updated_at?, device? }: last write wins by updated_at. */
app.put("/:id/progress", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  try {
    return c.json(await saveProgress(c.env, c.req.param("id"), Progress.parse(body)));
  } catch (error) {
    return fail(c, error);
  }
});

// Archive when you've finished; bring it back to the Inbox. /read and /unread are the older names.
for (const [path, archived] of [["archive", true], ["read", true], ["unarchive", false], ["unread", false]] as const) {
  app.post(`/:id/${path}`, async (c) => {
    try {
      return c.json(presentLink(await markRead(c.env, c.req.param("id"), archived)));
    } catch (error) {
      return fail(c, error);
    }
  });
}

app.post("/:id/refetch", async (c) => {
  try {
    return c.json(presentLink(await fetchArticle(c.env, c.req.param("id")), true));
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
