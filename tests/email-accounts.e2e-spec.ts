import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "@/app.module";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import { ProviderError, type EmailProviderAdapter } from "@/providers/types";
import { emailAccounts } from "@/lib/db/schema";
import { closeTestDb, getTestDb } from "@tests/helpers/db";

const TOKENS = {
  accessToken: "ya29.fake-access-token",
  refreshToken: "1//fake-refresh-token",
};

function fakeAdapter(id: "gmail" | "outlook", configured = true): EmailProviderAdapter {
  return {
    id,
    displayName: id === "gmail" ? "Fake Gmail" : "Fake Outlook",
    isConfigured: () => configured,
    buildAuthorizationUrl: ({ state, redirectUri }) =>
      `https://fake.oauth/${id}/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async (code) => {
      if (code !== "good-code") {
        throw new ProviderError("Grant is invalid or expired", "invalid_grant", 400);
      }
      return { ...TOKENS, expiresInSec: 3600, scope: "mail.read" };
    },
    refresh: async (refreshToken) => {
      if (refreshToken !== TOKENS.refreshToken) {
        throw new ProviderError("Grant is invalid or expired", "invalid_grant", 400);
      }
      return { accessToken: "ya29.refreshed-token", expiresInSec: 3600 };
    },
    getProfile: async () => ({
      providerAccountId: "provider-account-1",
      emailAddress: "mailbox@example.com",
      displayName: "Example Mailbox",
    }),
    listMessages: async () => ({ messages: [], nextPageToken: null }),
    sendMessage: async () => ({ providerMessageId: "" }),
    fetchMessageBody: async () => ({ text: "", html: "" }),
    listAttachments: async () => [],
    getAttachment: async () => Buffer.from(""),
  };
}

class FakeMailer implements Mailer {
  public sent: MailInput[] = [];
  async send(input: MailInput): Promise<void> {
    this.sent.push(input);
  }
}

let app: INestApplication;
const db = getTestDb();

beforeAll(async () => {
  const adapters: EmailProviderAdapters = {
    gmail: fakeAdapter("gmail"),
    outlook: fakeAdapter("outlook", false),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAILER)
    .useClass(FakeMailer)
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
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", bearer),
  };
}

async function registerUser(email: string) {
  const res = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email, password: "Sup3rSecret!x", name: "Test" });
  expect(res.status).toBe(201);
  return res.body.data as { user: { id: string; email: string }; accessToken: string };
}

async function createWorkspace(token: string, name: string): Promise<string> {
  const res = await api(token).post("/api/v1/workspaces").send({ name });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function connectAccount(
  token: string,
  wsId: string,
  provider: string,
  code = "good-code",
) {
  const start = await api(token).post(
    `/api/v1/workspaces/${wsId}/email-accounts/oauth/${provider}/start`,
  );
  expect(start.status).toBe(201);
  const url = new URL(start.body.data.authorizationUrl);
  expect(url.hostname).toBe("fake.oauth");
  expect(url.searchParams.get("redirect_uri")).toContain(`/email-accounts/oauth/${provider}/callback`);
  const state = url.searchParams.get("state")!;
  return api(token)
    .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/${provider}/callback`)
    .query({ code, state });
}

describe("Email accounts / OAuth connections (e2e)", () => {
  it("completes the OAuth round trip and stores encrypted tokens", async () => {
    const owner = await registerUser("oauth-owner@example.com");
    const wsId = await createWorkspace(owner.accessToken, "OAuth WS");

    const cb = await connectAccount(owner.accessToken, wsId, "gmail");
    expect(cb.status).toBe(200);
    const account = cb.body.data;
    expect(account.provider).toBe("gmail");
    expect(account.emailAddress).toBe("mailbox@example.com");
    // Token material never appears in API responses.
    expect(JSON.stringify(account)).not.toContain(TOKENS.accessToken);
    expect(JSON.stringify(account)).not.toContain(TOKENS.refreshToken);

    // Tokens are encrypted at rest.
    const rows = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.id, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accessTokenCiphertext).not.toContain(TOKENS.accessToken);
    expect(rows[0]!.accessTokenCiphertext.startsWith("v1.")).toBe(true);

    // Listing shows the account without secrets.
    const list = await api(owner.accessToken).get(`/api/v1/workspaces/${wsId}/email-accounts`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("ciphertext");

    // The connection is auditable.
    const trail = await api(owner.accessToken).get(
      `/api/v1/workspaces/${wsId}/audit-logs?action=email_account.`,
    );
    expect(trail.status).toBe(200);
    expect(trail.body.data.map((e: { action: string }) => e.action)).toEqual([
      "email_account.connected",
    ]);
  });

  it("upserts on reconnect instead of duplicating the mailbox", async () => {
    const owner = await registerUser("oauth-reconnect@example.com");
    const wsId = await createWorkspace(owner.accessToken, "Reconnect WS");

    const first = await connectAccount(owner.accessToken, wsId, "gmail");
    expect(first.status).toBe(200);
    const second = await connectAccount(owner.accessToken, wsId, "gmail");
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(eq(emailAccounts.workspaceId, wsId));
    expect(rows).toHaveLength(1);
  });

  it("rejects tampered state, bad codes, and provider errors", async () => {
    const owner = await registerUser("oauth-guard@example.com");
    const wsId = await createWorkspace(owner.accessToken, "Guarded OAuth");

    const start = await api(owner.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/start`,
    );
    const state = new URL(start.body.data.authorizationUrl).searchParams.get("state")!;

    // Tampered state.
    const forged = `${state.slice(0, -4)}AAAA`;
    const tampered = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`)
      .query({ code: "good-code", state: forged });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error.code).toBe("OAUTH_STATE_INVALID");

    // State bound to a different provider than the route.
    const wrongRoute = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/outlook/callback`)
      .query({ code: "good-code", state });
    expect(wrongRoute.status).toBe(400);
    expect(wrongRoute.body.error.code).toBe("OAUTH_STATE_INVALID");

    // Bad authorization code -> invalid_grant -> validation error.
    const badCode = await connectAccount(owner.accessToken, wsId, "gmail", "stolen-code");
    expect(badCode.status).toBe(400);
    expect(badCode.body.error.code).toBe("VALIDATION_ERROR");

    // Consent declined by the user.
    const denied = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`)
      .query({ error: "access_denied", state });
    expect(denied.status).toBe(400);

    // Missing state entirely.
    const noState = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/callback`)
      .query({ code: "good-code" });
    expect(noState.status).toBe(400);
  });

  it("refuses unconfigured providers and enforces RBAC", async () => {
    const owner = await registerUser("oauth-rbac-owner@example.com");
    const member = await registerUser("oauth-rbac-member@example.com");
    const outsider = await registerUser("oauth-outsider@example.com");
    const wsId = await createWorkspace(owner.accessToken, "RBAC OAuth");

    // Outlook fake reports unconfigured -> 503.
    const unconfigured = await api(owner.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/oauth/outlook/start`,
    );
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    // Plain members cannot start a connection (member role lacks manage).
    const invited = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: member.user.email });
    expect(invited.status).toBe(201);
    const mailerRef = app.get(MAILER) as unknown as FakeMailer;
    const inviteToken = mailerRef.sent
      .map((m) => m.text.match(/invitations\/([A-Za-z0-9_-]+)/)?.[1])
      .filter(Boolean)
      .at(-1)!;
    await api(member.accessToken).post(`/api/v1/invitations/${inviteToken}/accept`).send();

    const memberStart = await api(member.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/oauth/gmail/start`,
    );
    expect(memberStart.status).toBe(403);
    expect(memberStart.body.error.code).toBe("FORBIDDEN");

    // Members can list; outsiders must not learn the workspace exists.
    const memberList = await api(member.accessToken).get(
      `/api/v1/workspaces/${wsId}/email-accounts`,
    );
    expect(memberList.status).toBe(200);
    const outsiderList = await api(outsider.accessToken).get(
      `/api/v1/workspaces/${wsId}/email-accounts`,
    );
    expect(outsiderList.status).toBe(404);

    // Unknown providers are rejected everywhere.
    const badProvider = await api(owner.accessToken).post(
      `/api/v1/workspaces/${wsId}/email-accounts/oauth/proton/start`,
    );
    expect(badProvider.status).toBe(400);
  });

  it("disconnects an account and clears its tokens", async () => {
    const owner = await registerUser("oauth-disconnect@example.com");
    const wsId = await createWorkspace(owner.accessToken, "Disconnect WS");
    const cb = await connectAccount(owner.accessToken, wsId, "gmail");
    const accountId = cb.body.data.id as string;

    const removed = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/email-accounts/${accountId}`,
    );
    expect(removed.status).toBe(200);

    const gone = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, accountId));
    expect(gone).toHaveLength(0);

    // Second disconnect -> 404; audit records both events.
    const again = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/email-accounts/${accountId}`,
    );
    expect(again.status).toBe(404);

    const trail = await api(owner.accessToken).get(
      `/api/v1/workspaces/${wsId}/audit-logs?action=email_account.`,
    );
    expect(trail.body.data.map((e: { action: string }) => e.action)).toEqual([
      "email_account.disconnected",
      "email_account.connected",
    ]);
  });
});
