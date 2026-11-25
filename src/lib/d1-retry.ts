import { HttpError } from "./http";

/**
 * D1 errors Cloudflare documents as safe to retry: the database object was
 * restarted (another heavy query used up its CPU, a deploy, storage moved) or
 * was briefly unreachable. Every query in flight at that moment fails, however
 * cheap it was, and the next attempt usually succeeds.
 */
const TRANSIENT = [
  /exceeded its CPU time limit and was reset/i,
  /reset because its code was updated/i,
  /storage caused object to be reset/i,
  /Network connection lost/i,
  /transient issue/i,
  /Internal error while starting up D1 DB storage/i,
  /D1 DB is overloaded/i,
];

export const isTransientD1 = (error: unknown): boolean =>
  error instanceof Error && TRANSIENT.some((pattern) => pattern.test(error.message));

/**
 * Runs read-only `work`, again after a short wait if D1 was reset under it.
 * Still failing after `tries`, it throws a 503 so the client knows to try later.
 * Only for reads: a write may have landed before the error.
 */
export async function retryD1Read<T>(work: () => Promise<T>, tries = 3, waitMs = 150): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isTransientD1(error)) throw error;
      if (attempt >= tries) {
        console.error("D1 still resetting after retries", error);
        throw new HttpError(503, "The database is busy; try again shortly", "unavailable");
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs * attempt));
    }
  }
}
