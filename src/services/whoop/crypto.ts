import {
  createOAuthState,
  decodeTokenEncryptionKey,
  decryptToken,
  encryptToken,
  hashOAuthState,
  type EncryptedToken,
} from "../oauth-crypto";

export { createOAuthState, hashOAuthState, type EncryptedToken };

const PROVIDER_LABEL = "WHOOP";

export const decodeWhoopTokenEncryptionKey = (keyMaterial: unknown): Uint8Array =>
  decodeTokenEncryptionKey(keyMaterial, PROVIDER_LABEL);

const additionalData = (whoopUserId: number, kind: "access" | "refresh"): string =>
  `${whoopUserId}:${kind}`;

export async function encryptWhoopToken(
  keyMaterial: string,
  whoopUserId: number,
  kind: "access" | "refresh",
  plaintext: string,
): Promise<EncryptedToken> {
  return encryptToken(keyMaterial, PROVIDER_LABEL, additionalData(whoopUserId, kind), plaintext);
}

export async function decryptWhoopToken(
  keyMaterial: string,
  whoopUserId: number,
  kind: "access" | "refresh",
  encrypted: EncryptedToken,
): Promise<string> {
  return decryptToken(keyMaterial, PROVIDER_LABEL, additionalData(whoopUserId, kind), encrypted);
}
