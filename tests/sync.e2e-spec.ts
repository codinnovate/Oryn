import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "@/app.module";
import { emailAccounts } from "@/lib/db/schema";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import { ProviderError, type EmailProviderAdapter } from "@/providers/types";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { closeTestDb, getTestDb } from "@tests/helpers/db";

const TOKENS = {
  accessToken: "ya29.fake-access-token",
  refreshToken: "1//fake-refresh-token",
};

function fakeAdapter(id: "gmail" | "outlook"): EmailProviderAdapter {
  return {
    id,
    displayName: id === "gmail" ? "Fake Gmail" : "Fake Outlook",
    isConfigured: () => true,
    buildAuthorizationUrl: ({ state, redirectUri }) =>
      `https://fake.oauth/${id}/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async () => ({
      ...TOKENS,
      expiresInSec: 3600,
      scope: "mail.read",
    }),
    refresh: async () => ({
      accessToken: "ya29.refreshed",
      expiresInSec: 3600,
    }),
    getProfile: async () => ({
      providerAccountId: "provider-account-1",
      emailAddress: "mailbox@example.com",
      displayName: "Example Mailbox",
    }),
    listMessages: async () => ({
      messages: [],
      nextPageToken: null,
    }),
    sendMessage: async () => ({ providerMessageId: "" }),
  };
}

// Capture enqueue calls so we can assert without a real Redis
const enqueueCalls: { queue: string; jobName: string; data: unknown }[] = [];

vi.mock("@/lib/queue/queue.service", () => {
  return {
    QueueService: class FakeQueueService {
      get names() {
        return QUEUE_NAMES;
      }
      async enqueue(name: string, jobName: string, data: unknown) {
        enqueueCalls.push({ queue: name, jobName, data });
        return `fake-job-${enqueueCalls.length}`;
      }
      async onApplicationShutdown() {}
    },
  };
});

let app: INestApplication;
const db = getTestDb();

beforeAll(async () => {
  enqueueCalls.length = 0;
  const adapters: EmailProviderAdapters = {
    gmail: fakeAdapter("gmail"),
    outlook: fakeAdapter("outlook"),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EMAIL_PROVIDER_ADAPTERS)
    .useValue(adapters)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

function api(token: string) {
  const bearer = `Bearer ${token}`;
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", bearer),
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", bearer),
    delete: (url: string) =>
      request(app.getHttpServer()).delete(url).set("Authorization", bearer),
  };
}

async function registerUser(email: string) {
  const res = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email, password: "Sup3rSecret!x", name: "Test" });
  expect(res.status).toBe(201);
  return res.body.data as { user: { id: string }; accessToken: string };
}

async function createWorkspace(token: string, name: string) {
  const res = await api(token).post("/api/v1/workspaces").send({ name });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function connectAccount(token: string, wsId: string) {
  const start = await api(token).post(
    `/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/start`,
  );
  const url = new URL(start.body.data.authorizationUrl);
  const state = url.searchParams.get("state")!;
  const cb = await api(token)
    .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`)
    .query({ code: "good-code", state });
  expect(cb.status).toBe(200);
  return cb.body.data.id as string;
}

describe("Sync endpoint (e2e)", () => {
  it("returns 202 with a job id and enqueues a sync job", async () => {
    const owner = await registerUser("sync-owner@example.com");
    const wsId = await createWorkspace(owner.accessToken, "Sync WS");
    const accountId = await connectAccount(owner.accessToken, wsId);

    const res = await api(owner.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/${accountId}/sync`,
    );
    expect(res.status).toBe(202);
    expect(res.body.data.jobId).toBeDefined();
    expect(typeof res.body.data.jobId).toBe("string");
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.queue).toBe("email-sync");
    expect(enqueueCalls[0]!.data).toEqual({
      workspaceId: wsId,
      emailAccountId: accountId,
    });
  });

  it("returns 404 for unknown account", async () => {
    const owner = await registerUser("sync-404@example.com");
    const wsId = await createWorkspace(owner.accessToken, "Sync WS 2");
    const fakeId = "00000000-0000-4000-8000-000000000099";

    const res = await api(owner.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/${fakeId}/sync`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("returns 409 for inactive accounts", async () => {
    const owner = await registerUser("sync-revoked@example.com");
    const wsId = await createWorkspace(owner.accessToken, "Revoked WS");
    const accountId = await connectAccount(owner.accessToken, wsId);

    // Mark account as revoked in DB
    await db
      .update(emailAccounts)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(emailAccounts.id, accountId));

    const res = await api(owner.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/${accountId}/sync`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ACCOUNT_NOT_CONNECTED");

    // Restore for other tests / cleanup
    await db
      .update(emailAccounts)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(emailAccounts.id, accountId));
  });
});
