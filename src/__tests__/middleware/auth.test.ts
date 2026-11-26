import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth";

// Test setup
interface TestEnv {
  Bindings: {
    API_TOKEN: string;
  };
}

describe("auth middleware", () => {
  let app: Hono<TestEnv>;

  beforeAll(() => {
    app = new Hono<TestEnv>();
    
    // Apply auth middleware to protected route
    app.use("/protected/*", requireAuth);
    
    app.get("/protected/resource", (c) => {
      return c.json({ message: "success" });
    });
    
    app.get("/public", (c) => {
      return c.json({ message: "public" });
    });
  });

  it("allows requests with valid Bearer token", async () => {
    const res = await app.request("/protected/resource", {
      headers: {
        Authorization: "Bearer test-token",
      },
    }, {
      API_TOKEN: "test-token",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { message: string };
    expect(body.message).toBe("success");
  });

  it("answers no authorization header with 401 and a Bearer challenge", async () => {
    const res = await app.request("/protected/resource", {}, {
      API_TOKEN: "test-token",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Missing authorization header" } });
  });

  it("answers an unknown token with 401 invalid_token (it was 403)", async () => {
    const res = await app.request("/protected/resource", {
      headers: {
        Authorization: "Bearer wrong-token",
      },
    }, {
      API_TOKEN: "test-token",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Invalid token" } });
  });

  it("answers another auth scheme, or Bearer with no token, with 401 invalid_token", async () => {
    for (const header of ["Basic dGVzdDp0ZXN0", "Bearer", "Bearer ", "bearer test-token"]) {
      const res = await app.request("/protected/resource", {
        headers: {
          Authorization: header,
        },
      }, {
        API_TOKEN: "test-token",
      });

      expect(res.status, header).toBe(401);
      expect(res.headers.get("WWW-Authenticate"), header).toBe('Bearer error="invalid_token"');
    }
  });

  it("returns 500 if API_TOKEN is not configured", async () => {
    const appWithoutToken = new Hono<TestEnv>();
    appWithoutToken.use("/protected/*", requireAuth);
    appWithoutToken.get("/protected/resource", (c) => c.json({ ok: true }));

    const res = await appWithoutToken.request("/protected/resource", {
      headers: {
        Authorization: "Bearer any-token",
      },
    }, {
      API_TOKEN: "", // Empty token simulates unconfigured
    });

    expect(res.status).toBe(500);
  });
});
