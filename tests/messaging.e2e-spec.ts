import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "@/app.module";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import { ProviderError, type EmailProviderAdapter } from "@/providers/types";
import { emailAccounts, scheduledEmails } from "@/lib/db/schema";
import { closeTestDb, getTestDb } from "@tests/helpers/db";

const TOKENS = {
  accessToken: "ya29.fake-msg-access",
  refreshToken: "1//fake-msg-refresh",
};

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
      return { ...TOKENS, expiresInSec: 3600, scope: "mail.read mail.send" };
    },
    refresh: async () => ({ accessToken: "ya29.refreshed", expiresInSec: 3600 }),
    getProfile: async () => ({
      providerAccountId: "msg-provider-acct",
      emailAddress: "msg-user@example.com",
      displayName: "Msg User",
    }),
    listMessages: async () => ({ messages: [], nextPageToken: null }),
    sendMessage: async (_token, _input) => ({
      providerMessageId: `msg-sent-${Date.now()}`,
    }),
  };
}

let app: INestApplication;
const db = getTestDb();
let wsId: string;
let token: string;
let accountId: string;

function api(t: string) {
  const bearer = `Bearer ${t}`;
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", bearer),
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", bearer),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", bearer),
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

  // Register a test user
  const reg = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email: `messaging-e2e-${Date.now()}@test.com`, password: "Sup3rSecret!x", name: "Msg E2E" });
  expect(reg.status).toBe(201);
  token = reg.body.data.accessToken;

  // Create workspace
  const ws = await api(token).post("/api/v1/workspaces").send({ name: "Msg E2E WS" });
  expect(ws.status).toBe(201);
  wsId = ws.body.data.id;

  // Connect email account via OAuth flow
  const start = await api(token).post(
    `/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/start`,
  );
  expect(start.status).toBe(201);
  const url = new URL(start.body.data.authorizationUrl);
  const state = url.searchParams.get("state")!;

  const cb = await api(token).get(
    `/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`,
  ).query({ code: "good-code", state });
  expect(cb.status).toBe(200);
  accountId = cb.body.data.id;
});

afterAll(async () => {
  // Clean up scheduled emails
  await db.delete(scheduledEmails).where(eq(scheduledEmails.workspaceId, wsId));
  // Clean up the email account (fetched by workspace)
  await db.delete(emailAccounts).where(eq(emailAccounts.workspaceId, wsId));
  await app.close();
  await closeTestDb();
});

describe("Messaging (e2e)", () => {
  const base = "/api/v1";

  it("POST /messages/send returns 202 with id + jobId", async () => {
    const res = await api(token).post(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/send`,
    ).send({ to: "alice@example.com", subject: "Hi", text: "Hello" });
    expect(res.status).toBe(202);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.jobId).toBeDefined();
  });

  it("POST /messages/send returns 400 without text or html body", async () => {
    const res = await api(token).post(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/send`,
    ).send({ to: "alice@example.com", subject: "No body" });
    expect(res.status).toBe(400);
  });

  it("POST /messages/schedule returns 202 with future scheduledFor", async () => {
    const future = new Date(Date.now() + 7200_000).toISOString();
    const res = await api(token).post(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/schedule`,
    ).send({ to: "bob@example.com", subject: "Later", html: "<p>Later</p>", scheduledFor: future });
    expect(res.status).toBe(202);
    expect(res.body.data.id).toBeDefined();
  });

  it("POST /messages/schedule returns 400 with past scheduledFor", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const res = await api(token).post(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/schedule`,
    ).send({ to: "bob@example.com", subject: "Past", text: "Oops", scheduledFor: past });
    expect(res.status).toBe(400);
  });

  it("DELETE /messages/:messageId cancels a pending email", async () => {
    const createRes = await api(token).post(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/send`,
    ).send({ to: "cancel@test.com", subject: "Cancel me", text: "..." });
    const { id } = createRes.body.data;

    const res = await api(token).delete(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/${id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.cancelled).toBe(true);
  });

  it("DELETE /messages/:messageId returns 404 for non-existent id", async () => {
    const res = await api(token).delete(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(404);
  });

  it("GET /messages/scheduled lists only pending emails", async () => {
    // Send one with a unique subject to find it
    const uniqueSubject = `Scheduled-list-${Date.now()}`;
    await api(token).post(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/send`,
    ).send({ to: "list@test.com", subject: uniqueSubject, text: "..." });

    const res = await api(token).get(
      `${base}/workspaces/${wsId}/email-accounts/${accountId}/messages/scheduled`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const found = res.body.data.find((e: any) => e.subject === uniqueSubject);
    expect(found).toBeDefined();
    expect(found.status).toBe("pending");
    expect(found.to).toEqual(["list@test.com"]);
  });
});
