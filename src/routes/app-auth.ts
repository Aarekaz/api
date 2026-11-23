import { Hono } from "hono";
import type { Env } from "../types/env";
import {
  appAuthConfigured,
  appRedirect,
  callbackUrl,
  consumeState,
  createSession,
  githubIdentity,
  revokeSession,
  startSignIn,
} from "../services/app-auth";

// Public routes for Sign in with GitHub in the native apps (mounted at /auth/app).
const app = new Hono<{ Bindings: Env }>();

app.get("/github/start", async (c) => {
  if (!appAuthConfigured(c.env)) return c.json({ error: "App sign-in is not configured" }, 503);
  return c.redirect(await startSignIn(c.env, c.req.url), 302);
});

app.get("/github/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!appAuthConfigured(c.env)) return c.redirect(appRedirect({ error: "not_configured" }), 302);
  if (!state || !code || !(await consumeState(c.env, state))) {
    return c.redirect(appRedirect({ error: "expired" }), 302);
  }
  try {
    const identity = await githubIdentity(c.env, code, callbackUrl(c.env, c.req.url));
    if (identity.id !== c.env.AUTHORIZED_GITHUB_ID) {
      return c.redirect(appRedirect({ error: "not_allowed" }), 302);
    }
    const token = await createSession(c.env, identity);
    return c.redirect(appRedirect({ token, login: identity.login }), 302);
  } catch (error) {
    console.error("app sign-in failed", error);
    return c.redirect(appRedirect({ error: "github" }), 302);
  }
});

/** Signs this device out. Mounted under /v1, so it needs the session's own Bearer token. */
export const signOutRoute = new Hono<{ Bindings: Env }>();
signOutRoute.post("/", async (c) => {
  const token = c.req.header("authorization")?.split(" ")[1];
  if (token && token !== c.env.API_TOKEN) await revokeSession(c.env, token);
  return c.json({ ok: true });
});

export default app;
