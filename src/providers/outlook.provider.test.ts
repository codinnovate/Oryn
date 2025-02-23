import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutlookProvider } from "@/providers/outlook.provider";

const ACCESS_TOKEN = "eyJ0eXAiOiJKV1Q";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OutlookProvider.listMessages", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    process.env.MICROSOFT_CLIENT_SECRET = "client-secret";
    process.env.MICROSOFT_TENANT_ID = "common";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps Graph message payloads to ProviderMessage", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: "msg-1",
            conversationId: "conv-1",
            subject: "Hello",
            from: { emailAddress: { address: "alice@example.com" } },
            toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
            bodyPreview: "Hi there",
            receivedDateTime: "2025-06-15T10:30:00Z",
            isRead: true,
            hasAttachments: false,
          },
        ],
      }),
    );

    const provider = new OutlookProvider();
    const result = await provider.listMessages(ACCESS_TOKEN, {
      maxResults: 50,
      since: new Date("2025-01-01"),
    });

    expect(result.messages).toHaveLength(1);
    expect(result.nextPageToken).toBeNull();
    const msg = result.messages[0]!;
    expect(msg.providerMessageId).toBe("msg-1");
    expect(msg.threadId).toBe("conv-1");
    expect(msg.fromAddress).toBe("alice@example.com");
    expect(msg.toAddresses).toEqual(["bob@example.com"]);
    expect(msg.isRead).toBe(true);
    expect(msg.hasAttachments).toBe(false);
    expect(msg.receivedAt).toEqual(new Date("2025-06-15T10:30:00Z"));
  });

  it("extracts $skiptoken from @odata.nextLink", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        value: [{ id: "m1", isRead: false, hasAttachments: false, receivedDateTime: "2025-01-01T00:00:00Z" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc123",
      }),
    );

    const provider = new OutlookProvider();
    const result = await provider.listMessages(ACCESS_TOKEN);

    expect(result.messages).toHaveLength(1);
    expect(result.nextPageToken).toBe("abc123");
  });

  it("returns empty when value array is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));

    const provider = new OutlookProvider();
    const result = await provider.listMessages(ACCESS_TOKEN);

    expect(result.messages).toEqual([]);
    expect(result.nextPageToken).toBeNull();
  });

  it("includes $filter for since date", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
    const since = new Date("2025-06-01T00:00:00Z");

    const provider = new OutlookProvider();
    await provider.listMessages(ACCESS_TOKEN, { since });

    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    // URLSearchParams encodes "$" as "%24" and spaces as "+" and ":" as "%3A"
    expect(calledUrl).toContain("%24filter=receivedDateTime+ge+");
    expect(calledUrl).toContain("2025-06-01T00%3A00%3A00");
  });
});
