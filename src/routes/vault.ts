import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import {
  authSecurity,
  errorSchema,
  okResponses,
  openApiJsonRequestBody,
  openApiRegistry,
  openApiResponse,
} from "../schemas/openapi";
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

// OpenAPI registrations
const vaultErrors = {
  404: openApiResponse(errorSchema, "Not found"),
  409: openApiResponse(errorSchema, "Conflict (the file changed on GitHub)"),
  502: openApiResponse(errorSchema, "GitHub request failed"),
  503: openApiResponse(errorSchema, "Vault is not configured"),
};
const blobSha = z.string().regex(/^[0-9a-f]{40}$/);

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/vault/tree",
  summary: "List every file in the vault with its blob sha",
  security: authSecurity,
  responses: {
    ...okResponses(z.object({
      tree_sha: z.string(),
      files: z.array(z.object({ path: z.string(), sha: z.string(), size: z.number().int() })),
    })),
    ...vaultErrors,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/vault/blobs",
  summary: "Read file contents by blob sha",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      shas: z.array(blobSha).min(1).max(MAX_BLOBS_PER_REQUEST),
    })),
  },
  responses: {
    ...okResponses(z.object({
      blobs: z.record(z.string()).openapi({ description: "File contents (UTF-8) keyed by blob sha" }),
    })),
    ...vaultErrors,
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/vault/file",
  summary: "Read one vault file",
  security: authSecurity,
  request: { query: z.object({ path: z.string().openapi({ description: "Path inside the vault" }) }) },
  responses: {
    ...okResponses(z.object({ path: z.string(), sha: z.string(), content: z.string() })),
    ...vaultErrors,
  },
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/vault/file",
  summary: "Create or update one vault file",
  description: "Send the blob sha you loaded (or null for a new file); a stale sha is a 409.",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      path: z.string(),
      content: z.string().max(MAX_FILE_BYTES),
      sha: blobSha.nullable().optional(),
      message: z.string().optional().openapi({ description: "Commit message, prefixed with anurag.os:" }),
    })),
  },
  responses: {
    ...okResponses(z.object({ path: z.string(), sha: z.string(), commit: z.string() })),
    ...vaultErrors,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/vault/capture",
  summary: "Capture a line into the Inbox section of Dump.md",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(z.object({ text: z.string().min(1).max(2000) })) },
  responses: {
    ...okResponses(z.object({ ok: z.boolean(), sha: z.string() })),
    ...vaultErrors,
  },
});

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
