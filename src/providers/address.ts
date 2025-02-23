import type { ProviderMessage } from "@/providers/types";

const EMAIL_IN_HEADER = /<?([^\s<>;,"]+@[^\s<>;,"]+)>?/;

/**
 * Extracts the first email address from an RFC 5322 header value such as
 * `"Ada Lovelace" <ada@example.com>` or `ben@example.com`. Provider payloads
 * are untrusted: anything without a plausible address becomes null.
 */
export function parseAddress(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = EMAIL_IN_HEADER.exec(header.trim());
  if (!match) return null;
  const address = match[1]!.toLowerCase();
  // Cheap sanity bound; real addresses never approach this length.
  if (address.length === 0 || address.length > 254 || !address.includes(".")) {
    return null;
  }
  return address;
}

/** Parses a comma-separated recipient header into normalized addresses. */
export function parseAddressList(header: unknown): string[] {
  if (typeof header !== "string") return [];
  const out: string[] = [];
  for (const part of header.split(",")) {
    const address = parseAddress(part);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

/**
 * Defensive mapping of a provider message payload onto ProviderMessage.
 * Every field is validated — provider responses must never be trusted.
 */
export function toProviderMessage(input: {
  providerMessageId: unknown;
  threadId?: unknown;
  subject?: unknown;
  from?: unknown;
  to?: unknown;
  snippet?: unknown;
  receivedAt?: unknown;
  isRead?: unknown;
  hasAttachments?: unknown;
  sizeBytes?: unknown;
  labels?: unknown;
}): ProviderMessage | null {
  const providerMessageId =
    typeof input.providerMessageId === "string" && input.providerMessageId
      ? input.providerMessageId
      : null;
  if (!providerMessageId) return null;

  let receivedAt: Date | null = null;
  if (typeof input.receivedAt === "string" || typeof input.receivedAt === "number") {
    const date = new Date(input.receivedAt);
    receivedAt = Number.isNaN(date.getTime()) ? null : date;
  } else if (input.receivedAt instanceof Date) {
    receivedAt = Number.isNaN(input.receivedAt.getTime()) ? null : input.receivedAt;
  }

  return {
    providerMessageId,
    threadId: typeof input.threadId === "string" && input.threadId ? input.threadId : null,
    subject: typeof input.subject === "string" ? input.subject.slice(0, 998) : null,
    fromAddress: parseAddress(input.from),
    toAddresses: parseAddressList(input.to),
    snippet: typeof input.snippet === "string" ? input.snippet.slice(0, 512) : null,
    receivedAt,
    isRead: input.isRead === true,
    hasAttachments: input.hasAttachments === true,
    sizeBytes:
      typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes)
        ? Math.max(0, Math.trunc(input.sizeBytes))
        : null,
    labels: Array.isArray(input.labels)
      ? input.labels.filter((l): l is string => typeof l === "string").slice(0, 100)
      : [],
  };
}
