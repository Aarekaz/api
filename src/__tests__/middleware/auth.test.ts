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

  it("rejects requests without authorization header", async () => {
    const res = await app.request("/protected/resource", {}, {
      API_TOKEN: "test-token",
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBeDefined();
  });

  it("rejects requests with invalid token", async () => {
    const res = await app.request("/protected/resource", {
      headers: {
        Authorization: "Bearer wrong-token",
      },
    }, {
      API_TOKEN: "test-token",
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBeDefined();
  });

  it("rejects requests with non-Bearer auth scheme", async () => {
    const res = await app.request("/protected/resource", {
      headers: {
        Authorization: "Basic dGVzdDp0ZXN0",
      },
    }, {
      API_TOKEN: "test-token",
    });

    expect(res.status).toBe(403);
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
