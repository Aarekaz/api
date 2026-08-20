const STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const STATE_LENGTH = 8;
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

const importEncryptionKey = async (keyMaterial: string): Promise<CryptoKey> => {
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlToBytes(keyMaterial);
  } catch {
    throw new Error("WHOOP token encryption key must be 32 bytes");
  }

  if (keyBytes.byteLength !== AES_KEY_BYTES) {
    throw new Error("WHOOP token encryption key must be 32 bytes");
  }

  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
};

const additionalData = (whoopUserId: number, kind: "access" | "refresh"): Uint8Array =>
  textEncoder.encode(`${whoopUserId}:${kind}`);

export async function hashOAuthState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(state));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createOAuthState(): Promise<string> {
  let state = "";

  while (state.length < STATE_LENGTH) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(STATE_LENGTH - state.length));
    for (const randomByte of randomBytes) {
      if (randomByte < STATE_REJECTION_LIMIT) {
        state += STATE_ALPHABET[randomByte % STATE_ALPHABET.length];
      }
    }
  }

  return state;
}

export async function encryptWhoopToken(
  keyMaterial: string,
  whoopUserId: number,
  kind: "access" | "refresh",
  plaintext: string,
): Promise<EncryptedToken> {
  const key = await importEncryptionKey(keyMaterial);
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: additionalData(whoopUserId, kind) },
    key,
    textEncoder.encode(plaintext),
  );

  return {
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    nonce: bytesToBase64Url(nonce),
  };
}

export async function decryptWhoopToken(
  keyMaterial: string,
  whoopUserId: number,
  kind: "access" | "refresh",
  encrypted: EncryptedToken,
): Promise<string> {
  try {
    const key = await importEncryptionKey(keyMaterial);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(encrypted.nonce),
        additionalData: additionalData(whoopUserId, kind),
      },
      key,
      base64UrlToBytes(encrypted.ciphertext),
    );

    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("WHOOP token decryption failed");
  }
}
