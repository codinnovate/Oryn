import { getEnv } from "@/lib/env";
import { getJson, parseTokenResponse, postTokenForm } from "@/providers/http";
import { toProviderMessage } from "@/providers/address";
import {
  collectAttachments,
  extractBody,
  hasAnyAttachment,
  type GmailMimePart,
} from "@/providers/gmail.mime";
import {
  ProviderError,
  type AuthorizationUrlInput,
  type EmailProviderAdapter,
  type ListMessagesOptions,
  type ListMessagesResult,
  type OAuthTokens,
  type ProviderAttachmentMeta,
  type ProviderMessageBody,
  type ProviderProfile,
  type SendMessageInput,
  type SendResult,
} from "@/providers/types";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

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

  /**
   * Lists message metadata newest-first. Gmail's list endpoint returns ids
   * only, so each page is hydrated with per-message metadata requests,
   * bounded by maxResults to respect provider rate limits.
   */
  async listMessages(
    accessToken: string,
    options: ListMessagesOptions = {},
  ): Promise<ListMessagesResult> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 25, 1), 100);
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (options.since) {
      params.set("q", `after:${Math.floor(options.since.getTime() / 1000)}`);
    }

    const list = await getJson(
      `${GMAIL_API}/messages?${params.toString()}`,
      accessToken,
      "Gmail messages list",
    );
    const refs = Array.isArray(list.messages) ? list.messages : [];
    const nextPageToken =
      typeof list.nextPageToken === "string" && list.nextPageToken
        ? list.nextPageToken
        : null;

    const messages = (
      await Promise.all(
        refs.map((ref) => this.fetchMetadata(accessToken, ref)),
      )
    ).filter((m): m is NonNullable<typeof m> => m !== null);
    return { messages, nextPageToken };
  }

  /** Fetches one message's metadata; unmappable payloads are skipped. */
  private async fetchMetadata(
    accessToken: string,
    ref: unknown,
  ): Promise<ReturnType<typeof toProviderMessage>> {
    const id = typeof (ref as { id?: unknown })?.id === "string" ? (ref as { id: string }).id : "";
    if (!id) return null;
    try {
      const msg = await getJson(
        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata`,
        accessToken,
        "Gmail message",
      );
      const payload = (msg.payload ?? {}) as GmailMimePart;
      const header = (name: string): string | null => {
        const hit = (payload.headers ?? []).find(
          (h) => typeof h.name === "string" && h.name.toLowerCase() === name.toLowerCase(),
        );
        return typeof hit?.value === "string" ? hit.value : null;
      };
      const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
      return toProviderMessage({
        providerMessageId: msg.id,
        threadId: msg.threadId,
        subject: header("Subject"),
        from: header("From"),
        to: header("To"),
        snippet: msg.snippet,
        receivedAt: typeof msg.internalDate === "string" ? Number(msg.internalDate) : undefined,
        isRead: !labelIds.includes("UNREAD"),
        hasAttachments: hasAnyAttachment(payload),
        sizeBytes: typeof msg.sizeEstimate === "number" ? msg.sizeEstimate : undefined,
        labels: labelIds,
      });
    } catch {
      return null;
    }
  }

  async sendMessage(
    accessToken: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const { buildRfc2822Message } = await import("@/providers/rfc2822");
    // Gmail requires the "From" header but the API fills the real sender;
    // we use a placeholder — Gmail overwrites it with the authenticated account.
    const raw = buildRfc2822Message(input, input.to[0] ?? "");
    const body = Buffer.from(raw).toString("base64url");

    let res: Response;
    try {
      res = await fetch(`${GMAIL_API}/messages/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError("Gmail send endpoint unreachable", "unavailable");
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      if (res.status === 401) {
        throw new ProviderError("Access token rejected", "invalid_grant", res.status);
      }
      if (res.status === 429) {
        throw new ProviderError("Provider rate limited", "rate_limited", res.status);
      }
      throw new ProviderError(`Gmail send failed (${res.status})`, "unavailable", res.status);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError("Malformed Gmail send response", "invalid_response", res.status);
    }

    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      throw new ProviderError("Gmail send response missing message id", "invalid_response");
    }
    void body; // base64url encoded raw is not needed in the result
    return { providerMessageId: id };
  }

  async fetchMessageBody(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ProviderMessageBody> {
    const msg = await getJson(
      `${GMAIL_API}/messages/${encodeURIComponent(providerMessageId)}?format=full`,
      accessToken,
      "Gmail message body",
    );
    const payload = (msg.payload ?? {}) as GmailMimePart;
    const text = extractBody(payload, "text/plain");
    const html = extractBody(payload, "text/html");
    return { text: text || undefined, html: html || undefined };
  }

  async listAttachments(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ProviderAttachmentMeta[]> {
    const msg = await getJson(
      `${GMAIL_API}/messages/${encodeURIComponent(providerMessageId)}?format=full`,
      accessToken,
      "Gmail message for attachments",
    );
    const payload = (msg.payload ?? {}) as GmailMimePart;
    return collectAttachments(payload);
  }

  async getAttachment(
    accessToken: string,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(
        `${GMAIL_API}/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(providerAttachmentId)}`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new ProviderError("Gmail attachment endpoint unreachable", "unavailable");
    }

    if (!res.ok) {
      if (res.status === 404) {
        throw new ProviderError("Attachment not found", "not_found", 404);
      }
      throw new ProviderError(`Gmail attachment fetch failed (${res.status})`, "unavailable", res.status);
    }

    const data = await res.json() as { data?: string };
    if (typeof data.data !== "string") {
      throw new ProviderError("Gmail attachment response missing data field", "invalid_response");
    }
    return Buffer.from(data.data, "base64url");
  }
}

