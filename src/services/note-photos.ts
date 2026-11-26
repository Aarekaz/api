import type { Env } from "../types/env";
import { PHOTO_NAME } from "../lib/private-photos";

// Photos in notes. A note is private, so its photos are too: they live in the
// private bucket as `notes/<name>` and the note's Markdown points at the
// authenticated route that serves them,
//   ![](https://api.anuragd.me/v1/documents/photos/<name>)
// which only the signed-in apps can load. When a piece of writing goes on the
// site, its post gets a public copy of each such photo (`blog/notes/<name>` in
// the public bucket) and the post's Markdown points there instead. The
// document itself keeps the private address, so the note never depends on the
// public copy, and taking the piece off the site leaves the note as it was.

export const NOTE_PHOTO_PREFIX = "notes";
export const NOTE_PHOTO_ROUTE = "/v1/documents/photos/";

/** `notes/<name>` for a name the upload made; null for anything else. */
export function notePhotoRef(nameOrRef: string): string | null {
  const name = nameOrRef.startsWith(`${NOTE_PHOTO_PREFIX}/`) ? nameOrRef.slice(NOTE_PHOTO_PREFIX.length + 1) : nameOrRef;
  return PHOTO_NAME.test(name) ? `${NOTE_PHOTO_PREFIX}/${name}` : null;
}

/** Where the apps read a note photo: this API's own address, authenticated. */
export function notePhotoUrl(base: string, ref: string): string {
  return `${base.replace(/\/$/, "")}${NOTE_PHOTO_ROUTE}${ref.slice(NOTE_PHOTO_PREFIX.length + 1)}`;
}

// `![alt](<any host or none>/v1/documents/photos/<name>)`, with an optional "title".
const PRIVATE_IMAGE = /(!\[[^\]]*\]\(\s*)((?:https?:\/\/[^\s)/]+)?\/v1\/documents\/photos\/([0-9A-Za-z-]{20,80}\.(?:jpg|png|heic|webp)))(\s*(?:"[^"]*")?\s*\))/g;

/** The private photo names a piece of Markdown shows, in order, once each. */
export function privatePhotoNames(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(PRIVATE_IMAGE)].map((m) => m[3]))];
}

/**
 * The post's Markdown for the site: every private note photo copied to the
 * public bucket (once; a copy already there is reused) and pointed at there.
 * A photo whose private original is gone keeps its address (the site shows
 * nothing for it) rather than failing the publish.
 */
export async function publishNotePhotos(env: Env, markdown: string): Promise<string> {
  const names = privatePhotoNames(markdown);
  if (names.length === 0) return markdown;
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  const published = new Map<string, string>();
  for (const name of names) {
    const key = `blog/${NOTE_PHOTO_PREFIX}/${name}`;
    if (!(await env.R2_BUCKET.head(key))) {
      const original = await env.R2_PRIVATE?.get(`${NOTE_PHOTO_PREFIX}/${name}`);
      if (!original) continue;
      await env.R2_BUCKET.put(key, await original.arrayBuffer(), {
        httpMetadata: { contentType: original.httpMetadata?.contentType ?? "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
      });
    }
    published.set(name, `${base}/${key}`);
  }
  return markdown.replace(PRIVATE_IMAGE, (whole, open: string, _url: string, name: string, close: string) => {
    const url = published.get(name);
    return url ? `${open}${url}${close}` : whole;
  });
}
