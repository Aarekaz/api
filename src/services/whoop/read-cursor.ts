export const WHOOP_READ_CURSOR_MAX_LENGTH = 1024;
export const WHOOP_READ_ORDER = "provider_time_desc_id_desc" as const;

export type WhoopCursorResource = "cycles" | "recoveries" | "sleeps" | "workouts";

export interface WhoopReadAnchor {
  sortAt: string;
  id: string;
}

interface CursorPayload {
  version: 1;
  resource: WhoopCursorResource;
  start: string | null;
  end: string | null;
  order: typeof WHOOP_READ_ORDER;
  anchor: {
    sort_at: string;
    id: string;
  };
}

interface CursorEnvelope {
  payload: CursorPayload;
  signature: string;
}

const encoder = new TextEncoder();

const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const base64UrlDecode = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = atob(base64);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (base64UrlEncode(bytes) !== value) return null;
    return bytes;
  } catch {
    return null;
  }
};

const sign = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`whoop-read-cursor:v1:${payload}`),
  )));
};

const sameString = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 30) return false;
  const milliseconds = Date.parse(value);
  return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const validId = (resource: WhoopCursorResource, value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 64) return false;
  if (resource === "cycles") return /^(?:[1-9][0-9]*)$/.test(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
};

const parsePayload = (value: unknown): CursorPayload | null => {
  const payload = recordOf(value);
  if (!payload || !exactKeys(payload, ["version", "resource", "start", "end", "order", "anchor"])) return null;
  if (payload.version !== 1
    || !["cycles", "recoveries", "sleeps", "workouts"].includes(String(payload.resource))
    || payload.order !== WHOOP_READ_ORDER) return null;
  const resource = payload.resource as WhoopCursorResource;
  const start = payload.start;
  const end = payload.end;
  if (!(start === null || isCanonicalTimestamp(start))
    || !(end === null || isCanonicalTimestamp(end))) return null;
  const anchor = recordOf(payload.anchor);
  if (!anchor || !exactKeys(anchor, ["sort_at", "id"])
    || !isCanonicalTimestamp(anchor.sort_at)
    || !validId(resource, anchor.id)) return null;
  return {
    version: 1,
    resource,
    start: start as string | null,
    end: end as string | null,
    order: WHOOP_READ_ORDER,
    anchor: { sort_at: anchor.sort_at, id: anchor.id },
  };
};

export const encodeWhoopReadCursor = async (
  secret: string,
  resource: WhoopCursorResource,
  start: string | null,
  end: string | null,
  anchor: WhoopReadAnchor,
): Promise<string> => {
  const payload: CursorPayload = {
    version: 1,
    resource,
    start,
    end,
    order: WHOOP_READ_ORDER,
    anchor: { sort_at: anchor.sortAt, id: anchor.id },
  };
  const serializedPayload = JSON.stringify(payload);
  const envelope: CursorEnvelope = {
    payload,
    signature: await sign(secret, serializedPayload),
  };
  return base64UrlEncode(encoder.encode(JSON.stringify(envelope)));
};

export const decodeWhoopReadCursor = async (
  value: string,
  secret: string,
  resource: WhoopCursorResource,
  start: string | null,
  end: string | null,
): Promise<WhoopReadAnchor | null> => {
  if (value.length === 0 || value.length > WHOOP_READ_CURSOR_MAX_LENGTH) return null;
  const decoded = base64UrlDecode(value);
  if (!decoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  const envelope = recordOf(parsed);
  if (!envelope || !exactKeys(envelope, ["payload", "signature"])
    || typeof envelope.signature !== "string" || envelope.signature.length !== 43) return null;
  const payload = parsePayload(envelope.payload);
  if (!payload || payload.resource !== resource || payload.start !== start || payload.end !== end) return null;
  const expected = await sign(secret, JSON.stringify(payload));
  if (!sameString(envelope.signature, expected)) return null;
  return { sortAt: payload.anchor.sort_at, id: payload.anchor.id };
};
