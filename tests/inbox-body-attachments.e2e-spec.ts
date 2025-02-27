import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "@/app.module";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import { ProviderError, type EmailProviderAdapter, type ProviderMessageBody, type ProviderAttachmentMeta } from "@/providers/types";
import { emailMessages, emailAccounts } from "@/lib/db/schema";
import { closeTestDb, getTestDb } from "@tests/helpers/db";

const FAKE_BODY: ProviderMessageBody = {
  text: "Plain text body",
  html: "<p>HTML body</p>",
};

const FAKE_ATTACHMENTS: ProviderAttachmentMeta[] = [
  { providerAttachmentId: "att-1", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
  { providerAttachmentId: "att-2", filename: "image.png", mimeType: "image/png", sizeBytes: 512 },
];

const FAKE_ATTACHMENT_BUFFER = Buffer.from("fake-pdf-content");

function fakeAdapter(): EmailProviderAdapter {
  return {
    id: "gmail",
    displayName: "Fake Gmail",
    isConfigured: () => true,
    buildAuthorizationUrl: ({ state, redirectUri }) =>
      `https://fake.gmail/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async (code) => {
      if (code !== "good-code") {
        throw new ProviderError("Grant is invalid or expired", "invalid_grant", 400);
      }
      return { accessToken: "ya29.fake", refreshToken: "1//fake", expiresInSec: 3600, scope: "mail" };
    },
    refresh: async () => ({ accessToken: "ya29.refreshed", expiresInSec: 3600 }),
    getProfile: async () => ({
      providerAccountId: "inbox-test-acct",
      emailAddress: "inbox@example.com",
      displayName: "Inbox Test",
    }),
    listMessages: async () => ({ messages: [], nextPageToken: null }),
    sendMessage: async () => ({ providerMessageId: "" }),
    fetchMessageBody: async () => FAKE_BODY,
    listAttachments: async () => FAKE_ATTACHMENTS,
    getAttachment: async () => FAKE_ATTACHMENT_BUFFER,
  };
}

let app: NestExpressApplication;
const db = getTestDb();
let wsId: string;
let token: string;
let accountId: string;
let messageId: string;

function api(t: string) {
  const bearer = `Bearer ${t}`;
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", bearer),
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", bearer),
  };
}

beforeAll(async () => {
  const adapters: EmailProviderAdapters = {
    gmail: fakeAdapter(),
    outlook: fakeAdapter(),
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_PROVIDER_ADAPTERS)
    .useValue(adapters)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();

  // Register user
  const reg = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email: `inbox-body-${Date.now()}@test.com`, password: "Sup3rSecret!x", name: "Inbox Body" });
  expect(reg.status).toBe(201);
  token = reg.body.data.accessToken;

  // Create workspace
  const ws = await api(token).post("/api/v1/workspaces").send({ name: "Inbox Body WS" });
  expect(ws.status).toBe(201);
  wsId = ws.body.data.id;

  // Connect email account
  const start = await api(token).post(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/start`);
  expect(start.status).toBe(201);
  const url = new URL(start.body.data.authorizationUrl);
  const state = url.searchParams.get("state")!;
  const cb = await api(token).get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`)
    .query({ code: "good-code", state });
  expect(cb.status).toBe(200);
  accountId = cb.body.data.id;

  // Insert a fake synced message (without body — simulates sync metadata only)
  const [msg] = await db.insert(emailMessages).values({
    workspaceId: wsId,
    emailAccountId: accountId,
    providerMessageId: "gmail-msg-body-test",
    subject: "Test Body Message",
    fromAddress: "sender@example.com",
    toAddresses: ["inbox@example.com"],
    snippet: "Test snippet",
    direction: "inbound",
    isRead: true,
    hasAttachments: true,
    sizeBytes: 1024,
    labels: ["INBOX"],
    receivedAt: new Date("2025-06-15T10:00:00Z"),
  }).returning({ id: emailMessages.id });
  messageId = msg!.id;
});

afterAll(async () => {
  await db.delete(emailMessages).where(eq(emailMessages.workspaceId, wsId));
  await db.delete(emailAccounts).where(eq(emailAccounts.workspaceId, wsId));
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  // Reset bodyText/bodyHtml before each test so lazy fetch is exercised
  await db
    .update(emailMessages)
    .set({ bodyText: null, bodyHtml: null })
    .where(eq(emailMessages.id, messageId));
});

describe("Inbox body & attachments (e2e)", () => {
  const base = "/api/v1";

  it("GET /messages/:messageId/body lazily fetches and caches body", async () => {
    // First call — fetches from provider
    const res1 = await api(token).get(
      `${base}/workspaces/${wsId}/messages/${messageId}/body`,
    );
    expect(res1.status).toBe(200);
    expect(res1.body.data.text).toBe("Plain text body");
    expect(res1.body.data.html).toBe("<p>HTML body</p>");

    // Verify it was cached in the DB
    const [cached] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId))
      .limit(1);
    expect(cached!.bodyText).toBe("Plain text body");
    expect(cached!.bodyHtml).toBe("<p>HTML body</p>");

    // Second call — returns from cache (no provider call needed)
    const res2 = await api(token).get(
      `${base}/workspaces/${wsId}/messages/${messageId}/body`,
    );
    expect(res2.status).toBe(200);
    expect(res2.body.data.text).toBe("Plain text body");
  });

  it("GET /messages/:messageId/body returns 404 for unknown message", async () => {
    const res = await api(token).get(
      `${base}/workspaces/${wsId}/messages/00000000-0000-0000-0000-000000000000/body`,
    );
    expect(res.status).toBe(404);
  });

  it("GET /messages/:messageId/attachments lazily fetches and caches attachments", async () => {
    const res = await api(token).get(
      `${base}/workspaces/${wsId}/messages/${messageId}/attachments`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].filename).toBe("doc.pdf");
    expect(res.body.data[0].mimeType).toBe("application/pdf");
    expect(res.body.data[1].filename).toBe("image.png");

    // Second call — returns from cache
    const res2 = await api(token).get(
      `${base}/workspaces/${wsId}/messages/${messageId}/attachments`,
    );
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(2);
  });

  it("GET /messages/:messageId/attachments returns 404 for unknown message", async () => {
    const res = await api(token).get(
      `${base}/workspaces/${wsId}/messages/00000000-0000-0000-0000-000000000000/attachments`,
    );
    expect(res.status).toBe(404);
  });

  it("GET /messages/:messageId/attachments/:attachmentId downloads an attachment", async () => {
    // First ensure attachments are cached
    await api(token).get(`${base}/workspaces/${wsId}/messages/${messageId}/attachments`);

    // Fetch the attachment row to get its UUID
    const atts = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId))
      .limit(1);
    expect(atts).toHaveLength(1);

    // Get the actual attachment row
    const { emailAttachments } = await import("@/lib/db/schema");
    const [att] = await db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.messageId, messageId))
      .limit(1);
    expect(att).toBeDefined();

    const res = await api(token).get(
      `${base}/workspaces/${wsId}/messages/${messageId}/attachments/${att!.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("doc.pdf");
    expect(res.body).toEqual(Buffer.from("fake-pdf-content"));
  });

  it("GET /messages/:messageId/attachments/:attachmentId returns 404 for unknown attachment", async () => {
    const res = await api(token).get(
      `${base}/workspaces/${wsId}/messages/${messageId}/attachments/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(404);
  });
});
