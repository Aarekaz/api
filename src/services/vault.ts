import type { Env } from "../types/env";

// The Obsidian vault lives in a private GitHub repo. These helpers let the
// native apps (and later the web OS) read and write it through this API, so
// clients only ever hold the API token. The GitHub token stays a Worker secret.

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "Aarekaz/vault";
const DEFAULT_BRANCH = "main";

export interface VaultFile {
  path: string;
  sha: string;
  size: number;
}

export class VaultError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 | 502 | 503) {
    super(message);
  }
}

export function vaultConfig(env: Env) {
  if (!env.VAULT_GITHUB_TOKEN) {
    throw new VaultError("VAULT_GITHUB_TOKEN is not configured", 503);
  }
  return {
    token: env.VAULT_GITHUB_TOKEN,
    repo: env.VAULT_REPO || DEFAULT_REPO,
    branch: env.VAULT_BRANCH || DEFAULT_BRANCH,
  };
}

/** Only Markdown paths inside the vault. No traversal, no absolute paths, no git internals. */
export function isValidVaultPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) return false;
  return path.endsWith(".md");
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUtf8(encoded: string): string {
  const binary = atob(encoded.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function github(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = vaultConfig(env);
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "anurag-os-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

async function failFrom(response: Response, what: string): Promise<never> {
  if (response.status === 404) throw new VaultError(`${what}: not found`, 404);
  if (response.status === 409 || response.status === 422) {
    throw new VaultError(`${what}: the file changed since you loaded it`, 409);
  }
  throw new VaultError(`${what}: GitHub answered ${response.status}`, 502);
}

/** Every Markdown file on the branch, with its blob sha. One request. */
export async function listVault(env: Env): Promise<{ tree_sha: string; files: VaultFile[] }> {
  const { repo, branch } = vaultConfig(env);
  const response = await github(env, `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!response.ok) return failFrom(response, "List vault");
  const body = (await response.json()) as {
    sha: string;
    truncated?: boolean;
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  };
  const files = body.tree
    .filter((entry) => entry.type === "blob" && isValidVaultPath(entry.path))
    .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
  return { tree_sha: body.sha, files };
}

/**
 * File contents by blob sha. A blob never changes for a given sha, so each
 * one is cached at the edge and only fetched from GitHub once.
 */
export async function readBlobs(env: Env, shas: string[]): Promise<Record<string, string>> {
  const { repo } = vaultConfig(env);
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const result: Record<string, string> = {};
  const queue = [...new Set(shas)];

  async function worker() {
    while (queue.length > 0) {
      const sha = queue.shift()!;
      const cacheKey = new Request(`https://vault-blob.cache/${repo}/${sha}`);
      const cached = await cache?.match(cacheKey);
      if (cached) {
        result[sha] = await cached.text();
        continue;
      }
      const response = await github(env, `/repos/${repo}/git/blobs/${sha}`);
      if (!response.ok) return failFrom(response, `Read blob ${sha}`);
      const blob = (await response.json()) as { content: string; encoding: string };
      const text = blob.encoding === "base64" ? base64ToUtf8(blob.content) : blob.content;
      result[sha] = text;
      await cache?.put(cacheKey, new Response(text, {
        headers: { "Cache-Control": "private, max-age=31536000, immutable" },
      }));
    }
  }

  // A few at a time keeps us well inside GitHub's and Workers' limits.
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  return result;
}

export async function readFile(env: Env, path: string): Promise<{ path: string; sha: string; content: string }> {
  const { repo, branch } = vaultConfig(env);
  const response = await github(env, `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
  if (!response.ok) return failFrom(response, `Read ${path}`);
  const body = (await response.json()) as { sha: string; content?: string; type: string };
  if (body.type !== "file" || body.content === undefined) throw new VaultError(`${path} is not a file`, 400);
  return { path, sha: body.sha, content: base64ToUtf8(body.content) };
}

/**
 * Writes a file as one commit. Pass the sha you loaded; if the file changed
 * since (Obsidian or an agent got there first), this fails with 409 instead of
 * overwriting. Pass `sha: null` to create a new file.
 */
export async function writeFile(
  env: Env,
  input: { path: string; content: string; sha: string | null; message?: string },
): Promise<{ path: string; sha: string; commit: string }> {
  const { repo, branch } = vaultConfig(env);
  const response = await github(env, `/repos/${repo}/contents/${encodePath(input.path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: input.message || `anurag.os: edit ${input.path}`,
      content: utf8ToBase64(input.content),
      branch,
      ...(input.sha ? { sha: input.sha } : {}),
    }),
  });
  if (!response.ok) return failFrom(response, `Save ${input.path}`);
  const body = (await response.json()) as { content: { sha: string }; commit: { sha: string } };
  return { path: input.path, sha: body.content.sha, commit: body.commit.sha };
}

export const DUMP_PATH = "Dump.md";

/** Adds a bullet to the `## Inbox` section, replacing an empty `- ` placeholder. */
export function insertIntoInbox(text: string, item: string): string {
  const lines = text.split("\n");
  const inbox = lines.findIndex((line) => line.trim().toLowerCase() === "## inbox");
  if (inbox === -1) {
    return `${text}${text.endsWith("\n") ? "" : "\n"}\n## Inbox\n\n- ${item}\n`;
  }
  let insertAt = inbox + 1;
  for (let i = inbox + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const line = lines[i].trim();
    if (line === "-" || line === "- ") {
      lines[i] = `- ${item}`;
      return lines.join("\n");
    }
    if (line.startsWith("- ") || line.startsWith("* ")) insertAt = i + 1;
    else if (line === "" && insertAt === inbox + 1) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `- ${item}`);
  return lines.join("\n");
}

/** Capture a line into Dump.md. Retries once if Obsidian committed in between. */
export async function capture(env: Env, text: string): Promise<{ sha: string }> {
  const item = text.replace(/\s*\n\s*/g, " ").trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    let current: { sha: string | null; content: string };
    try {
      const file = await readFile(env, DUMP_PATH);
      current = { sha: file.sha, content: file.content };
    } catch (error) {
      if (error instanceof VaultError && error.status === 404) current = { sha: null, content: "# Dump\n" };
      else throw error;
    }
    try {
      const saved = await writeFile(env, {
        path: DUMP_PATH,
        content: insertIntoInbox(current.content, item),
        sha: current.sha,
        message: "anurag.os: capture to Dump",
      });
      return { sha: saved.sha };
    } catch (error) {
      if (!(error instanceof VaultError) || error.status !== 409 || attempt === 1) throw error;
    }
  }
  throw new VaultError("Capture failed", 500);
}
