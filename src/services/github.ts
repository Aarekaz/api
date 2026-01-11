import type { Env } from "../types/env";
import { nowIso } from "../utils/date";

export async function refreshGitHub(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.GITHUB_USERNAME || !env.GITHUB_TOKEN) {
    throw new Error("GITHUB_USERNAME or GITHUB_TOKEN not configured");
  }

  const query = `
    query($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
          commitContributionsByRepository {
            contributions {
              totalCount
            }
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "personal-api",
    },
    body: JSON.stringify({
      query,
      variables: {
        username: env.GITHUB_USERNAME,
        from: `${start}T00:00:00Z`,
        to: `${end}T23:59:59Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      user?: {
        contributionsCollection?: {
          contributionCalendar?: {
            weeks?: Array<{
              contributionDays?: Array<{
                date?: string;
                contributionCount?: number;
              }>;
            }>;
          };
          commitContributionsByRepository?: Array<{
            contributions?: { totalCount?: number };
            repository?: { nameWithOwner?: string };
          }>;
        };
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(message || "GitHub GraphQL error");
  }

  const collection = payload.data?.user?.contributionsCollection;
  const calendar = collection?.contributionCalendar;
  const weeks = calendar?.weeks ?? [];
  const createdAt = nowIso();

  for (const week of weeks) {
    const days = week.contributionDays ?? [];
    for (const day of days) {
      if (!day.date) {
        continue;
      }
      await env.DB.prepare(
        `INSERT INTO github_daily (date, count, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           count = excluded.count,
           created_at = excluded.created_at`
      )
        .bind(day.date, day.contributionCount ?? 0, createdAt)
        .run();
    }
  }

  await env.DB.prepare(
    "DELETE FROM github_repo_totals WHERE range_start = ? AND range_end = ?"
  )
    .bind(start, end)
    .run();

  const repos = collection?.commitContributionsByRepository ?? [];
  for (const repo of repos) {
    const name = repo.repository?.nameWithOwner;
    if (!name) {
      continue;
    }
    const count = repo.contributions?.totalCount ?? 0;
    await env.DB.prepare(
      `INSERT INTO github_repo_totals (range_start, range_end, repo, count)
       VALUES (?, ?, ?, ?)`
    )
      .bind(start, end, name, count)
      .run();
  }
}
