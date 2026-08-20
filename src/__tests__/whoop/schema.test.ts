import { describe, expect, it } from "vitest";
import { whoopCollectionQuerySchema, whoopWebhookSchema } from "../../schemas/whoop";
import { WHOOP_SCOPES } from "../../types/whoop";

describe("WHOOP shared schemas", () => {
  it("accepts the exact OAuth scopes and rejects an added scope", () => {
    expect(WHOOP_SCOPES).toEqual([
      "offline", "read:profile", "read:body_measurement", "read:cycles",
      "read:recovery", "read:sleep", "read:workout",
    ]);
    expect(whoopWebhookSchema.safeParse({
      user_id: 42,
      id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
      type: "sleep.updated",
      trace_id: "7b2dc91e-7423-42b1-a3cb-ecce1a0e2de8",
    }).success).toBe(true);
    expect(whoopWebhookSchema.safeParse({
      user_id: 42,
      id: "x",
      type: "sleep.created",
      trace_id: "t",
    }).success).toBe(false);
  });

  it("rejects an invalid local cursor and a limit above 100", () => {
    expect(whoopCollectionQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(whoopCollectionQuerySchema.safeParse({ cursor: "not-base64!" }).success).toBe(false);
  });
});
