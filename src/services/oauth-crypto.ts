// Provider-neutral OAuth primitives shared by the WHOOP and Spotify integrations:
// one-use CSRF state generation/hashing and AES-GCM token encryption at rest.
const STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_STATE_LENGTH = 8;
const STATE_REJECTION_LIMIT = Math.floor(256 / STATE_ALPHABET.length) * STATE_ALPHABET.length;
const AES_GCM_NONCE_BYTES = 12;
const AES_KEY_BYTES = 32;
const textEncoder = new TextEncoder();

export interface EncryptedToken {
  ciphertext: string;
  nonce: string;
}

const bytesToBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    throw new Error("invalid base64url value");
  }

  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    throw new Error("invalid base64url value");
  }

  const padded = unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

/**
 * Decodes a base64url 32-byte AES key. `providerLabel` only shapes the error message
 * (e.g. "WHOOP token encryption key must be 32 bytes") and never includes key material.
 */
export const decodeTokenEncryptionKey = (keyMaterial: unknown, providerLabel: string): Uint8Array => {
  const invalid = () => new Error(`${providerLabel} token encryption key must be 32 bytes`);
  if (typeof keyMaterial !== "string") {
    throw invalid();
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlToBytes(keyMaterial);
  } catch {
    throw invalid();
  }

  if (keyBytes.byteLength !== AES_KEY_BYTES) {
    throw invalid();
  }
  return keyBytes;
};

const importEncryptionKey = async (keyMaterial: string, providerLabel: string): Promise<CryptoKey> => {
  return crypto.subtle.importKey(
    "raw",
    decodeTokenEncryptionKey(keyMaterial, providerLabel),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
};

export async function hashOAuthState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(state));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createOAuthState(length = DEFAULT_STATE_LENGTH): Promise<string> {
  let state = "";

  while (state.length < length) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(length - state.length));
    for (const randomByte of randomBytes) {
      if (randomByte < STATE_REJECTION_LIMIT) {
        state += STATE_ALPHABET[randomByte % STATE_ALPHABET.length];
      }
    }
  }

  return state;
}

/**
 * Encrypts a token with AES-GCM. `additionalData` binds the ciphertext to its owner and
 * token kind so a ciphertext cannot be swapped between rows, providers, or token kinds.
 */
export async function encryptToken(
  keyMaterial: string,
  providerLabel: string,
  additionalData: string,
  plaintext: string,
): Promise<EncryptedToken> {
  const key = await importEncryptionKey(keyMaterial, providerLabel);
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: textEncoder.encode(additionalData) },
    key,
    textEncoder.encode(plaintext),
  );

  return {
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    nonce: bytesToBase64Url(nonce),
  };
}

export async function decryptToken(
  keyMaterial: string,
  providerLabel: string,
  additionalData: string,
  encrypted: EncryptedToken,
): Promise<string> {
  try {
    const key = await importEncryptionKey(keyMaterial, providerLabel);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(encrypted.nonce),
        additionalData: textEncoder.encode(additionalData),
      },
      key,
      base64UrlToBytes(encrypted.ciphertext),
    );

    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(`${providerLabel} token decryption failed`);
  }
}
