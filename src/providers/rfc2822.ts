import type { SendMessageInput } from "@/providers/types";

/**
 * Builds a minimal RFC 2822 message from structured fields. The output is
 * ready for base64url encoding before handing to the Gmail API. Only the
 * fields present in the input are included — callers should validate the
 * input upstream (the messaging service enforces recipient limits, etc.).
 */
export function buildRfc2822Message(input: SendMessageInput, fromAddress: string): string {
  const lines: string[] = [];
  lines.push(`From: ${fromAddress}`);
  lines.push(`To: ${input.to.join(", ")}`);
  if (input.cc && input.cc.length > 0) lines.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc && input.bcc.length > 0) lines.push(`Bcc: ${input.bcc.join(", ")}`);
  lines.push(`Subject: ${input.subject}`);
  lines.push("MIME-Version: 1.0");

  if (input.html && input.text) {
    const boundary = `boundary_oryn_${Date.now()}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("");
    lines.push(input.text);
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("");
    lines.push(input.html);
    lines.push(`--${boundary}--`);
  } else if (input.html) {
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("");
    lines.push(input.html);
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("");
    lines.push(input.text ?? "");
  }

  return lines.join("\r\n");
}
