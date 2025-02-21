import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  decryptSecret,
  DecryptionError,
  encryptSecret,
  keyedDigest,
  resetEncryptionKeyCache,
} from "@/lib/crypto/secrets";
import { resetEnvCache } from "@/lib/env";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");
const DEFAULT_TEST_KEY = "b29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb28=";

describe("secret encryption (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    resetEnvCache();
    resetEncryptionKeyCache();
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = DEFAULT_TEST_KEY;
    resetEnvCache();
    resetEncryptionKeyCache();
  });

  it("round-trips a secret", () => {
    const payload = encryptSecret("ya29.super-secret-token");
    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain("super-secret");
    expect(decryptSecret(payload)).toBe("ya29.super-secret-token");
  });

  it("produces unique ciphertexts for identical plaintexts", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("binds ciphertext to its context", () => {
    const payload = encryptSecret("token-value", "access-token");
    // Same key, wrong AAD -> auth failure.
    expect(() => decryptSecret(payload, "refresh-token")).toThrow(DecryptionError);
  });

  it("rejects tampered payloads", () => {
    const payload = encryptSecret("do-not-touch");
    const parts = payload.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered)).toThrow(DecryptionError);
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("garbage")).toThrow(DecryptionError);
    expect(() => decryptSecret("v2.a.b.c")).toThrow(DecryptionError);
    expect(() => decryptSecret("v1.a.b")).toThrow(DecryptionError);
  });

  it("refuses keys that do not decode to 32 bytes", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    resetEnvCache();
    resetEncryptionKeyCache();
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("keyed digest is deterministic and keyed", () => {
    const before = keyedDigest("a@b.com");
    expect(keyedDigest("a@b.com")).toBe(before);
    expect(keyedDigest("c@d.com")).not.toBe(before);
    // Rotating the key changes all derived digests.
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    resetEnvCache();
    resetEncryptionKeyCache();
    expect(keyedDigest("a@b.com")).not.toBe(before);
  });
});
