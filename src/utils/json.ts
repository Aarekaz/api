import type { z } from "zod";

export function mapJsonField(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

export function parseStoredJson(value: unknown): unknown | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function parseJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The request's JSON body checked against `schema` (Zod's safeParse result). A
 * body that isn't JSON is checked as `null`, so it fails like any wrong shape.
 * For routes that answer a bad body with their own fixed message; the rest use
 * `body` (lib/http.ts) or `readBody` (lib/site-http.ts), which word it themselves.
 */
export async function parseJsonAs<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.SafeParseReturnType<z.input<S>, z.output<S>>> {
  return schema.safeParse(await parseJson(request));
}

/** The first problem's own message, or `fallback` when the body as a whole is the wrong shape. */
export function firstMessage(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  return issue && issue.path.length > 0 ? issue.message : fallback;
}
