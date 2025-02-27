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

/** Metadata snapshot of a provider mailbox message (no body content). */
export interface ProviderMessage {
  providerMessageId: string;
  threadId: string | null;
  subject: string | null;
  /** Normalized lowercase sender address. */
  fromAddress: string | null;
  /** Normalized lowercase recipient addresses. */
  toAddresses: string[];
  snippet: string | null;
  receivedAt: Date | null;
  isRead: boolean;
  hasAttachments: boolean;
  sizeBytes: number | null;
  labels: string[];
}

export interface ListMessagesOptions {
  maxResults?: number;
  pageToken?: string | null;
  /** Restrict results to messages received at/after this time. */
  since?: Date | null;
}

export interface ListMessagesResult {
  messages: ProviderMessage[];
  nextPageToken: string | null;
}

/** Payload for sending a single email through a provider. */
export interface SendMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain text body. */
  text?: string;
  /** HTML body. */
  html?: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface ProviderMessageBody {
  text?: string;
  html?: string;
}

export interface ProviderAttachmentMeta {
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
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
  /**
   * Lists message metadata ordered newest-first. Bodies are fetched lazily
   * by the inbox module — sync only stores metadata + snippet.
   */
  listMessages(
    accessToken: string,
    options?: ListMessagesOptions,
  ): Promise<ListMessagesResult>;
  /**
   * Sends a single outbound email. The adapter builds the provider-native
   * payload (RFC 2822 for Gmail, Graph JSON for Outlook) and returns the
   * provider-assigned message id.
   */
  sendMessage(
    accessToken: string,
    input: SendMessageInput,
  ): Promise<SendResult>;
  /** Fetches the plain-text and/or HTML body of a message. */
  fetchMessageBody(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ProviderMessageBody>;
  /** Lists attachment metadata for a message (no content). */
  listAttachments(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ProviderAttachmentMeta[]>;
  /** Downloads a single attachment's raw bytes. */
  getAttachment(
    accessToken: string,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Buffer>;
}

/** Error thrown by adapters on protocol/HTTP failures. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "unavailable"
      | "rate_limited"
      | "invalid_grant"
      | "invalid_response"
      | "not_found" = "unavailable",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
