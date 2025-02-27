import { getEnv } from "@/lib/env";
import { getJson, parseTokenResponse, postTokenForm } from "@/providers/http";
import { toProviderMessage } from "@/providers/address";
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

  /**
   * Lists inbox message metadata newest-first via Microsoft Graph. A single
   * Graph page maps 1:1 onto ProviderMessage entries.
   */
  async listMessages(
    accessToken: string,
    options: ListMessagesOptions = {},
  ): Promise<ListMessagesResult> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 25, 1), 50);
    const params = new URLSearchParams({
      "$top": String(maxResults),
      "$select":
        "id,conversationId,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,hasAttachments",
    });
    if (options.pageToken) params.set("$skiptoken", options.pageToken);
    if (options.since) {
      // receivedDateTime is a Graph filterable Edm.DateTimeOffset property.
      params.set(
        "$filter",
        `receivedDateTime ge ${options.since.toISOString()}`,
      );
    }

    const page = await getJson(`${GRAPH_ME}/messages?${params}`, accessToken, "Graph messages");
    const rows = Array.isArray(page.value) ? page.value : [];

    let nextPageToken: string | null = null;
    const nextLink = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : null;
    if (nextLink) {
      try {
        nextPageToken = new URL(nextLink).searchParams.get("$skiptoken");
      } catch {
        nextPageToken = null;
      }
    }

    const messages = rows
      .map((row: Record<string, unknown>) =>
        toProviderMessage({
          providerMessageId: row.id,
          threadId: row.conversationId,
          subject: row.subject,
          from: (row.from as { emailAddress?: { address?: unknown } } | undefined)?.emailAddress
            ?.address,
          to: Array.isArray(row.toRecipients)
            ? (row.toRecipients as Array<{ emailAddress?: { address?: unknown } }>)
                .map((r) => r?.emailAddress?.address)
                .join(",")
            : undefined,
          snippet: row.bodyPreview,
          receivedAt: typeof row.receivedDateTime === "string" ? row.receivedDateTime : undefined,
          isRead: row.isRead === true,
          hasAttachments: row.hasAttachments === true,
          labels: [],
        }),
      )
      .filter((m): m is NonNullable<typeof m> => m !== null);

    return { messages, nextPageToken };
  }

  async sendMessage(
    accessToken: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const toRecipients = input.to.map((addr) => ({ emailAddress: { address: addr } }));
    const ccRecipients = input.cc?.map((addr) => ({ emailAddress: { address: addr } })) ?? [];
    const bccRecipients = input.bcc?.map((addr) => ({ emailAddress: { address: addr } })) ?? [];

    const bodyContent = input.html
      ? { contentType: "HTML", content: input.html }
      : { contentType: "Text", content: input.text ?? "" };

    const mail = {
      subject: input.subject,
      body: bodyContent,
      toRecipients,
      ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
      bccRecipients: bccRecipients.length > 0 ? bccRecipients : undefined,
    };

    let res: Response;
    try {
      res = await fetch(`${GRAPH_ME}/sendMail`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: mail }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError("Graph sendMail endpoint unreachable", "unavailable");
    }

    // Graph returns 202 Accepted on success (no body).
    if (res.status === 202) {
      // Graph doesn't return a message id from sendMail — we return a placeholder.
      // The caller can use the scheduledEmails id as the local reference.
      return { providerMessageId: "" };
    }

    if (res.status === 401) {
      throw new ProviderError("Access token rejected", "invalid_grant", res.status);
    }
    if (res.status === 429) {
      throw new ProviderError("Provider rate limited", "rate_limited", res.status);
    }
    throw new ProviderError(`Graph sendMail failed (${res.status})`, "unavailable", res.status);
  }

  async fetchMessageBody(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ProviderMessageBody> {
    const msg = await getJson(
      `${GRAPH_ME}/messages/${encodeURIComponent(providerMessageId)}?$select=body`,
      accessToken,
      "Graph message body",
    );
    const body = msg.body as { contentType?: string; content?: string } | undefined;
    if (!body?.content) return {};
    if (body.contentType === "html") {
      return { html: body.content };
    }
    return { text: body.content };
  }

  async listAttachments(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ProviderAttachmentMeta[]> {
    const page = await getJson(
      `${GRAPH_ME}/messages/${encodeURIComponent(providerMessageId)}/attachments?$select=id,name,contentType,size`,
      accessToken,
      "Graph attachments",
    );
    const rows = Array.isArray(page.value) ? page.value : [];
    return rows
      .filter(
        (a: Record<string, unknown>) =>
          typeof a.id === "string" && typeof a.name === "string",
      )
      .map((a: Record<string, unknown>) => ({
        providerAttachmentId: a.id as string,
        filename: a.name as string,
        mimeType: typeof a.contentType === "string" ? a.contentType : "application/octet-stream",
        sizeBytes: typeof a.size === "number" ? a.size : 0,
      }));
  }

  async getAttachment(
    accessToken: string,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(
        `${GRAPH_ME}/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(providerAttachmentId)}/$value`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new ProviderError("Graph attachment endpoint unreachable", "unavailable");
    }

    if (!res.ok) {
      if (res.status === 404) {
        throw new ProviderError("Attachment not found", "not_found", 404);
      }
      throw new ProviderError(`Graph attachment fetch failed (${res.status})`, "unavailable", res.status);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}

