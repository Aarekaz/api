import { describe, expect, it } from "vitest";
import {
  createOAuthState,
  decryptWhoopToken,
  encryptWhoopToken,
  hashOAuthState,
} from "../../services/whoop/crypto";
import { KEY } from "./fixtures";

describe("WHOOP crypto primitives", () => {
  it("round-trips a token only with its matching user and token kind", async () => {
    const encrypted = await encryptWhoopToken(KEY, 42, "refresh", "fixture-refresh-token");

    await expect(decryptWhoopToken(KEY, 42, "refresh", encrypted)).resolves.toBe("fixture-refresh-token");
    await expect(decryptWhoopToken(KEY, 43, "refresh", encrypted)).rejects.toThrow("WHOOP token decryption failed");
    await expect(decryptWhoopToken(KEY, 42, "access", encrypted)).rejects.toThrow("WHOOP token decryption failed");
  });

  it("creates high-entropy state and hashes it deterministically", async () => {
    const state = await createOAuthState();

    expect(state).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(await hashOAuthState(state)).toBe(await hashOAuthState(state));
    expect(await hashOAuthState(state)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects encryption keys that are not exactly 32 bytes", async () => {
    const invalidKey = btoa("too-short");

    await expect(encryptWhoopToken(invalidKey, 42, "access", "fixture-access-token"))
      .rejects.toThrow("WHOOP token encryption key must be 32 bytes");
  });

  it("rejects malformed encryption keys without exposing key material", async () => {
    await expect(encryptWhoopToken("not-base64url", 42, "access", "fixture-access-token"))
      .rejects.toThrow("WHOOP token encryption key must be 32 bytes");
  });
});
