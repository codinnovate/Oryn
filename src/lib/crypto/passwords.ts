import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

/**
 * Hashes a password with scrypt (memory-hard KDF, no native deps).
 * Format: scrypt$N$r$p$saltB64$hashB64
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/** Constant-time password verification. Returns false for malformed hashes. */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parts = storedHash.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      return false;
    }
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const n = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    const expected = Buffer.from(hashB64, "base64");
    const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: n,
      r,
      p,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
