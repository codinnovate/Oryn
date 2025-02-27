import { describe, it, expect } from "vitest";
import {
  collectAttachments,
  extractBody,
  hasAnyAttachment,
  type GmailMimePart,
} from "@/providers/gmail.mime";

describe("Gmail MIME helpers", () => {
  describe("collectAttachments", () => {
    it("returns empty array for a simple text message", () => {
      const part: GmailMimePart = {
        mimeType: "text/plain",
        body: { data: Buffer.from("hello").toString("base64url"), size: 5 },
      };
      expect(collectAttachments(part)).toEqual([]);
    });

    it("collects a single attachment", () => {
      const part: GmailMimePart = {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from("body").toString("base64url"), size: 4 },
          },
          {
            mimeType: "application/pdf",
            filename: "doc.pdf",
            body: { attachmentId: "att-1", size: 2048 },
          },
        ],
      };
      const result = collectAttachments(part);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        providerAttachmentId: "att-1",
        filename: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      });
    });

    it("collects nested attachments from multipart/alternative", () => {
      const part: GmailMimePart = {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: "abc" } },
              { mimeType: "text/html", body: { data: "def" } },
            ],
          },
          {
            mimeType: "image/png",
            filename: "logo.png",
            body: { attachmentId: "att-2", size: 512 },
          },
          {
            mimeType: "application/zip",
            filename: "archive.zip",
            body: { attachmentId: "att-3", size: 4096 },
          },
        ],
      };
      const result = collectAttachments(part);
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.filename)).toEqual(["logo.png", "archive.zip"]);
    });

    it("skips parts without attachmentId", () => {
      const part: GmailMimePart = {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "image/png",
            filename: "image.png",
            body: { size: 100 }, // missing attachmentId
          },
        ],
      };
      expect(collectAttachments(part)).toEqual([]);
    });

    it("defaults mimeType to application/octet-stream when missing", () => {
      const part: GmailMimePart = {
        filename: "mystery",
        body: { attachmentId: "att-x" },
      };
      const result = collectAttachments(part);
      expect(result[0]!.mimeType).toBe("application/octet-stream");
    });
  });

  describe("hasAnyAttachment", () => {
    it("returns false for text-only message", () => {
      const part: GmailMimePart = {
        mimeType: "text/plain",
        body: { data: "abc" },
      };
      expect(hasAnyAttachment(part)).toBe(false);
    });

    it("returns true for a message with an attachment", () => {
      const part: GmailMimePart = {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: "abc" } },
          { mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "a1" } },
        ],
      };
      expect(hasAnyAttachment(part)).toBe(true);
    });

    it("returns true for deeply nested attachment", () => {
      const part: GmailMimePart = {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "multipart/mixed",
                parts: [
                  { mimeType: "text/plain", body: { data: "x" } },
                  { mimeType: "image/jpeg", filename: "photo.jpg", body: { attachmentId: "a2" } },
                ],
              },
            ],
          },
        ],
      };
      expect(hasAnyAttachment(part)).toBe(true);
    });
  });

  describe("extractBody", () => {
    it("extracts text/plain from a simple message", () => {
      const data = Buffer.from("Hello, world!").toString("base64url");
      const part: GmailMimePart = {
        mimeType: "text/plain",
        body: { data, size: 13 },
      };
      expect(extractBody(part, "text/plain")).toBe("Hello, world!");
    });

    it("extracts text/html from a multipart/alternative message", () => {
      const html = Buffer.from("<p>Hello</p>").toString("base64url");
      const part: GmailMimePart = {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("Hello").toString("base64url") } },
          { mimeType: "text/html", body: { data: html } },
        ],
      };
      expect(extractBody(part, "text/html")).toBe("<p>Hello</p>");
    });

    it("returns empty string when mime type not found", () => {
      const part: GmailMimePart = {
        mimeType: "text/plain",
        body: { data: Buffer.from("abc").toString("base64url") },
      };
      expect(extractBody(part, "text/html")).toBe("");
    });

    it("handles deeply nested multipart", () => {
      const html = Buffer.from("<b>deep</b>").toString("base64url");
      const part: GmailMimePart = {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: Buffer.from("deep").toString("base64url") } },
              { mimeType: "text/html", body: { data: html } },
            ],
          },
          { mimeType: "image/png", filename: "img.png", body: { attachmentId: "a1" } },
        ],
      };
      expect(extractBody(part, "text/plain")).toBe("deep");
      expect(extractBody(part, "text/html")).toBe("<b>deep</b>");
    });

    it("returns empty string for message with no body data", () => {
      const part: GmailMimePart = {
        mimeType: "text/plain",
        body: {},
      };
      expect(extractBody(part, "text/plain")).toBe("");
    });
  });
});
