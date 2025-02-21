import { GmailProvider } from "@/providers/gmail.provider";
import { OutlookProvider } from "@/providers/outlook.provider";
import type { EmailProviderAdapter, ProviderId } from "@/providers/types";

export const EMAIL_PROVIDER_ADAPTERS = "EMAIL_PROVIDER_ADAPTERS";

export type EmailProviderAdapters = Record<ProviderId, EmailProviderAdapter>;

/** Real adapters; overridden in tests with fakes. */
export function createDefaultAdapters(): EmailProviderAdapters {
  return {
    gmail: new GmailProvider(),
    outlook: new OutlookProvider(),
  };
}
