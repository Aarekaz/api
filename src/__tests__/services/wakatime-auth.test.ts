import { describe, expect, it } from "vitest";
import { wakaTimeAuth } from "../../services/wakatime";

describe("WakaTime auth", () => {
  it("prefers the personal OAuth token as a Bearer header", () => {
    expect(wakaTimeAuth({ WAKATIME_ACCESS_TOKEN: "waka_tok_1", WAKATIME_API_KEY: "waka_key" })).toBe("Bearer waka_tok_1");
  });
  it("falls back to the plugin key until the token is set", () => {
    expect(wakaTimeAuth({ WAKATIME_API_KEY: "waka_key" })).toBe(`Basic ${btoa("waka_key")}`);
  });
  it("is null with neither", () => {
    expect(wakaTimeAuth({ WAKATIME_API_KEY: "" })).toBeNull();
  });
});
