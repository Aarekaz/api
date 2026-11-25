import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";

const buildWrapped = vi.fn(async (_env: unknown, start: string, end: string) => ({ start, end }));
vi.mock("../../services/wakatime", () => ({ buildWrapped }));
const { default: wrappedRoute } = await import("../../routes/wrapped");

const get = async (path: string) => {
  const res = await wrappedRoute.request(path, {}, {} as Env);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe("/v1/wrapped", () => {
  it("keeps /2026 as the website reads it", async () => {
    expect(await get("/2026")).toEqual({ status: 200, body: { start: "2026-01-01", end: "2026-12-31" } });
  });

  it("answers any other year", async () => {
    expect(await get("/2025")).toEqual({ status: 200, body: { start: "2025-01-01", end: "2025-12-31" } });
  });

  it("refuses what isn't a year", async () => {
    for (const path of ["/abc", "/20x6", "/12345", "/1999", `/${new Date().getUTCFullYear() + 2}`]) {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
  });

  it("doesn't shadow day, week and month", async () => {
    buildWrapped.mockClear();
    for (const path of ["/day", "/week", "/month"]) expect((await get(path)).status).toBe(200);
    const [day, week, month] = buildWrapped.mock.calls.map(([, start, end]) => Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1);
    expect([day, week, month]).toEqual([1, 7, 30]);
  });
});
