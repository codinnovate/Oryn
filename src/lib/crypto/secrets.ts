import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/** Test-only escape hatch; called after mutating ENCRYPTION_KEY. */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}

function encryptionKey(): Buffer {
  if (!cachedKey) {
    const key = Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    cachedKey = key;
  }
  return cachedKey;
}

/**
 * Encrypts a secret (e.g. a provider OAuth token) with AES-256-GCM.
 * Wire format: `v1.<iv b64url>.<authTag b64url>.<ciphertext b64url>` — the
 * version prefix allows future key rotation without re-encrypting reads.
 */
export function encryptSecret(plaintext: string, context = "provider-token"): string {
  const iv = randomBytes(IV_BYTES);
  // Binding the ciphertext to its purpose prevents cross-use of decrypted blobs.
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export class DecryptionError extends Error {
  constructor(message = "Could not decrypt secret") {
    super(message);
    this.name = "DecryptionError";
  }
}

/** Decrypts payloads produced by `encryptSecret`; throws on any tampering. */
export function decryptSecret(payload: string, context = "provider-token"): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionError();
  }
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}

/**
 * Deterministic keyed digest for searchable identifiers we do not want to
 * store in plaintext (e.g. deduplication keys). NOT for passwords/tokens.
 */
export function keyedDigest(value: string): string {
  return createHmac("sha256", encryptionKey()).update(value).digest("hex");
}
