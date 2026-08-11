import type { Env } from "../types/env";
import { nowIso } from "../utils/date";

export interface GitHubContributionDay {
  date: string;
  count: number;
}

interface GitHubRepoTotal {
  repo: string;
  count: number;
}

interface GitHubActivitySnapshot {
  days: GitHubContributionDay[];
  repos: GitHubRepoTotal[];
}

export interface CombinedGitHubContributionDay {
  date: string;
  count: number;
  personalCount: number;
  workCount: number;
}

export function mergeGitHubContributionDays(
  personalDays: GitHubContributionDay[],
  workDays: GitHubContributionDay[]
): CombinedGitHubContributionDay[] {
  const days = new Map<
    string,
    { personalCount: number; workCount: number }
  >();

  for (const day of personalDays) {
    days.set(day.date, {
      personalCount: day.count,
      workCount: days.get(day.date)?.workCount ?? 0,
    });
  }

  for (const day of workDays) {
    const current = days.get(day.date);
    days.set(day.date, {
      personalCount: current?.personalCount ?? 0,
      workCount: day.count,
    });
  }

  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, counts]) => ({
      date,
      count: counts.personalCount + counts.workCount,
      ...counts,
    }));
}

export async function fetchGitHubActivity(
  username: string,
  token: string,
  start: string,
  end: string,
  includeRepositories = false
): Promise<GitHubActivitySnapshot> {
  const repositorySelection = includeRepositories
    ? `
          commitContributionsByRepository {
            contributions {
              totalCount
            }
            repository {
              nameWithOwner
            }
          }`
    : "";

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
          ${repositorySelection}
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "personal-api",
    },
    body: JSON.stringify({
      query,
      variables: {
        username,
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
      } | null;
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

  if (!payload.data?.user) {
    throw new Error(`GitHub user ${username} was not found`);
  }

  const collection = payload.data.user.contributionsCollection;
  const weeks = collection?.contributionCalendar?.weeks ?? [];
  const days = weeks.flatMap((week) =>
    (week.contributionDays ?? [])
      .filter(
        (day): day is { date: string; contributionCount?: number } =>
          Boolean(day.date && day.date >= start && day.date <= end)
      )
      .map((day) => ({
        date: day.date,
        count: day.contributionCount ?? 0,
      }))
  );

  const repos = includeRepositories
    ? (collection?.commitContributionsByRepository ?? []).flatMap((repo) => {
        const name = repo.repository?.nameWithOwner;
        return name
          ? [{ repo: name, count: repo.contributions?.totalCount ?? 0 }]
          : [];
      })
    : [];

  return { days, repos };
}

export async function refreshGitHub(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.GITHUB_USERNAME || !env.GITHUB_TOKEN) {
    throw new Error("GITHUB_USERNAME or GITHUB_TOKEN not configured");
  }

  const personalRequest = fetchGitHubActivity(
    env.GITHUB_USERNAME,
    env.GITHUB_TOKEN,
    start,
    end,
    true
  );
  const workRequest = env.GITHUB_WORK_USERNAME
    ? fetchGitHubActivity(
        env.GITHUB_WORK_USERNAME,
        env.GITHUB_TOKEN,
        start,
        end
      )
    : Promise.resolve({ days: [], repos: [] });

  const [personal, work] = await Promise.all([personalRequest, workRequest]);
  const days = mergeGitHubContributionDays(personal.days, work.days);
  const createdAt = nowIso();
  const statements: D1PreparedStatement[] = days.map((day) =>
    env.DB.prepare(
      `INSERT INTO github_daily (
         date, count, personal_count, work_count, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         count = excluded.count,
         personal_count = excluded.personal_count,
         work_count = excluded.work_count,
         created_at = excluded.created_at`
    ).bind(
      day.date,
      day.count,
      day.personalCount,
      day.workCount,
      createdAt
    )
  );

  statements.push(
    env.DB.prepare(
      "DELETE FROM github_repo_totals WHERE range_start = ? AND range_end = ?"
    ).bind(start, end)
  );

  for (const repo of personal.repos) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO github_repo_totals (range_start, range_end, repo, count)
         VALUES (?, ?, ?, ?)`
      ).bind(start, end, repo.repo, repo.count)
    );
  }

  await env.DB.batch(statements);
}
