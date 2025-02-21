export type ProviderId = "gmail" | "outlook";

/** Tokens as returned by a provider's OAuth token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  /** Seconds until the access token expires, if the provider reports it. */
  expiresInSec?: number | null;
  scope?: string | null;
}

/** Identity of the connected mailbox, resolved with the access token. */
export interface ProviderProfile {
  providerAccountId: string;
  emailAddress: string;
  displayName?: string | null;
}

export interface AuthorizationUrlInput {
  state: string;
  redirectUri: string;
}

/**
 * Adapter contract for provider OAuth connections. HTTP-layer code never
 * talks to Google/Microsoft directly — only to this interface.
 */
export interface EmailProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  /** True when client id/secret are configured in the environment. */
  isConfigured(): boolean;
  buildAuthorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  getProfile(accessToken: string): Promise<ProviderProfile>;
}

/** Error thrown by adapters on protocol/HTTP failures. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "unavailable"
      | "rate_limited"
      | "invalid_grant"
      | "invalid_response" = "unavailable",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
