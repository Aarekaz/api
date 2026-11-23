// One-time (and re-runnable) import of the Obsidian vault into D1 `documents`.
//
//   node scripts/import-vault.ts <vault-folder> [--remote] [--apply]
//
// Without --apply it only prints what it would do. It never overwrites a
// document that already exists (matched by `source`), so running it again
// after editing in the app is safe. Last-edited times come from git history.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  classify, matchPost, shouldImport, slugify, splitFrontmatter, titleFrom, ulid,
} from "../src/services/documents-core.ts";

const [vault, ...flags] = process.argv.slice(2);
if (!vault) throw new Error("usage: node scripts/import-vault.ts <vault-folder> [--remote] [--apply]");
const remote = flags.includes("--remote");
const apply = flags.includes("--apply");
const target = remote ? "--remote" : "--local";

function d1(command: string): unknown[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "personal_api", target, "--json", "--command", command], { encoding: "utf8" });
  return (JSON.parse(out) as Array<{ results: unknown[] }>)[0].results;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith(".")) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function gitDates(path: string): { created: string; updated: string } | null {
  try {
    const out = execFileSync("git", ["-C", vault, "log", "--format=%cI", "--", path], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (out.length === 0) return null;
    return { updated: new Date(out[0]).toISOString(), created: new Date(out[out.length - 1]).toISOString() };
  } catch {
    return null;
  }
}

const sql = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const CHUNK = 60_000; // keep each statement well under D1's 100 KB limit

const posts = d1("SELECT id, slug, title, content, published_at, created_at, updated_at FROM posts") as Array<{ id: number; slug: string; title: string; content: string | null; published_at: string | null; created_at: string | null; updated_at: string | null }>;
const linkedPosts = new Set((d1("SELECT post_id FROM documents WHERE post_id IS NOT NULL") as Array<{ post_id: number }>).map((r) => r.post_id));
const existing = new Set((d1("SELECT source FROM documents WHERE source IS NOT NULL") as Array<{ source: string }>).map((r) => r.source));
const takenSlugs = new Set((d1("SELECT slug FROM documents") as Array<{ slug: string }>).map((r) => r.slug));

const statements: string[] = [];
const counts = { scanned: 0, imported: 0, skippedExisting: 0, matchedPosts: 0, published: 0, byKind: {} as Record<string, number> };

for (const full of walk(vault)) {
  const path = relative(vault, full);
  if (!shouldImport(path)) continue;
  counts.scanned++;
  const source = `vault:${path}`;
  if (existing.has(source)) { counts.skippedExisting++; continue; }

  const { frontmatter, body } = splitFrontmatter(readFileSync(full, "utf8"));
  const title = titleFrom(path, frontmatter, body);
  const { kind, visibility: baseVisibility, status: baseStatus, folder } = classify(path, frontmatter);
  let slug = slugify(path === "Dump.md" ? "dump" : title);
  for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(title)}-${n}`;
  takenSlugs.add(slug);

  let status = baseStatus;
  let visibility = baseVisibility;
  let postId: number | null = null;
  if (kind === "writing") {
    const fileSlug = slugify(path.split("/").pop()!.replace(/\.md$/, ""));
    const post = matchPost({ slug: fileSlug, title }, posts) ?? matchPost({ slug, title }, posts);
    if (post && !linkedPosts.has(post.id)) {
      linkedPosts.add(post.id);
      counts.matchedPosts++;
      postId = post.id;
      status = post.published_at ? "published" : "draft";
      visibility = post.published_at ? "public" : "agents";
    } else {
      // "Published" means on anuragd.me. Pieces published elsewhere stay drafts here.
      status = "draft";
      visibility = "agents";
    }
    if (status === "published") counts.published++;
  }

  const dates = gitDates(path) ?? { created: statSync(full).birthtime.toISOString(), updated: statSync(full).mtime.toISOString() };
  const id = ulid(new Date(dates.created).getTime());
  const fm = Object.keys(frontmatter).length ? JSON.stringify(frontmatter) : null;
  statements.push(
    `INSERT INTO documents (id, kind, folder, title, slug, body, frontmatter_json, visibility, status, post_id, source, created_at, updated_at, version) VALUES (${[
      id, kind, folder, title, slug, body.slice(0, CHUNK), fm, visibility, status, postId, source, dates.created, dates.updated,
    ].map(sql).join(", ")}, 1) ON CONFLICT(source) DO NOTHING;`,
  );
  for (let i = CHUNK; i < body.length; i += CHUNK) {
    statements.push(`UPDATE documents SET body = body || ${sql(body.slice(i, i + CHUNK))} WHERE id = ${sql(id)};`);
  }
  counts.imported++;
  counts.byKind[kind] = (counts.byKind[kind] ?? 0) + 1;
}

// Site posts with no vault file become published writing, linked to their post.
let postsImported = 0;
for (const post of posts) {
  if (linkedPosts.has(post.id) || existing.has(`post:${post.id}`)) continue;
  let slug = slugify(post.slug || post.title);
  for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(post.slug || post.title)}-${n}`;
  takenSlugs.add(slug);
  const body = `# ${post.title}\n\n${post.content ?? ""}`;
  const created = post.published_at ?? post.created_at ?? new Date().toISOString();
  const updated = post.updated_at ?? created;
  const id = ulid(new Date(created).getTime() || Date.now());
  const live = post.published_at ? "published" : "draft";
  statements.push(
    `INSERT INTO documents (id, kind, folder, title, slug, body, frontmatter_json, visibility, status, post_id, source, created_at, updated_at, version) VALUES (${[
      id, "writing", "Writing/Published", post.title, slug, body.slice(0, CHUNK), null, live === "published" ? "public" : "agents", live, post.id, `post:${post.id}`, created, updated,
    ].map(sql).join(", ")}, 1) ON CONFLICT(source) DO NOTHING;`,
  );
  for (let i = CHUNK; i < body.length; i += CHUNK) {
    statements.push(`UPDATE documents SET body = body || ${sql(body.slice(i, i + CHUNK))} WHERE id = ${sql(id)};`);
  }
  postsImported++;
}

console.log(JSON.stringify({ ...counts, postsImported }, null, 2));
if (!apply) {
  console.log("Dry run. Re-run with --apply to write.");
} else if (statements.length > 0) {
  const file = join(tmpdir(), `vault-import-${Date.now()}.sql`);
  writeFileSync(file, statements.join("\n"));
  execFileSync("npx", ["wrangler", "d1", "execute", "personal_api", target, "--file", file, "--yes"], { stdio: "inherit" });
  console.log(`Applied ${statements.length} statements.`);
}
