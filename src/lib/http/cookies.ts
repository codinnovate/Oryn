export const SESSION_COOKIE_NAME = "oryn_session";
export const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30d, matches SessionService TTL

/**
 * Builds a Set-Cookie value for the session token.
 * HttpOnly + SameSite=Lax + Secure(in production) — never readable by JS.
 */
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_S}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/** Builds an expiring (cleared) session cookie. */
export function buildClearedSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
