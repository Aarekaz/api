import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";

export async function fetchLanyardStatus(env: Env): Promise<JsonRecord | null> {
  if (!env.LANYARD_USER_ID) {
    return null;
  }

  const response = await fetch(
    `https://api.lanyard.rest/v1/users/${env.LANYARD_USER_ID}`
  );
  
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    data?: {
      discord_status?: string;
      activities?: unknown[];
      spotify?: unknown;
    };
  };

  return payload.data ?? null;
}

export async function saveStatusSnapshot(env: Env, data: JsonRecord): Promise<string> {
  const activity = Array.isArray(data.activities) ? data.activities[0] : null;
  const createdAt = nowIso();

  await env.DB.prepare(
    `INSERT INTO status_snapshots (discord_status, activity_json, spotify_json, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      data.discord_status ?? null,
      mapJsonField(activity),
      mapJsonField(data.spotify ?? null),
      mapJsonField(data),
      createdAt
    )
    .run();

  return createdAt;
}
