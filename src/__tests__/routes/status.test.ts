import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import statusRoute from "../../routes/status";

function createDb() {
  const db = {
    prepare(sql: string) {
      return {
        all: vi.fn().mockResolvedValue(
          sql.includes("refresh_health")
            ? {
                results: [
                  {
                    name: "github",
                    last_started_at: "2026-05-19T12:00:00.000Z",
                    last_success_at: "2026-05-19T12:01:00.000Z",
                    last_error_at: null,
                    last_error: null,
                    consecutive_failures: 0,
                    updated_at: "2026-05-19T12:01:00.000Z",
                  },
                ],
              }
            : { results: [] }
        ),
      };
    },
  };

  return db as unknown as D1Database;
}

describe("status route", () => {
  it("includes refresh health in the latest status response", async () => {
    const res = await statusRoute.request("/", {}, { DB: createDb() } as Env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { refreshHealth?: unknown[] };
    expect(body.refreshHealth).toEqual([
      {
        name: "github",
        last_started_at: "2026-05-19T12:00:00.000Z",
        last_success_at: "2026-05-19T12:01:00.000Z",
        last_error_at: null,
        last_error: null,
        consecutive_failures: 0,
        updated_at: "2026-05-19T12:01:00.000Z",
      },
    ]);
  });
});
