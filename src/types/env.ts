export interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  API_TOKEN: string;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
  WHOOP_TOKEN_ENCRYPTION_KEY: string;
  WHOOP_REDIRECT_URI: string;
  OS_BASE_URL: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_REDIRECT_URI?: string;
  WHOOP_SYNC_QUEUE: Queue<import("./whoop").WhoopQueueMessage>;
  LANYARD_USER_ID: string;
  WAKATIME_API_KEY: string;
  WAKATIME_TIMEZONE: string;
  GITHUB_USERNAME: string;
  GITHUB_WORK_USERNAME?: string;
  GITHUB_TOKEN: string;
  TMDB_API_KEY?: string;
  TMDB_ACCESS_TOKEN?: string;
  // Sign in with GitHub for the native apps (a GitHub OAuth app whose callback is
  // <API_BASE_URL>/auth/app/github/callback). Only AUTHORIZED_GITHUB_ID may sign in.
  APP_GITHUB_CLIENT_ID?: string;
  APP_GITHUB_CLIENT_SECRET?: string;
  AUTHORIZED_GITHUB_ID?: string;
  // Obsidian vault repo for /v1/vault (fine-grained token: Contents read/write on that repo only)
  VAULT_GITHUB_TOKEN?: string;
  VAULT_REPO?: string;
  VAULT_BRANCH?: string;
  API_VERSION: string;
  // The site's /api/revalidate bearer (same value as the site's REVALIDATE_TOKEN). Unset = no refresh calls.
  REVALIDATE_TOKEN?: string;
  // Defaults to https://www.anuragd.me (the bare domain redirects, which would drop the token).
  SITE_URL?: string;
  R2_PUBLIC_BASE_URL: string;
  API_BASE_URL?: string;
  // year-in-review traffic (optional; skipped without the token)
  CF_SITE_ZONE?: string;
  CF_ANALYTICS_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;
}
