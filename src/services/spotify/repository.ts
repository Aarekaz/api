import { decryptToken, encryptToken, type EncryptedToken } from "../oauth-crypto";

const PROVIDER_LABEL = "Spotify";
// Single-owner integration: the connection row is always id = 1.
const CONNECTION_ID = 1;

export type SpotifyConnectionStatus = "active" | "needs_reauth" | "disconnected";

export interface SpotifyConnection {
  status: SpotifyConnectionStatus;
  credentialVersion: number;
  accessTokenExpiresAt: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  refreshedAt: string | null;
  disconnectedAt: string | null;
  nowJson: string | null;
  nowFetchedAt: string | null;
  rateLimitedUntil: string | null;
  hasTokens: boolean;
}

export interface SaveConnectionInput {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  grantedScopes: string[];
  connectedAt: string;
}

export interface StoreRefreshedTokensInput {
  accessToken: string;
  accessTokenExpiresAt: string;
  /** Present only when Spotify rotated the refresh token. */
  refreshToken?: string;
  grantedScopes?: string[];
  refreshedAt: string;
}

interface ConnectionRow {
  status: SpotifyConnectionStatus;
  credential_version: number;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_expires_at: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_nonce: string | null;
  granted_scopes: string;
  connected_at: string | null;
  refreshed_at: string | null;
  disconnected_at: string | null;
  now_json: string | null;
  now_fetched_at: string | null;
  rate_limited_until: string | null;
}

const changedRows = (result: D1Result): number => Number(result.meta.changes ?? 0);

// Binds ciphertexts to this provider and token kind so they cannot be swapped with
// WHOOP ciphertexts even though both integrations share one encryption key.
const additionalData = (kind: "access" | "refresh"): string => `spotify:${kind}`;

const splitScopes = (value: string): string[] => value.split(/\s+/).filter(Boolean);

export class SpotifyRepository {
  constructor(
    private readonly db: D1Database,
    private readonly tokenEncryptionKey: string,
  ) {}

  async createOAuthState(stateHash: string, createdAt: string, expiresAt: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO spotify_oauth_states (state_hash, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, NULL)
    `).bind(stateHash, createdAt, expiresAt).run();
  }

  async consumeOAuthState(stateHash: string, consumedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE spotify_oauth_states
      SET consumed_at = ?
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(consumedAt, stateHash, consumedAt).run();
    return changedRows(result) === 1;
  }

  async getConnection(): Promise<SpotifyConnection | null> {
    const row = await this.getRow();
    if (!row) return null;
    return {
      status: row.status,
      credentialVersion: row.credential_version,
      accessTokenExpiresAt: row.access_token_expires_at,
      grantedScopes: splitScopes(row.granted_scopes),
      connectedAt: row.connected_at,
      refreshedAt: row.refreshed_at,
      disconnectedAt: row.disconnected_at,
      nowJson: row.now_json,
      nowFetchedAt: row.now_fetched_at,
      rateLimitedUntil: row.rate_limited_until,
      hasTokens: row.refresh_token_ciphertext !== null && row.refresh_token_nonce !== null,
    };
  }

  /** Stores a fresh grant, replacing any previous one, and returns its credential version. */
  async saveConnection(input: SaveConnectionInput): Promise<number> {
    const [accessToken, refreshToken] = await Promise.all([
      this.encrypt("access", input.accessToken),
      this.encrypt("refresh", input.refreshToken),
    ]);
    const row = await this.db.prepare(`
      INSERT INTO spotify_connections (
        id, status, access_token_ciphertext, access_token_nonce, access_token_expires_at,
        refresh_token_ciphertext, refresh_token_nonce, granted_scopes, credential_version,
        connected_at, refreshed_at, disconnected_at, now_json, now_fetched_at, rate_limited_until,
        created_at, updated_at
      ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'active',
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_nonce = excluded.access_token_nonce,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        refresh_token_nonce = excluded.refresh_token_nonce,
        granted_scopes = excluded.granted_scopes,
        credential_version = spotify_connections.credential_version + 1,
        connected_at = excluded.connected_at,
        refreshed_at = NULL,
        disconnected_at = NULL,
        now_json = NULL,
        now_fetched_at = NULL,
        rate_limited_until = NULL,
        updated_at = excluded.updated_at
      RETURNING credential_version
    `).bind(
      CONNECTION_ID,
      accessToken.ciphertext,
      accessToken.nonce,
      input.accessTokenExpiresAt,
      refreshToken.ciphertext,
      refreshToken.nonce,
      input.grantedScopes.join(" "),
      input.connectedAt,
      input.connectedAt,
      input.connectedAt,
    ).first<{ credential_version: number }>();
    if (!row) throw new Error("Spotify connection was not stored");
    return row.credential_version;
  }

  async getAccessToken(credentialVersion: number): Promise<string | null> {
    const row = await this.getRow();
    if (!row || row.credential_version !== credentialVersion || row.status !== "active") return null;
    return this.decrypt("access", row.access_token_ciphertext, row.access_token_nonce);
  }

  async getRefreshToken(credentialVersion: number): Promise<string | null> {
    const row = await this.getRow();
    if (!row || row.credential_version !== credentialVersion || row.status !== "active") return null;
    return this.decrypt("refresh", row.refresh_token_ciphertext, row.refresh_token_nonce);
  }

  /**
   * Persists a refreshed access token and, when Spotify rotated it, the new refresh token.
   * Guarded by credential version so a refresh never overwrites a newer grant.
   */
  async storeRefreshedTokens(credentialVersion: number, input: StoreRefreshedTokensInput): Promise<boolean> {
    const accessToken = await this.encrypt("access", input.accessToken);
    const refreshToken = input.refreshToken === undefined
      ? null
      : await this.encrypt("refresh", input.refreshToken);
    const result = await this.db.prepare(`
      UPDATE spotify_connections
      SET access_token_ciphertext = ?,
          access_token_nonce = ?,
          access_token_expires_at = ?,
          refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
          refresh_token_nonce = COALESCE(?, refresh_token_nonce),
          granted_scopes = COALESCE(?, granted_scopes),
          refreshed_at = ?,
          updated_at = ?
      WHERE id = ? AND credential_version = ? AND status = 'active'
    `).bind(
      accessToken.ciphertext,
      accessToken.nonce,
      input.accessTokenExpiresAt,
      refreshToken?.ciphertext ?? null,
      refreshToken?.nonce ?? null,
      input.grantedScopes && input.grantedScopes.length > 0 ? input.grantedScopes.join(" ") : null,
      input.refreshedAt,
      input.refreshedAt,
      CONNECTION_ID,
      credentialVersion,
    ).run();
    return changedRows(result) === 1;
  }

  async markNeedsReauth(credentialVersion: number, updatedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE spotify_connections
      SET status = 'needs_reauth',
          access_token_ciphertext = NULL,
          access_token_nonce = NULL,
          access_token_expires_at = NULL,
          refresh_token_ciphertext = NULL,
          refresh_token_nonce = NULL,
          updated_at = ?
      WHERE id = ? AND credential_version = ? AND status = 'active'
    `).bind(updatedAt, CONNECTION_ID, credentialVersion).run();
    return changedRows(result) === 1;
  }

  async storeNowCache(credentialVersion: number, nowJson: string, fetchedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE spotify_connections
      SET now_json = ?, now_fetched_at = ?, rate_limited_until = NULL
      WHERE id = ? AND credential_version = ? AND status = 'active'
    `).bind(nowJson, fetchedAt, CONNECTION_ID, credentialVersion).run();
    return changedRows(result) === 1;
  }

  async setRateLimitedUntil(credentialVersion: number, rateLimitedUntil: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE spotify_connections
      SET rate_limited_until = ?
      WHERE id = ? AND credential_version = ? AND status = 'active'
    `).bind(rateLimitedUntil, CONNECTION_ID, credentialVersion).run();
    return changedRows(result) === 1;
  }

  /** Deletes stored tokens and the cached result. Spotify offers no token revocation API. */
  async disconnect(credentialVersion: number, disconnectedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE spotify_connections
      SET status = 'disconnected',
          access_token_ciphertext = NULL,
          access_token_nonce = NULL,
          access_token_expires_at = NULL,
          refresh_token_ciphertext = NULL,
          refresh_token_nonce = NULL,
          now_json = NULL,
          now_fetched_at = NULL,
          rate_limited_until = NULL,
          disconnected_at = ?,
          updated_at = ?
      WHERE id = ? AND credential_version = ? AND status != 'disconnected'
    `).bind(disconnectedAt, disconnectedAt, CONNECTION_ID, credentialVersion).run();
    return changedRows(result) === 1;
  }

  private async getRow(): Promise<ConnectionRow | null> {
    return this.db.prepare(`
      SELECT status, credential_version, access_token_ciphertext, access_token_nonce,
             access_token_expires_at, refresh_token_ciphertext, refresh_token_nonce,
             granted_scopes, connected_at, refreshed_at, disconnected_at,
             now_json, now_fetched_at, rate_limited_until
      FROM spotify_connections
      WHERE id = ?
    `).bind(CONNECTION_ID).first<ConnectionRow>();
  }

  private encrypt(kind: "access" | "refresh", plaintext: string): Promise<EncryptedToken> {
    return encryptToken(this.tokenEncryptionKey, PROVIDER_LABEL, additionalData(kind), plaintext);
  }

  private async decrypt(
    kind: "access" | "refresh",
    ciphertext: string | null,
    nonce: string | null,
  ): Promise<string | null> {
    if (ciphertext === null || nonce === null) return null;
    return decryptToken(this.tokenEncryptionKey, PROVIDER_LABEL, additionalData(kind), { ciphertext, nonce });
  }
}
