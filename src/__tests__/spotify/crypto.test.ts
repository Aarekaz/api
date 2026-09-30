import { describe, expect, it } from "vitest";
import { createOAuthState, decryptToken, encryptToken } from "../../services/oauth-crypto";
import { decryptWhoopToken, encryptWhoopToken } from "../../services/whoop/crypto";
import { SpotifyRepository } from "../../services/spotify/repository";
import { KEY, connectionRow, createSpotifyDatabase } from "./fixtures";

describe("shared OAuth crypto", () => {
  it("creates states of the requested length and keeps WHOOP's 8-character default", async () => {
    expect(await createOAuthState()).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(await createOAuthState(32)).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("labels key and decryption errors by provider without exposing key material", async () => {
    await expect(encryptToken("too-short", "Spotify", "spotify:access", "x"))
      .rejects.toThrow("Spotify token encryption key must be 32 bytes");
    const encrypted = await encryptToken(KEY, "Spotify", "spotify:access", "x");
    await expect(decryptToken(KEY, "Spotify", "spotify:refresh", encrypted))
      .rejects.toThrow("Spotify token decryption failed");
  });

  it("keeps Spotify and WHOOP ciphertexts non-interchangeable under the shared key", async () => {
    const { db, sqlite } = await createSpotifyDatabase();
    const repository = new SpotifyRepository(db, KEY);
    await repository.saveConnection({
      accessToken: "spotify-access",
      accessTokenExpiresAt: "2026-09-30T13:00:00.000Z",
      refreshToken: "spotify-refresh",
      grantedScopes: [],
      connectedAt: "2026-09-30T12:00:00.000Z",
    });
    const row = connectionRow(sqlite)!;
    const spotifyRefresh = { ciphertext: row.refresh_token_ciphertext!, nonce: row.refresh_token_nonce! };

    await expect(decryptToken(KEY, "Spotify", "spotify:refresh", spotifyRefresh)).resolves.toBe("spotify-refresh");
    await expect(decryptToken(KEY, "Spotify", "spotify:access", spotifyRefresh)).rejects.toThrow();
    await expect(decryptWhoopToken(KEY, 1, "refresh", spotifyRefresh)).rejects.toThrow("WHOOP token decryption failed");

    const whoop = await encryptWhoopToken(KEY, 42, "refresh", "whoop-refresh");
    await expect(decryptToken(KEY, "Spotify", "spotify:refresh", whoop)).rejects.toThrow();
    sqlite.close();
  });
});
