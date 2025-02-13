import { createHash, randomBytes } from "node:crypto";

/**
 * Generates a high-entropy opaque token (base64url, no padding).
 * Raw tokens are returned to clients once; only their SHA-256 hash is stored.
 */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
