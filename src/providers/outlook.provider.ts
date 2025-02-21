import { getEnv } from "@/lib/env";
import { getJson, parseTokenResponse, postTokenForm } from "@/providers/http";
import {
  ProviderError,
  type AuthorizationUrlInput,
  type EmailProviderAdapter,
  type OAuthTokens,
  type ProviderProfile,
} from "@/providers/types";

const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

/** Mail + identity scopes; offline_access is required for refresh tokens. */
const SCOPES = [
  "offline_access",
  "openid",
  "email",
  "profile",
  "Mail.ReadWrite",
  "Mail.Send",
  "User.Read",
];

/**
 * Microsoft/Outlook OAuth adapter (MS identity v2, Graph profile).
 * Tenant comes from MICROSOFT_TENANT_ID ("common" for multi-tenant apps).
 */
export class OutlookProvider implements EmailProviderAdapter {
  readonly id = "outlook" as const;
  readonly displayName = "Outlook";

  private authority(): string {
    return `https://login.microsoftonline.com/${getEnv().MICROSOFT_TENANT_ID}/oauth2/v2.0`;
  }

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
  }

  buildAuthorizationUrl({ state, redirectUri }: AuthorizationUrlInput): string {
    const env = getEnv();
    const url = new URL(`${this.authority()}/authorize`);
    url.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    const env = getEnv();
    const payload = await postTokenForm(`${this.authority()}/token`, {
      code,
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    return parseTokenResponse(payload);
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const env = getEnv();
    const payload = await postTokenForm(`${this.authority()}/token`, {
      refresh_token: refreshToken,
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      grant_type: "refresh_token",
      scope: SCOPES.join(" "),
    });
    return parseTokenResponse(payload);
  }

  async getProfile(accessToken: string): Promise<ProviderProfile> {
    const me = await getJson(GRAPH_ME, accessToken, "Microsoft Graph profile");
    const email =
      typeof me.mail === "string" && me.mail
        ? me.mail
        : typeof me.userPrincipalName === "string"
          ? me.userPrincipalName
          : "";
    if (!me.id || !email) {
      throw new ProviderError("Graph profile missing identity fields", "invalid_response");
    }
    return {
      providerAccountId: String(me.id),
      emailAddress: email,
      displayName: typeof me.displayName === "string" ? me.displayName : null,
    };
  }
}

