import { ProviderError, type OAuthTokens } from "@/providers/types";

/**
 * Minimal form-POST helper for OAuth token endpoints. Maps transport and
 * protocol failures onto ProviderError so services can translate them into
 * stable API error codes.
 */
export async function postTokenForm(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderError("Provider token endpoint unreachable", "unavailable");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status === 429) {
      throw new ProviderError("Provider rate limited", "rate_limited", res.status);
    }
    let errorCode = "";
    try {
      errorCode = String(JSON.parse(text).error ?? "");
    } catch {
      // non-JSON body
    }
    // invalid_grant covers expired/revoked codes and refresh tokens.
    if (errorCode === "invalid_grant") {
      throw new ProviderError("Grant is invalid or expired", "invalid_grant", res.status);
    }
    throw new ProviderError(
      `Token request failed (${res.status})`,
      "unavailable",
      res.status,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError("Malformed token response", "invalid_response", res.status);
  }
}

/** Extracts the common token fields from a provider token response. */
export function parseTokenResponse(payload: Record<string, unknown>): OAuthTokens {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new ProviderError("Token response missing access_token", "invalid_response");
  }
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expiresInSec: typeof payload.expires_in === "number" ? payload.expires_in : null,
    scope: typeof payload.scope === "string" ? payload.scope : null,
  };
}

/** Authenticated GET returning parsed JSON with mapped errors. */
export async function getJson(
  url: string,
  accessToken: string,
  context: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderError(`${context} unreachable`, "unavailable");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status === 401) {
      throw new ProviderError("Access token rejected", "invalid_grant", res.status);
    }
    if (res.status === 429) {
      throw new ProviderError("Provider rate limited", "rate_limited", res.status);
    }
    throw new ProviderError(`${context} failed (${res.status})`, "unavailable", res.status);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`Malformed ${context} response`, "invalid_response", res.status);
  }
}
