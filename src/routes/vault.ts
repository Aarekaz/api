import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import {
  VaultError,
  capture,
  isValidVaultPath,
  listVault,
  readBlobs,
  readFile,
  writeFile,
} from "../services/vault";

// /v1/vault: the Obsidian vault (private GitHub repo) for the native apps.
// Clients sync by comparing blob shas from /tree with what they have cached,
// then fetch only changed files through /blobs.

const app = new Hono<{ Bindings: Env }>();
const MAX_BLOBS_PER_REQUEST = 100;
const MAX_FILE_BYTES = 1_000_000;

function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof VaultError) return c.json({ error: error.message }, error.status);
  console.error("vault route failed", error);
  return c.json({ error: "Vault request failed" }, 500);
}

app.get("/tree", async (c) => {
  try {
    return c.json(await listVault(c.env));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/blobs", async (c) => {
  const body = (await parseJson(c.req.raw)) as { shas?: unknown } | null;
  const shas = body?.shas;
  if (!Array.isArray(shas) || shas.length === 0 || shas.length > MAX_BLOBS_PER_REQUEST
    || !shas.every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))) {
    return c.json({ error: `Send "shas": 1 to ${MAX_BLOBS_PER_REQUEST} blob shas` }, 400);
  }
  try {
    return c.json({ blobs: await readBlobs(c.env, shas as string[]) });
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/file", async (c) => {
  const path = c.req.query("path");
  if (!isValidVaultPath(path)) return c.json({ error: "Invalid vault path" }, 400);
  try {
    return c.json(await readFile(c.env, path));
  } catch (error) {
    return fail(c, error);
  }
});

app.put("/file", async (c) => {
  const body = (await parseJson(c.req.raw)) as
    | { path?: unknown; content?: unknown; sha?: unknown; message?: unknown }
    | null;
  if (!body || !isValidVaultPath(body.path)) return c.json({ error: "Invalid vault path" }, 400);
  if (typeof body.content !== "string" || body.content.length > MAX_FILE_BYTES) {
    return c.json({ error: "content must be a string under 1 MB" }, 400);
  }
  if (body.sha !== null && body.sha !== undefined && (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha))) {
    return c.json({ error: "sha must be the blob sha you loaded, or null for a new file" }, 400);
  }
  const message = typeof body.message === "string" && body.message.trim()
    ? `anurag.os: ${body.message.trim().slice(0, 120)}`
    : undefined;
  try {
    return c.json(await writeFile(c.env, {
      path: body.path,
      content: body.content,
      sha: (body.sha as string | null | undefined) ?? null,
      message,
    }));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/capture", async (c) => {
  const body = (await parseJson(c.req.raw)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 2000) return c.json({ error: "text is required (up to 2000 characters)" }, 400);
  try {
    return c.json({ ok: true, ...(await capture(c.env, text)) });
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
