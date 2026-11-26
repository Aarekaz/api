import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import {
  authSecurity,
  structuredOkResponses,
  openApiJsonRequestBody,
  openApiRegistry,
  openApiResponse,
  structuredErrorSchema,
} from "../schemas/openapi";
import { appErrors, fail } from "../lib/http";
import { firstMessage, parseJsonAs } from "../utils/json";
import {
  capture,
  isValidVaultPath,
  listVault,
  readBlobs,
  readFile,
  writeFile,
} from "../services/vault";

// /v1/vault: the Obsidian vault (private GitHub repo) for the native apps.
// Clients sync by comparing blob shas from /tree with what they have cached,
// then fetch only changed files through /blobs. Errors are the one shape
// (lib/http.ts); a VaultError carries its status.

const app = appErrors(new Hono<{ Bindings: Env }>(), "Vault request");
const MAX_BLOBS_PER_REQUEST = 100;
const MAX_FILE_BYTES = 1_000_000;
const SHA = /^[0-9a-f]{40}$/;

// Each body answers with its own fixed messages; a file write names the first
// field that is wrong, in the order path, content, sha.
const BlobsBody = z.object({ shas: z.array(z.string().regex(SHA)).min(1).max(MAX_BLOBS_PER_REQUEST) });
const INVALID_PATH = "Invalid vault path";
const BAD_CONTENT = "content must be a string under 1 MB";
const BAD_SHA = "sha must be the blob sha you loaded, or null for a new file";
const FileBody = z.object({
  path: z.custom<string>(isValidVaultPath, { message: INVALID_PATH }),
  content: z.string({ invalid_type_error: BAD_CONTENT, required_error: BAD_CONTENT }).max(MAX_FILE_BYTES, BAD_CONTENT),
  sha: z.string({ invalid_type_error: BAD_SHA }).regex(SHA, BAD_SHA).nullish(),
  message: z.unknown().transform((m) => (typeof m === "string" && m.trim() ? `anurag.os: ${m.trim().slice(0, 120)}` : undefined)),
});
const CaptureBody = z.object({ text: z.string().transform((t) => t.trim()).pipe(z.string().min(1).max(2000)) });

// OpenAPI registrations
const vaultErrors = {
  404: openApiResponse(structuredErrorSchema, "Not found"),
  409: openApiResponse(structuredErrorSchema, "Conflict (the file changed on GitHub)"),
  502: openApiResponse(structuredErrorSchema, "GitHub request failed"),
  503: openApiResponse(structuredErrorSchema, "Vault is not configured"),
};
const blobSha = z.string().regex(/^[0-9a-f]{40}$/);

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/vault/tree",
  summary: "List every file in the vault with its blob sha",
  security: authSecurity,
  responses: {
    ...structuredOkResponses(z.object({
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
    ...structuredOkResponses(z.object({
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
    ...structuredOkResponses(z.object({ path: z.string(), sha: z.string(), content: z.string() })),
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
    ...structuredOkResponses(z.object({ path: z.string(), sha: z.string(), commit: z.string() })),
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
    ...structuredOkResponses(z.object({ ok: z.boolean(), sha: z.string() })),
    ...vaultErrors,
  },
});

app.get("/tree", async (c) => c.json(await listVault(c.env)));

app.post("/blobs", async (c) => {
  const parsed = await parseJsonAs(c.req.raw, BlobsBody);
  if (!parsed.success) return fail(c, 400, `Send "shas": 1 to ${MAX_BLOBS_PER_REQUEST} blob shas`);
  return c.json({ blobs: await readBlobs(c.env, parsed.data.shas) });
});

app.get("/file", async (c) => {
  const path = c.req.query("path");
  if (!isValidVaultPath(path)) return fail(c, 400, INVALID_PATH);
  return c.json(await readFile(c.env, path));
});

app.put("/file", async (c) => {
  const parsed = await parseJsonAs(c.req.raw, FileBody);
  if (!parsed.success) return fail(c, 400, firstMessage(parsed.error, INVALID_PATH));
  const { path, content, sha, message } = parsed.data;
  return c.json(await writeFile(c.env, { path, content, sha: sha ?? null, message }));
});

app.post("/capture", async (c) => {
  const parsed = await parseJsonAs(c.req.raw, CaptureBody);
  if (!parsed.success) return fail(c, 400, "text is required (up to 2000 characters)");
  return c.json({ ok: true, ...(await capture(c.env, parsed.data.text)) });
});

export default app;
