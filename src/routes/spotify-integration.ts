import { Hono } from "hono";
import { createOAuthState, hashOAuthState } from "../services/oauth-crypto";
import { SPOTIFY_AUTHORIZE_URL, SpotifyClient } from "../services/spotify/client";
import { SpotifyRepository } from "../services/spotify/repository";
import {
  authSecurity,
  structuredErrorSchema,
  structuredOkResponses,
  okSchema,
  openApiRegistry,
  openApiResponse,
  spotifyAuthorizationUrlResponseSchema,
  spotifyIntegrationStatusResponseSchema,
} from "../schemas/openapi";
import type { Env } from "../types/env";
import { appErrors, fail } from "../lib/http";

export const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-recently-played"] as const;

const OAUTH_STATE_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
const OAUTH_STATE_LENGTH = 32;

interface IntegrationRepository {
  createOAuthState: SpotifyRepository["createOAuthState"];
  consumeOAuthState: SpotifyRepository["consumeOAuthState"];
  getConnection: SpotifyRepository["getConnection"];
  saveConnection: SpotifyRepository["saveConnection"];
  disconnect: SpotifyRepository["disconnect"];
}

interface IntegrationClient {
  exchangeAuthorizationCode(code: string): ReturnType<SpotifyClient["exchangeAuthorizationCode"]>;
}

export interface SpotifyIntegrationDependencies {
  repository?: IntegrationRepository;
  clientFactory?: (env: Env) => IntegrationClient;
  now?: () => Date;
}

const configured = (env: Env): boolean => {
  if (!env.DB) return false;
  const requiredStrings = [
    env.SPOTIFY_CLIENT_ID,
    env.SPOTIFY_CLIENT_SECRET,
    env.WHOOP_TOKEN_ENCRYPTION_KEY,
    env.SPOTIFY_REDIRECT_URI,
    env.OS_BASE_URL,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) return false;
  try {
    return new URL(env.SPOTIFY_REDIRECT_URI!).protocol === "https:"
      && new URL(env.OS_BASE_URL).protocol === "https:";
  } catch {
    return false;
  }
};

const resultRedirect = (env: Env, result: "connected" | "failed"): string =>
  new URL(`/music/source?result=${result}`, env.OS_BASE_URL).toString();

export function createSpotifyIntegrationRoute(dependencies: SpotifyIntegrationDependencies = {}) {
  // Errors are the one shape (lib/http.ts), the callback's redirects aside.
  const app = appErrors(new Hono<{ Bindings: Env }>(), "Spotify request");
  const now = dependencies.now ?? (() => new Date());
  const repositoryFor = (env: Env): IntegrationRepository => dependencies.repository
    ?? new SpotifyRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const clientFor = (env: Env): IntegrationClient => dependencies.clientFactory?.(env)
    ?? new SpotifyClient(env, "");
  const callbackFailure = (env: Env) => new Response(null, {
    status: 302,
    headers: { location: resultRedirect(env, "failed") },
  });

  app.get("/v1/integrations/spotify", async (c) => {
    const connection = await repositoryFor(c.env).getConnection();
    if (!connection) return c.json({ status: "not_connected" });
    return c.json({
      status: connection.status,
      granted_scopes: connection.grantedScopes,
      connected_at: connection.connectedAt,
      refreshed_at: connection.refreshedAt,
      disconnected_at: connection.disconnectedAt,
    });
  });

  app.post("/v1/integrations/spotify/connect", async (c) => {
    if (!configured(c.env)) return fail(c, 503, "Spotify integration is not configured");
    const repository = repositoryFor(c.env);
    const createdAt = now();
    const state = await createOAuthState(OAUTH_STATE_LENGTH);
    await repository.createOAuthState(
      await hashOAuthState(state),
      createdAt.toISOString(),
      new Date(createdAt.getTime() + OAUTH_STATE_LIFETIME_MILLISECONDS).toISOString(),
    );
    const url = new URL(SPOTIFY_AUTHORIZE_URL);
    url.searchParams.set("client_id", c.env.SPOTIFY_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", c.env.SPOTIFY_REDIRECT_URI!);
    url.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return c.json({ authorization_url: url.toString() });
  });

  app.get("/integrations/spotify/callback", async (c) => {
    if (!configured(c.env)) return callbackFailure(c.env);
    const state = c.req.query("state");
    if (!state) return callbackFailure(c.env);
    try {
      const repository = repositoryFor(c.env);
      const consumed = await repository.consumeOAuthState(await hashOAuthState(state), now().toISOString());
      if (!consumed) return callbackFailure(c.env);
      // Spotify sends ?error=access_denied (and no code) when the owner declines.
      const code = c.req.query("code");
      if (!code || c.req.query("error") !== undefined) return callbackFailure(c.env);
      const tokens = await clientFor(c.env).exchangeAuthorizationCode(code);
      const connectedAt = now();
      await repository.saveConnection({
        accessToken: tokens.access_token,
        accessTokenExpiresAt: new Date(connectedAt.getTime() + tokens.expires_in * 1000).toISOString(),
        refreshToken: tokens.refresh_token,
        grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [...SPOTIFY_SCOPES],
        connectedAt: connectedAt.toISOString(),
      });
      return c.redirect(resultRedirect(c.env, "connected"));
    } catch {
      return callbackFailure(c.env);
    }
  });

  app.delete("/v1/integrations/spotify", async (c) => {
    const repository = repositoryFor(c.env);
    const connection = await repository.getConnection();
    if (!connection || connection.status === "disconnected") {
      return fail(c, 409, "Spotify is not connected");
    }
    const disconnected = await repository.disconnect(connection.credentialVersion, now().toISOString());
    if (!disconnected) return fail(c, 409, "Spotify connection changed before disconnect");
    return c.json({ ok: true });
  });

  return app;
}

// OAuth plumbing for Music; its guide is in routes/music.ts.
const TAG = "Music";

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/integrations/spotify",
  tags: [TAG],
  summary: "Get Spotify connection status",
  security: authSecurity,
  responses: structuredOkResponses(spotifyIntegrationStatusResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/integrations/spotify/connect",
  tags: [TAG],
  summary: "Create a Spotify authorization URL",
  security: authSecurity,
  responses: {
    ...structuredOkResponses(spotifyAuthorizationUrlResponseSchema),
    503: openApiResponse(structuredErrorSchema, "Spotify integration is not configured"),
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/integrations/spotify/callback",
  tags: [TAG],
  summary: "Complete Spotify OAuth authorization",
  responses: {
    302: { description: "Fixed OS connection result redirect" },
  },
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/integrations/spotify",
  tags: [TAG],
  summary: "Disconnect Spotify and delete stored tokens",
  security: authSecurity,
  responses: {
    ...structuredOkResponses(okSchema),
    409: openApiResponse(structuredErrorSchema, "Spotify is not connected"),
  },
});

export default createSpotifyIntegrationRoute();
