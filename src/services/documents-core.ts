// Pure helpers for documents: no Worker bindings, so the import script and
// tests can use them directly.

export type DocumentKind = "note" | "journal" | "writing" | "link" | "quote";
export type Visibility = "locked" | "private" | "agents" | "public";
export type DocumentStatus = "draft" | "published";

export const KINDS: DocumentKind[] = ["note", "journal", "writing", "link", "quote"];
export const VISIBILITIES: Visibility[] = ["locked", "private", "agents", "public"];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Sortable unique id (ULID). */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const byte of random) rand += CROCKFORD[byte % 32];
  return time + rand;
}

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

/** Slug without a leading date like `2026-05-29-`. */
export function stripDatePrefix(slug: string): string {
  return slug.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Flat YAML frontmatter, kept as raw strings (nested values kept verbatim). */
export function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const header = normalized.slice(4, end);
  const after = normalized.slice(end + 4).replace(/^\n/, "");
  const frontmatter: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of header.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match && !line.startsWith(" ")) {
      lastKey = match[1];
      frontmatter[lastKey] = match[2].replace(/^["']|["']$/g, "");
    } else if (lastKey) {
      frontmatter[lastKey] += "\n" + line;
    }
  }
  return { frontmatter, body: after };
}


/** Same rules the apps used for the vault, so nothing changes meaning on import. */
export function classify(path: string, frontmatter: Record<string, string>): {
  kind: DocumentKind;
  visibility: Visibility;
  status: DocumentStatus | null;
  folder: string;
} {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  let kind: DocumentKind = "note";
  const declared = frontmatter.kind?.toLowerCase();
  if (declared && (KINDS as string[]).includes(declared)) kind = declared as DocumentKind;
  else if (path.startsWith("Core/Journal/")) kind = "journal";
  else if ((path.startsWith("Writing/Drafts/") || path.startsWith("Writing/Published/")) && !path.endsWith("/Log.md")) kind = "writing";

  let status: DocumentStatus | null = null;
  if (kind === "writing") {
    const raw = frontmatter.status?.toLowerCase();
    status = raw === "published" || raw === "draft" ? raw : path.startsWith("Writing/Published/") ? "published" : "draft";
  }

  let visibility: Visibility = "agents";
  if (kind === "journal" || path.startsWith("Finances/")) visibility = "locked";
  else if (status === "published") visibility = "public";
  else {
    const raw = frontmatter.visibility?.toLowerCase();
    if (raw && (VISIBILITIES as string[]).includes(raw)) {
      visibility = kind === "note" && raw === "public" ? "agents" : (raw as Visibility);
    }
  }
  return { kind, visibility, status, folder };
}

/** Find the live post a piece of writing corresponds to. */
export function matchPost<T extends { id: number; slug: string; title: string }>(
  doc: { slug: string; title: string },
  posts: T[],
): T | undefined {
  const slug = stripDatePrefix(doc.slug);
  const title = normalizeTitle(doc.title);
  return (
    posts.find((p) => p.slug === doc.slug || p.slug === slug || stripDatePrefix(p.slug) === slug) ??
    posts.find((p) => normalizeTitle(p.title) === title) ??
    posts.find((p) => title.length > 12 && normalizeTitle(p.title).startsWith(title))
  );
}

/** Markdown for the GitHub backup: frontmatter + body. */
export function toMarkdown(doc: {
  kind: string; title: string; body: string; visibility: string; status: string | null;
  frontmatter_json: string | null; updated_at: string; id: string;
}): string {
  const extra: Record<string, string> = doc.frontmatter_json ? JSON.parse(doc.frontmatter_json) : {};
  const fields: Record<string, string> = {
    ...extra,
    id: doc.id,
    kind: doc.kind,
    visibility: doc.visibility,
    updated: doc.updated_at,
  };
  if (doc.status) fields.status = doc.status;
  const header = Object.entries(fields).map(([k, v]) => (v.includes("\n") ? `${k}:${v}` : `${k}: ${v}`)).join("\n");
  return `---\n${header}\n---\n${doc.body}`;
}

/** Where a document is written in the backup repo. */
export function backupPath(doc: { source: string | null; folder: string; slug: string }): string {
  if (doc.source?.startsWith("vault:")) return doc.source.slice("vault:".length);
  return `${doc.folder ? doc.folder + "/" : ""}${doc.slug}.md`;
}
