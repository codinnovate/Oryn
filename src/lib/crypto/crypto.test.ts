import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/crypto/passwords";
import { hashToken, randomToken } from "@/lib/crypto/tokens";

describe("password hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("correct horse battery", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("produces unique salts per hash", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);
    expect(a).not.toBe(b);
  });

  it("returns false for malformed or foreign-format hashes", async () => {
    await expect(verifyPassword("x", "")).resolves.toBe(false);
    await expect(verifyPassword("x", "bcrypt$whatever")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$bad$bad$bad$!!!$!!!")).resolves.toBe(false);
  });
});

describe("tokens", () => {
  it("generates url-safe high-entropy tokens", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{42,44}$/);
    expect(randomToken()).not.toBe(token);
  });

  it("hashes tokens deterministically with sha256", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("abd")).not.toBe(hashToken("abc"));
  });
});
