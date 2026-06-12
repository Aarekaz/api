export function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, tagValue]) => tagValue !== undefined && tagValue !== null && tagValue !== "")
      .map(([key, tagValue]) => `${key}:${String(tagValue)}`);
  }
  return [];
}

export function getTag(tags: unknown, key: string): string | undefined {
  const prefix = `${key.toLowerCase()}:`;
  return normalizeTags(tags)
    .find((tag) => tag.toLowerCase().startsWith(prefix))
    ?.slice(prefix.length);
}

export function mergeTags(current: unknown, next: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const tag of [...normalizeTags(current), ...next]) {
    const [rawKey] = tag.split(":");
    const key = rawKey.toLowerCase();
    if (key) byKey.set(key, tag);
  }
  return [...byKey.values()];
}
