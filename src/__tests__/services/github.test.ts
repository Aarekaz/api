import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import {
  fetchGitHubActivity,
  mergeGitHubContributionDays,
  refreshGitHub,
} from "../../services/github";

function githubResponse(
  days: Array<{ date: string; contributionCount: number }>,
  repos: Array<{ nameWithOwner: string; totalCount: number }> = []
) {
  return new Response(
    JSON.stringify({
      data: {
        user: {
          contributionsCollection: {
            contributionCalendar: {
              weeks: [{ contributionDays: days }],
            },
            commitContributionsByRepository: repos.map((repo) => ({
              contributions: { totalCount: repo.totalCount },
              repository: { nameWithOwner: repo.nameWithOwner },
            })),
          },
        },
      },
    })
  );
}

function createDb() {
  const batches: Array<Array<{ sql: string; bindings: unknown[] }>> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          return { sql, bindings };
        },
      };
    },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  return { db: db as unknown as D1Database, batches };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub activity service", () => {
  it("merges personal and work counts by date", () => {
    expect(
      mergeGitHubContributionDays(
        [
          { date: "2026-08-09", count: 2 },
          { date: "2026-08-10", count: 3 },
        ],
        [
          { date: "2026-08-10", count: 13 },
          { date: "2026-08-11", count: 5 },
        ]
      )
    ).toEqual([
      { date: "2026-08-09", count: 2, personalCount: 2, workCount: 0 },
      { date: "2026-08-10", count: 16, personalCount: 3, workCount: 13 },
      { date: "2026-08-11", count: 5, personalCount: 0, workCount: 5 },
    ]);
  });

  it("does not request or return repository details for work activity", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        githubResponse([{ date: "2026-08-10", contributionCount: 13 }])
      );

    const result = await fetchGitHubActivity(
      "anurag-wa",
      "token",
      "2026-08-10",
      "2026-08-10"
    );
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as {
      query: string;
    };

    expect(request.query).not.toContain("commitContributionsByRepository");
    expect(request.query).not.toContain("nameWithOwner");
    expect(result).toEqual({
      days: [{ date: "2026-08-10", count: 13 }],
      repos: [],
    });
  });

  it("writes combined counts and personal repository totals in one batch", async () => {
    const { db, batches } = createDb();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        githubResponse(
          [{ date: "2026-08-10", contributionCount: 3 }],
          [{ nameWithOwner: "Aarekaz/api", totalCount: 2 }]
        )
      )
      .mockResolvedValueOnce(
        githubResponse([{ date: "2026-08-10", contributionCount: 13 }])
      );

    await refreshGitHub(
      {
        DB: db,
        GITHUB_USERNAME: "Aarekaz",
        GITHUB_WORK_USERNAME: "anurag-wa",
        GITHUB_TOKEN: "token",
      } as Env,
      "2026-08-10",
      "2026-08-10"
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0][0].bindings).toEqual([
      "2026-08-10",
      16,
      3,
      13,
      expect.any(String),
    ]);
    expect(batches[0][2].bindings).toEqual([
      "2026-08-10",
      "2026-08-10",
      "Aarekaz/api",
      2,
    ]);
  });

  it("does not write a partial snapshot when either account fails", async () => {
    const { db, batches } = createDb();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        githubResponse([{ date: "2026-08-10", contributionCount: 3 }])
      )
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    await expect(
      refreshGitHub(
        {
          DB: db,
          GITHUB_USERNAME: "Aarekaz",
          GITHUB_WORK_USERNAME: "anurag-wa",
          GITHUB_TOKEN: "token",
        } as Env,
        "2026-08-10",
        "2026-08-10"
      )
    ).rejects.toThrow("GitHub request failed with 429");

    expect(batches).toHaveLength(0);
  });
});
