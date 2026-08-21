export interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  API_TOKEN: string;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
  WHOOP_TOKEN_ENCRYPTION_KEY: string;
  WHOOP_REDIRECT_URI: string;
  OS_BASE_URL: string;
  WHOOP_SYNC_QUEUE: Queue<import("./whoop").WhoopQueueMessage>;
  LANYARD_USER_ID: string;
  WAKATIME_API_KEY: string;
  WAKATIME_TIMEZONE: string;
  GITHUB_USERNAME: string;
  GITHUB_WORK_USERNAME?: string;
  GITHUB_TOKEN: string;
  TMDB_API_KEY?: string;
  TMDB_ACCESS_TOKEN?: string;
  API_VERSION: string;
  R2_PUBLIC_BASE_URL: string;
  API_BASE_URL?: string;
}
