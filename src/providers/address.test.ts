import { describe, it, expect } from "vitest";
import { parseAddress, parseAddressList, toProviderMessage } from "@/providers/address";

describe("parseAddress", () => {
  it("extracts address from RFC 5322 formatted header", () => {
    expect(parseAddress('"Ada Lovelace" <ada@example.com>')).toBe("ada@example.com");
  });

  it("handles bare address", () => {
    expect(parseAddress("ben@example.com")).toBe("ben@example.com");
  });

  it("returns null for non-string input", () => {
    expect(parseAddress(undefined)).toBeNull();
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress(123)).toBeNull();
  });

  it("returns null for empty or absurd strings", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("<>")).toBeNull();
    expect(parseAddress("x".repeat(300))).toBeNull();
  });

  it("normalizes to lowercase", () => {
    expect(parseAddress("FOO@BAR.COM")).toBe("foo@bar.com");
  });

  it("returns null when no plausible address found", () => {
    expect(parseAddress("no address here")).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("splits comma-separated addresses", () => {
    expect(parseAddressList("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("deduplicates addresses", () => {
    expect(parseAddressList("a@x.com, a@x.com")).toEqual(["a@x.com"]);
  });

  it("returns empty array for non-string", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it("handles RFC 5322 formatted entries", () => {
    const result = parseAddressList(
      '"Alice" <alice@example.com>, bob@example.com',
    );
    expect(result).toEqual(["alice@example.com", "bob@example.com"]);
  });
});

describe("toProviderMessage", () => {
  it("maps a valid payload to ProviderMessage", () => {
    const msg = toProviderMessage({
      providerMessageId: "msg-1",
      threadId: "thread-1",
      subject: "Hello",
      from: "alice@example.com",
      to: "bob@example.com",
      snippet: "Hi there",
      receivedAt: "2025-06-15T10:30:00Z",
      isRead: true,
      hasAttachments: false,
      sizeBytes: 4096,
      labels: ["INBOX"],
    });
    expect(msg).toEqual({
      providerMessageId: "msg-1",
      threadId: "thread-1",
      subject: "Hello",
      fromAddress: "alice@example.com",
      toAddresses: ["bob@example.com"],
      snippet: "Hi there",
      receivedAt: new Date("2025-06-15T10:30:00Z"),
      isRead: true,
      hasAttachments: false,
      sizeBytes: 4096,
      labels: ["INBOX"],
    });
  });

  it("returns null when providerMessageId is missing", () => {
    expect(toProviderMessage({ providerMessageId: "" })).toBeNull();
    expect(toProviderMessage({ providerMessageId: null })).toBeNull();
  });

  it("truncates long subjects", () => {
    const msg = toProviderMessage({
      providerMessageId: "m1",
      subject: "x".repeat(2000),
    });
    expect(msg!.subject!.length).toBe(998);
  });

  it("handles invalid receivedAt gracefully", () => {
    const msg = toProviderMessage({
      providerMessageId: "m1",
      receivedAt: "not-a-date",
    });
    expect(msg!.receivedAt).toBeNull();
  });

  it("coerces negative sizeBytes to 0", () => {
    const msg = toProviderMessage({
      providerMessageId: "m1",
      sizeBytes: -100,
    });
    expect(msg!.sizeBytes).toBe(0);
  });

  it("caps labels array to 100 entries", () => {
    const labels = Array.from({ length: 200 }, (_, i) => `L${i}`);
    const msg = toProviderMessage({
      providerMessageId: "m1",
      labels,
    });
    expect(msg!.labels.length).toBe(100);
  });

  it("drops non-string labels", () => {
    const msg = toProviderMessage({
      providerMessageId: "m1",
      labels: ["OK", 123, null, "ALSO_OK"],
    });
    expect(msg!.labels).toEqual(["OK", "ALSO_OK"]);
  });
});
