import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "@/lib/env";

/**
 * Tamper-proof, stateless OAuth state parameter. The payload travels through
 * the provider and back to our callback; the HMAC (STATE_SECRET) guarantees
 * integrity, the embedded timestamp bounds replay to a short window.
 */
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const oauthStateSchema = z.object({
  v: z.literal(1),
  provider: z.enum(["gmail", "outlook"]),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  nonce: z.string().min(16).max(128),
  iat: z.number().int().positive(),
});

export type OAuthState = z.infer<typeof oauthStateSchema>;

function hmac(payload: string): string {
  return createHmac("sha256", getEnv().STATE_SECRET).update(payload).digest("base64url");
}

export function signOAuthState(state: Omit<OAuthState, "v">): string {
  const body = Buffer.from(
    JSON.stringify({ ...state, v: 1 } satisfies OAuthState),
    "utf8",
  ).toString("base64url");
  return `${body}.${hmac(body)}`;
}

export type StateVerification =
  | { ok: true; state: OAuthState }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyOAuthState(raw: string): StateVerification {
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [body, signature] = parts as [string, string];
  const expected = Buffer.from(hmac(body), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const result = oauthStateSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "malformed" };
  }
  if (Date.now() - result.data.iat > STATE_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, state: result.data };
}
