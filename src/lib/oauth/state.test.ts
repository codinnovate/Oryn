import { describe, it, expect } from "vitest";
import {
  signOAuthState,
  STATE_TTL_MS,
  verifyOAuthState,
} from "@/lib/oauth/state";

const base = {
  provider: "gmail" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  nonce: "abcdef0123456789",
  iat: Date.now(),
};

describe("oauth state", () => {
  it("round-trips a signed state", () => {
    const raw = signOAuthState(base);
    const result = verifyOAuthState(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.provider).toBe("gmail");
      expect(result.state.userId).toBe(base.userId);
      expect(result.state.workspaceId).toBe(base.workspaceId);
      expect(result.state.nonce).toBe(base.nonce);
    }
  });

  it("rejects tampered payloads", () => {
    const raw = signOAuthState(base);
    const [body] = raw.split(".");
    // Flip the provider inside the payload without re-signing.
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    decoded.provider = "outlook";
    const forged = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${raw.split(".")[1]}`;
    const result = verifyOAuthState(forged);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects states signed with a foreign key", () => {
    const result = verifyOAuthState(
      `${Buffer.from(JSON.stringify({ ...base, v: 1 }), "utf8").toString("base64url")}.c2lnbmVkLWVsc2V3aGVyZQ`,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects expired states", () => {
    const raw = signOAuthState({ ...base, iat: Date.now() - STATE_TTL_MS - 1000 });
    expect(verifyOAuthState(raw)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed input", () => {
    for (const raw of ["", "abc", "a.b.c", "not-base64!.also-not"]) {
      expect(verifyOAuthState(raw).ok).toBe(false);
    }
  });
});
