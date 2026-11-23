import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import vaultRoute from "../../routes/vault";
import { base64ToUtf8, insertIntoInbox, isValidVaultPath, utf8ToBase64 } from "../../services/vault";

const env = { VAULT_GITHUB_TOKEN: "test-token" } as Env;
const sha = (n: number) => n.toString(16).padStart(40, "0");

function mockGitHub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("vault helpers", () => {
  it("accepts only Markdown paths inside the vault", () => {
    expect(isValidVaultPath("Core/North Star.md")).toBe(true);
    expect(isValidVaultPath("Dump.md")).toBe(true);
    expect(isValidVaultPath("../secrets.md")).toBe(false);
    expect(isValidVaultPath("/etc/passwd.md")).toBe(false);
    expect(isValidVaultPath(".git/config.md")).toBe(false);
    expect(isValidVaultPath("Core//x.md")).toBe(false);
    expect(isValidVaultPath("Utilities/Attachments/photo.png")).toBe(false);
    expect(isValidVaultPath(undefined)).toBe(false);
  });

  it("round-trips UTF-8 through base64", () => {
    const text = "Recovery is 71% — “good” ✓ नमस्ते";
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });

  it("captures into the Inbox, replacing the empty placeholder", () => {
    const dump = "# Dump\n\n## Inbox\n\n- \n\n## Processing Rule\n\n- **Core** if…\n";
    const once = insertIntoInbox(dump, "first");
    const twice = insertIntoInbox(once, "second");
    expect(twice).toContain("## Inbox\n\n- first\n- second\n\n## Processing Rule");
    expect(insertIntoInbox("# Dump\n", "x")).toBe("# Dump\n\n## Inbox\n\n- x\n");
  });
});

describe("vault route", () => {
  it("is unavailable until the GitHub token is set", async () => {
    const res = await vaultRoute.request("/tree", {}, {} as Env);
    expect(res.status).toBe(503);
  });

  it("lists only Markdown files from the tree", async () => {
    const calls = mockGitHub(() => json({
      sha: sha(1),
      tree: [
        { path: "Core", type: "tree", sha: sha(2) },
        { path: "Core/North Star.md", type: "blob", sha: sha(3), size: 120 },
        { path: "Utilities/Attachments/a.png", type: "blob", sha: sha(4), size: 9000 },
        { path: ".obsidian/app.json", type: "blob", sha: sha(5), size: 10 },
      ],
    }));
    const res = await vaultRoute.request("/tree", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree_sha: string; files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(["Core/North Star.md"]);
    expect(calls[0].url).toBe("https://api.github.com/repos/Aarekaz/vault/git/trees/main?recursive=1");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("returns blobs decoded as text", async () => {
    mockGitHub((url) => json({ content: utf8ToBase64(`note for ${url.slice(-4)}`), encoding: "base64" }));
    const res = await vaultRoute.request("/blobs", { method: "POST", body: JSON.stringify({ shas: [sha(7), sha(8)] }) }, env);
    const body = (await res.json()) as { blobs: Record<string, string> };
    expect(body.blobs[sha(7)]).toBe("note for 0007");
    expect(Object.keys(body.blobs)).toHaveLength(2);
  });

  it("rejects bad blob requests", async () => {
    const res = await vaultRoute.request("/blobs", { method: "POST", body: JSON.stringify({ shas: ["nope"] }) }, env);
    expect(res.status).toBe(400);
  });

  it("saves with the loaded sha and reports conflicts as 409", async () => {
    const calls = mockGitHub(() => json({ message: "sha does not match" }, 409));
    const res = await vaultRoute.request("/file", {
      method: "PUT",
      body: JSON.stringify({ path: "Core/North Star.md", content: "new", sha: sha(3), message: "edit North Star" }),
    }, env);
    expect(res.status).toBe(409);
    const sent = JSON.parse(String(calls[0].init.body)) as { sha: string; message: string; branch: string; content: string };
    expect(sent.sha).toBe(sha(3));
    expect(sent.branch).toBe("main");
    expect(sent.message).toBe("anurag.os: edit North Star");
    expect(base64ToUtf8(sent.content)).toBe("new");
  });

  it("refuses to write outside the vault", async () => {
    const res = await vaultRoute.request("/file", {
      method: "PUT",
      body: JSON.stringify({ path: "../x.md", content: "x", sha: null }),
    }, env);
    expect(res.status).toBe(400);
  });

  it("captures to Dump and retries once on a conflict", async () => {
    let puts = 0;
    const calls = mockGitHub((url, init) => {
      if (init.method === "PUT") {
        puts += 1;
        return puts === 1 ? json({}, 409) : json({ content: { sha: sha(9) }, commit: { sha: sha(10) } });
      }
      return json({ type: "file", sha: sha(6), content: utf8ToBase64("# Dump\n\n## Inbox\n\n- \n") });
    });
    const res = await vaultRoute.request("/capture", { method: "POST", body: JSON.stringify({ text: "Idea:\nweekly email" }) }, env);
    expect(res.status).toBe(200);
    expect(puts).toBe(2);
    const lastPut = calls.filter((c) => c.init.method === "PUT").at(-1)!;
    expect(base64ToUtf8(JSON.parse(String(lastPut.init.body)).content)).toBe("# Dump\n\n## Inbox\n\n- Idea: weekly email\n");
  });
});
