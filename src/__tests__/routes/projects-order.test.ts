import { describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import { testD1 } from "../helpers/d1";
import projectsRoute from "../../routes/projects";

function setup() {
  const d1 = testD1({ migrations: "all" });
  for (const [title, order] of [["A", 1], ["B", 2], ["C", 3]] as const) {
    d1.db.prepare("INSERT INTO projects (title, sort_order, created_at) VALUES (?, ?, ?)").run(title, order, "2026-01-01T00:00:00Z");
  }
  const env = { DB: d1.DB } as Env;
  const send = (path: string, body: unknown) => projectsRoute.request(path, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, env);
  const orders = () => Object.fromEntries((d1.db.prepare("SELECT title, sort_order FROM projects").all() as Array<{ title: string; sort_order: number }>)
    .map((row) => [row.title, row.sort_order]));
  return { d1, send, orders };
}

describe("PATCH /v1/projects/order", () => {
  it("sets every sort_order in one batch", async () => {
    const { d1, send, orders } = setup();
    let batches = 0;
    const batch = d1.DB.batch.bind(d1.DB);
    d1.DB.batch = ((statements: Parameters<typeof batch>[0]) => { batches++; return batch(statements); }) as typeof d1.DB.batch;
    const res = await send("/order", { order: [{ id: 1, sort_order: 3 }, { id: 2, sort_order: 2 }, { id: 3, sort_order: 1 }] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; updated: number; updated_at: string };
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(3);
    expect(batches).toBe(1);
    expect(orders()).toEqual({ A: 3, B: 2, C: 1 });
  });

  it("changes nothing when an id is unknown", async () => {
    const { send, orders } = setup();
    const res = await send("/order", { order: [{ id: 1, sort_order: 9 }, { id: 99, sort_order: 1 }] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found", details: { missing: [99] } });
    expect(orders()).toEqual({ A: 1, B: 2, C: 3 });
  });

  it("refuses a bad body in the website's error shape", async () => {
    const { send, orders } = setup();
    for (const body of [{}, { order: [] }, { order: [{ id: 1, sort_order: 1 }, { id: 1, sort_order: 2 }] }, { order: [{ id: "x", sort_order: 1 }] }]) {
      const res = await send("/order", body);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("Validation error");
    }
    expect(orders()).toEqual({ A: 1, B: 2, C: 3 });
  });

  it("leaves PATCH /:id as it was", async () => {
    const { send, orders } = setup();
    const res = await send("/2", { sort_order: 7 });
    expect(res.status).toBe(200);
    expect(orders().B).toBe(7);
  });
});
