import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailProvider } from "@/providers/gmail.provider";

const ACCESS_TOKEN = "ya29.fake-token";
const PAGE_SIZE = 25;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GmailProvider.listMessages", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (url: string) => Response) {
    globalThis.fetch = vi.fn().mockImplementation(
      (input: string | URL) =>
        Promise.resolve(handler(String(input))),
    );
  }

  it("fetches message list then hydrates metadata for each id", async () => {
    stubFetch((url: string) => {
      if (url.includes("/messages?")) {
        return jsonResponse({
          messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }],
          nextPageToken: "p2",
        });
      }
      if (url.includes("/messages/m1?")) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX", "UNREAD"],
          sizeEstimate: 2048,
          snippet: "First message",
          internalDate: "1724500000000",
          payload: {
            headers: [
              { name: "Subject", value: "Hello" },
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
            ],
          },
        });
      }
      // m2
      return jsonResponse({
        id: "m2",
        threadId: "t2",
        labelIds: ["INBOX"],
        sizeEstimate: 1024,
        snippet: "Second",
        internalDate: "1724400000000",
        payload: {
          headers: [{ name: "From", value: "charlie@example.com" }],
        },
      });
    });

    const provider = new GmailProvider();
    const result = await provider.listMessages(ACCESS_TOKEN, {
      maxResults: PAGE_SIZE,
      since: new Date("2025-01-01"),
    });

    expect(result.messages).toHaveLength(2);
    expect(result.nextPageToken).toBe("p2");

    const first = result.messages[0]!;
    expect(first.providerMessageId).toBe("m1");
    expect(first.fromAddress).toBe("alice@example.com");
    expect(first.isRead).toBe(false); // UNREAD label
    expect(first.receivedAt).toEqual(new Date(1724500000000));

    const second = result.messages[1]!;
    expect(second.fromAddress).toBe("charlie@example.com");
    expect(second.isRead).toBe(true);
  });

  it("returns empty messages and null token when list is empty", async () => {
    stubFetch(() => jsonResponse({ messages: [] }));

    const provider = new GmailProvider();
    const result = await provider.listMessages(ACCESS_TOKEN);

    expect(result.messages).toEqual([]);
    expect(result.nextPageToken).toBeNull();
  });

  it("handles missing message list gracefully", async () => {
    stubFetch(() => jsonResponse({}));

    const provider = new GmailProvider();
    const result = await provider.listMessages(ACCESS_TOKEN);

    expect(result.messages).toEqual([]);
  });

  it("skips messages that fail individual fetch", async () => {
    stubFetch((url: string) => {
      if (url.includes("/messages?")) {
        return jsonResponse({ messages: [{ id: "m1" }, { id: "m2" }] });
      }
      if (url.includes("/messages/m1?")) {
        return jsonResponse({ error: { code: 404 } }, 404);
      }
      return jsonResponse({
        id: "m2",
        threadId: "t2",
        labelIds: [],
        snippet: "ok",
        internalDate: "1000",
        payload: { headers: [] },
      });
    });

    const provider = new GmailProvider();
    const result = await provider.listMessages(ACCESS_TOKEN);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.providerMessageId).toBe("m2");
  });
});
