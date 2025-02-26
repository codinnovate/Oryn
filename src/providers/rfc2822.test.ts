import { describe, it, expect } from "vitest";
import { buildRfc2822Message } from "@/providers/rfc2822";
import type { SendMessageInput } from "@/providers/types";

describe("buildRfc2822Message", () => {
  const base: SendMessageInput = {
    to: ["alice@example.com"],
    subject: "Hello",
    text: "Plain body",
  };

  it("builds a minimal text-only message", () => {
    const msg = buildRfc2822Message(base, "sender@example.com");
    expect(msg).toContain("From: sender@example.com");
    expect(msg).toContain("To: alice@example.com");
    expect(msg).toContain("Subject: Hello");
    expect(msg).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(msg).toContain("Plain body");
    expect(msg).not.toContain("Cc:");
    expect(msg).not.toContain("Bcc:");
    expect(msg).toContain("MIME-Version: 1.0");
  });

  it("includes Cc and Bcc headers when present", () => {
    const msg = buildRfc2822Message(
      { ...base, cc: ["bob@example.com"], bcc: ["carol@example.com"] },
      "sender@example.com",
    );
    expect(msg).toContain("Cc: bob@example.com");
    expect(msg).toContain("Bcc: carol@example.com");
  });

  it("builds a multipart/alternative message when both text and html provided", () => {
    const msg = buildRfc2822Message(
      { ...base, html: "<p>Hello</p>" },
      "sender@example.com",
    );
    expect(msg).toContain("Content-Type: multipart/alternative");
    expect(msg).toContain("text/plain; charset=UTF-8");
    expect(msg).toContain("text/html; charset=UTF-8");
    expect(msg).toContain("Plain body");
    expect(msg).toContain("<p>Hello</p>");
  });

  it("builds html-only message when only html provided", () => {
    const msg = buildRfc2822Message(
      { to: ["a@b.com"], subject: "Hi", html: "<b>Bold</b>" },
      "from@x.com",
    );
    expect(msg).toContain("Content-Type: text/html; charset=UTF-8");
    expect(msg).toContain("<b>Bold</b>");
    expect(msg).not.toContain("multipart");
  });

  it("uses CRLF line endings per RFC 2822", () => {
    const msg = buildRfc2822Message(base, "sender@example.com");
    // The first line ends with \r\n
    const lines = msg.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    // No bare \n without preceding \r
    expect(msg).not.toMatch(/[^\r]\n/);
  });

  it("handles multiple recipients in To", () => {
    const msg = buildRfc2822Message(
      { ...base, to: ["a@x.com", "b@x.com"] },
      "from@x.com",
    );
    expect(msg).toContain("To: a@x.com, b@x.com");
  });
});
