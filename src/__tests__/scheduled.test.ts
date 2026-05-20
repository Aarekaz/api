import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types/env";
import { runRefreshJob } from "../scheduled";

function createDb() {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          calls.push({ sql, bindings });
          return {
            run: vi.fn().mockResolvedValue({ success: true }),
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, calls };
}

describe("scheduled refresh health", () => {
  it("records start and success for a completed job", async () => {
    const { db, calls } = createDb();
    const env = { DB: db } as Env;

    await runRefreshJob(env, "github", async () => {});

    expect(calls).toHaveLength(2);
    expect(calls[0].bindings[0]).toBe("github");
    expect(calls[0].sql).toContain("last_started_at");
    expect(calls[1].bindings[0]).toBe("github");
    expect(calls[1].sql).toContain("last_success_at");
  });

  it("records failure and rethrows so allSettled can log the failed job", async () => {
    const { db, calls } = createDb();
    const env = { DB: db } as Env;
    const error = new Error("rate limited");

    await expect(
      runRefreshJob(env, "wakatime", async () => {
        throw error;
      })
    ).rejects.toThrow("rate limited");

    expect(calls).toHaveLength(2);
    expect(calls[1].bindings[0]).toBe("wakatime");
    expect(calls[1].bindings[2]).toContain("rate limited");
    expect(calls[1].sql).toContain("consecutive_failures + 1");
  });
});
