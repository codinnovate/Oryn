/**
 * Gmail MIME part tree helpers. Used by GmailProvider and available for
 * direct unit testing.
 */

export interface GmailMimePart {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; data?: string; size?: number };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailMimePart[];
}

/** Walks MIME parts recursively looking for filename-bearing parts. */
export function collectAttachments(part: GmailMimePart): Array<{
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}> {
  const results: Array<{
    providerAttachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];
  if (part.filename && part.body?.attachmentId) {
    results.push({
      providerAttachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body.size ?? 0,
    });
  }
  if (part.parts) {
    for (const child of part.parts) {
      results.push(...collectAttachments(child));
    }
  }
  return results;
}

/** Checks whether any MIME part has a filename (i.e. message has attachments). */
export function hasAnyAttachment(part: GmailMimePart): boolean {
  if (part.filename) return true;
  if (part.parts) {
    return part.parts.some(hasAnyAttachment);
  }
  return false;
}

/**
 * Extracts the body content of a given MIME type from the full message payload.
 * For multipart messages, walks the part tree; for simple messages, reads the
 * root body directly.
 */
export function extractBody(part: GmailMimePart, mimeType: string): string {
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = extractBody(child, mimeType);
      if (found) return found;
    }
  }
  return "";
}
