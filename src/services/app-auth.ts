import type { Env } from "../types/env";
import { createOAuthState, hashOAuthState } from "./oauth-crypto";

// Sign in with GitHub for the native apps. The app opens /auth/app/github/start
// in Apple's secure web sign-in sheet; GitHub sends the user back to
// /auth/app/github/callback, which checks it's the owner's account and hands the
// app a device session token through the app's URL scheme. The token works as a
// Bearer token everywhere API_TOKEN does, and only its hash is stored.

export const APP_CALLBACK_SCHEME = "anuragos";
const STATE_TTL_MS = 10 * 60 * 1000;

export function appAuthConfigured(env: Env): boolean {
  return Boolean(env.APP_GITHUB_CLIENT_ID && env.APP_GITHUB_CLIENT_SECRET && env.AUTHORIZED_GITHUB_ID);
}

export function callbackUrl(env: Env, requestUrl: string): string {
  const base = env.API_BASE_URL || new URL(requestUrl).origin;
  return `${base}/auth/app/github/callback`;
}

export function appRedirect(params: Record<string, string>): string {
  return `${APP_CALLBACK_SCHEME}://auth?${new URLSearchParams(params).toString()}`;
}

export async function startSignIn(env: Env, requestUrl: string, now = new Date()): Promise<string> {
  const state = await createOAuthState();
  await env.DB.prepare(
    "INSERT INTO app_oauth_states (state_hash, created_at, expires_at, consumed_at) VALUES (?, ?, ?, NULL)",
  ).bind(await hashOAuthState(state), now.toISOString(), new Date(now.getTime() + STATE_TTL_MS).toISOString()).run();

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.APP_GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callbackUrl(env, requestUrl));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  // No scopes: the app only needs to know who you are. Vault access stays server-side.
  url.searchParams.set("scope", "");
  return url.toString();
}

/** Marks the state used. Returns false if it's unknown, expired or already used. */
export async function consumeState(env: Env, state: string, now = new Date()): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE app_oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(now.toISOString(), await hashOAuthState(state), now.toISOString()).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function githubIdentity(env: Env, code: string, redirectUri: string): Promise<{ id: string; login: string }> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "anurag-os-api" },
    body: JSON.stringify({
      client_id: env.APP_GITHUB_CLIENT_ID,
      client_secret: env.APP_GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenBody = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error("GitHub did not issue a token");

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "anurag-os-api",
    },
  });
  const user = (await userResponse.json()) as { id?: number; login?: string };
  if (!userResponse.ok || typeof user.id !== "number") throw new Error("GitHub did not return a user");
  // The GitHub token is not kept; it was only needed to learn who signed in.
  return { id: String(user.id), login: user.login ?? "" };
}

export async function createSession(env: Env, identity: { id: string; login: string }, now = new Date()): Promise<string> {
  const token = await createOAuthState(48);
  await env.DB.prepare(
    "INSERT INTO app_sessions (token_hash, github_id, github_login, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
  ).bind(await hashOAuthState(token), identity.id, identity.login, now.toISOString()).run();
  return token;
}

export async function isValidSession(env: Env, token: string): Promise<boolean> {
  if (!env.DB || token.length < 32) return false;
  const row = await env.DB.prepare(
    "SELECT github_id FROM app_sessions WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(await hashOAuthState(token)).first<{ github_id: string }>();
  // A session stays valid only while it still belongs to the authorized account.
  return Boolean(row && env.AUTHORIZED_GITHUB_ID && row.github_id === env.AUTHORIZED_GITHUB_ID);
}

export async function revokeSession(env: Env, token: string, now = new Date()): Promise<void> {
  await env.DB.prepare("UPDATE app_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(now.toISOString(), await hashOAuthState(token)).run();
}
