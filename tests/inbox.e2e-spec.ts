import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "@/app.module";
import { emailAccounts, emailMessages } from "@/lib/db/schema";
import { encryptSecret } from "@/lib/crypto/secrets";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import type { EmailProviderAdapter } from "@/providers/types";
import { closeTestDb, getTestDb } from "@tests/helpers/db";

vi.mock("@/lib/queue/queue.service", () => ({
  QueueService: class {
    get names() { return QUEUE_NAMES; }
    async enqueue() { return "fake-job"; }
    async onApplicationShutdown() {}
  },
}));

let app: INestApplication;
const db = getTestDb();

const EMAIL_ACCOUNT_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";

function fakeAdapter(): EmailProviderAdapter {
  return {
    id: "gmail",
    displayName: "Fake",
    isConfigured: () => true,
    buildAuthorizationUrl: ({ state, redirectUri }) =>
      `https://fake.oauth/gmail/authorize?state=${state}&redirect_uri=${redirectUri}`,
    exchangeCode: async () => ({ accessToken: "fake", expiresInSec: 3600 }),
    refresh: async () => ({ accessToken: "fake", expiresInSec: 3600 }),
    getProfile: async () => ({
      providerAccountId: "inbox-e2e-1",
      emailAddress: "inbox@test.com",
      displayName: "Inbox Test",
    }),
    listMessages: async () => ({ messages: [], nextPageToken: null }),
    sendMessage: async () => ({ providerMessageId: "" }),
    fetchMessageBody: async () => ({ text: "", html: "" }),
    listAttachments: async () => [],
    getAttachment: async () => Buffer.from(""),
  };
}

beforeAll(async () => {
  const adapters: EmailProviderAdapters = { gmail: fakeAdapter(), outlook: fakeAdapter() };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_PROVIDER_ADAPTERS)
    .useValue(adapters)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();

  // Register user + workspace + account via API
  const reg = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email: "inbox-e2e@test.com", password: "Sup3rSecret!x", name: "Test" });
  const { accessToken, user } = reg.body.data;

  const ws = await request(app.getHttpServer())
    .post("/api/v1/workspaces")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ name: "Inbox E2E WS" });
  const wsId = ws.body.data.id;

  // Connect account via OAuth
  const start = await request(app.getHttpServer())
    .post(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/start`)
    .set("Authorization", `Bearer ${accessToken}`);
  const url = new URL(start.body.data.authorizationUrl);
  const state = url.searchParams.get("state")!;
  const cb = await request(app.getHttpServer())
    .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`)
    .query({ code: "good-code", state });
  expect(cb.status).toBe(200);
  const account = cb.body.data;

  // Seed test messages directly in the DB
  await db.insert(emailMessages).values([
    {
      id: MESSAGE_ID,
      workspaceId: wsId,
      emailAccountId: account.id,
      providerMessageId: "gmail-inbox-1",
      subject: "Hello Inbox",
      fromAddress: "sender@test.com",
      toAddresses: ["inbox@test.com"],
      snippet: "Testing the inbox",
      direction: "inbound",
      isRead: false,
      hasAttachments: false,
      sizeBytes: 1024,
      labels: ["INBOX"],
      receivedAt: new Date("2025-08-01T12:00:00Z"),
    },
    {
      workspaceId: wsId,
      emailAccountId: account.id,
      providerMessageId: "gmail-inbox-2",
      subject: "Re: Meeting notes",
      fromAddress: "inbox@test.com",
      toAddresses: ["sender@test.com"],
      snippet: "Here are the notes",
      direction: "outbound",
      isRead: true,
      hasAttachments: true,
      sizeBytes: 4096,
      labels: ["SENT"],
      receivedAt: new Date("2025-08-02T14:00:00Z"),
    },
  ]).onConflictDoNothing();

  // Attach wsId and accessToken to global for tests
  (globalThis as Record<string, unknown>).__inboxWsId = wsId;
  (globalThis as Record<string, unknown>).__inboxToken = accessToken;
});

afterAll(async () => {
  const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
  if (wsId) {
    await db.delete(emailMessages).where(eq(emailMessages.workspaceId, wsId));
  }
  await app?.close();
  await closeTestDb();
});

function api(token: string) {
  const bearer = `Bearer ${token}`;
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", bearer),
    patch: (url: string) =>
      request(app.getHttpServer()).patch(url).set("Authorization", bearer),
  };
}

describe("Inbox API (e2e)", () => {
  it("GET /messages returns paginated list", async () => {
    const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
    const token = (globalThis as Record<string, unknown>).__inboxToken as string;

    const res = await api(token).get(`/api/v1/workspaces/${wsId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it("GET /messages filters by isRead", async () => {
    const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
    const token = (globalThis as Record<string, unknown>).__inboxToken as string;

    const res = await api(token).get(
      `/api/v1/workspaces/${wsId}/messages?isRead=false`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.every((m: { isRead: boolean }) => m.isRead === false)).toBe(true);
  });

  it("GET /messages filters by direction", async () => {
    const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
    const token = (globalThis as Record<string, unknown>).__inboxToken as string;

    const res = await api(token).get(
      `/api/v1/workspaces/${wsId}/messages?direction=outbound`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].direction).toBe("outbound");
  });

  it("GET /messages/:id returns single message", async () => {
    const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
    const token = (globalThis as Record<string, unknown>).__inboxToken as string;

    const res = await api(token).get(
      `/api/v1/workspaces/${wsId}/messages/${MESSAGE_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.subject).toBe("Hello Inbox");
    expect(res.body.data.fromAddress).toBe("sender@test.com");
  });

  it("GET /messages/:id returns 404 for unknown message", async () => {
    const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
    const token = (globalThis as Record<string, unknown>).__inboxToken as string;
    const fakeId = "40000000-0000-4000-8000-000000000099";

    const res = await api(token).get(
      `/api/v1/workspaces/${wsId}/messages/${fakeId}`,
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /messages/:id updates isRead", async () => {
    const wsId = (globalThis as Record<string, unknown>).__inboxWsId as string;
    const token = (globalThis as Record<string, unknown>).__inboxToken as string;

    const res = await api(token)
      .patch(`/api/v1/workspaces/${wsId}/messages/${MESSAGE_ID}`)
      .send({ isRead: true });
    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);

    // Reset
    await api(token)
      .patch(`/api/v1/workspaces/${wsId}/messages/${MESSAGE_ID}`)
      .send({ isRead: false });
  });
});
