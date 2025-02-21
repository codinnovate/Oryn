import { getEnv } from "@/lib/env";
import { getJson, parseTokenResponse, postTokenForm } from "@/providers/http";
import {
  ProviderError,
  type AuthorizationUrlInput,
  type EmailProviderAdapter,
  type OAuthTokens,
  type ProviderProfile,
} from "@/providers/types";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** Full mailbox access is required for sync + sending. */
const SCOPES = ["https://mail.google.com/", "openid", "email", "profile"];

/**
 * Google/Gmail OAuth adapter (authorization code flow, offline access).
 */
export class GmailProvider implements EmailProviderAdapter {
  readonly id = "gmail" as const;
  readonly displayName = "Gmail";

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  }

  buildAuthorizationUrl({ state, redirectUri }: AuthorizationUrlInput): string {
    const env = getEnv();
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    // Force a refresh token even on repeated consents.
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    const env = getEnv();
    const payload = await postTokenForm(TOKEN_ENDPOINT, {
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    return parseTokenResponse(payload);
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const env = getEnv();
    const payload = await postTokenForm(TOKEN_ENDPOINT, {
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    });
    return parseTokenResponse(payload);
  }

  async getProfile(accessToken: string): Promise<ProviderProfile> {
    const info = await getJson(USERINFO_ENDPOINT, accessToken, "Google userinfo");
    const email = typeof info.email === "string" ? info.email : "";
    if (!info.sub || !email) {
      throw new ProviderError("Google userinfo missing identity fields", "invalid_response");
    }
    return {
      providerAccountId: String(info.sub),
      emailAddress: email,
      displayName: typeof info.name === "string" ? info.name : null,
    };
  }
}

