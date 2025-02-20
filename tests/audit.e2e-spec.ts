import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "@/app.module";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";
import { closeTestDb } from "@tests/helpers/db";

class FakeMailer implements Mailer {
  public sent: MailInput[] = [];
  async send(input: MailInput): Promise<void> {
    this.sent.push(input);
  }
}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAILER)
    .useClass(FakeMailer)
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
    patch: (url: string) => request(app.getHttpServer()).patch(url).set("Authorization", bearer),
  };
}

async function registerUser(email: string) {
  const res = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email, password: "Sup3rSecret!x", name: "Test" });
  expect(res.status).toBe(201);
  return res.body.data as { user: { id: string; email: string }; accessToken: string };
}

/** Audit writes are intentionally fire-and-forget; poll briefly for visibility. */
async function eventually<T>(fn: () => Promise<T | null>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error("Condition not met within timeout");
}

describe("Audit API (e2e)", () => {
  it("records workspace lifecycle events and serves them to holders of audit_logs:read", async () => {
    const owner = await registerUser("audit-owner@example.com");
    const member = await registerUser("audit-member@example.com");
    const ws = await api(owner.accessToken).post("/api/v1/workspaces").send({ name: "AuditWS" });
    expect(ws.status).toBe(201);
    const wsId = ws.body.data.id as string;

    const invited = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: member.user.email });
    expect(invited.status).toBe(201);

    const mailerRef = app.get(MAILER) as unknown as FakeMailer;
    const token = mailerRef.sent
      .map((m) => m.text.match(/invitations\/([A-Za-z0-9_-]+)/)?.[1])
      .filter(Boolean)
      .at(-1)!;
    const accepted = await api(member.accessToken)
      .post(`/api/v1/invitations/${token}/accept`)
      .send();
    expect(accepted.status).toBe(200);

    const role = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/roles`)
      .send({ key: "auditor", name: "Auditor", permissionKeys: ["audit_logs:read"] });
    expect(role.status).toBe(201);

    // Owner sees every workspace-scoped event.
    const list = await eventually(async () => {
      const res = await api(owner.accessToken).get(`/api/v1/workspaces/${wsId}/audit-logs`);
      expect(res.status).toBe(200);
      const actions = res.body.data.map((e: { action: string }) => e.action);
      return ["workspace.created", "member.invited", "member.joined", "role.created"].every((a) =>
        actions.includes(a),
      )
        ? res.body
        : null;
    });
    expect(list.pagination.page).toBe(1);
    expect(list.pagination.total).toBeGreaterThanOrEqual(4);
    for (const entry of list.data) {
      expect(entry.actorUserId).toBeTruthy();
      expect(typeof entry.createdAt).toBe("string");
    }

    // Namespace filter narrows the trail.
    const filtered = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/audit-logs?action=role.`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.map((e: { action: string }) => e.action)).toEqual(["role.created"]);
    expect(filtered.body.data[0].metadata.key).toBe("auditor");
  });

  it("hides workspaces from non-members and blocks members without audit_logs:read", async () => {
    const owner = await registerUser("audit-guard-owner@example.com");
    const member = await registerUser("audit-guard-member@example.com");
    const outsider = await registerUser("audit-outsider@example.com");
    const ws = await api(owner.accessToken).post("/api/v1/workspaces").send({ name: "Guarded Audit" });
    const wsId = ws.body.data.id as string;

    // Non-members must not learn that the workspace exists.
    const outsiderRes = await api(outsider.accessToken).get(`/api/v1/workspaces/${wsId}/audit-logs`);
    expect(outsiderRes.status).toBe(404);
    expect(outsiderRes.body.error.code).toBe("RESOURCE_NOT_FOUND");

    // Plain members lack audit_logs:read.
    const invited = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: member.user.email });
    expect(invited.status).toBe(201);
    const mailerRef = app.get(MAILER) as unknown as FakeMailer;
    const token = mailerRef.sent
      .map((m) => m.text.match(/invitations\/([A-Za-z0-9_-]+)/)?.[1])
      .filter(Boolean)
      .at(-1)!;
    await api(member.accessToken).post(`/api/v1/invitations/${token}/accept`).send();

    const memberRes = await api(member.accessToken).get(`/api/v1/workspaces/${wsId}/audit-logs`);
    expect(memberRes.status).toBe(403);
    expect(memberRes.body.error.code).toBe("FORBIDDEN");
  });

  it("exposes the caller's own cross-workspace actions", async () => {
    const user = await registerUser("audit-self@example.com");
    const ws = await api(user.accessToken).post("/api/v1/workspaces").send({ name: "SelfWS" });
    const wsId = ws.body.data.id as string;

    const own = await eventually(async () => {
      const res = await api(user.accessToken).get("/api/v1/audit-logs");
      expect(res.status).toBe(200);
      const actions = res.body.data.map((e: { action: string }) => e.action);
      return actions.includes("user.registered") && actions.includes("workspace.created")
        ? res.body
        : null;
    });
    expect(own.pagination.total).toBeGreaterThanOrEqual(2);
    for (const entry of own.data) {
      expect(entry.actorUserId).toBe(user.user.id);
    }

    // Other users' events never leak into the personal feed.
    const other = await registerUser("audit-other@example.com");
    await api(other.accessToken).post("/api/v1/workspaces").send({ name: "OtherWS" });
    const after = await api(user.accessToken).get("/api/v1/audit-logs");
    expect(
      after.body.data.every((e: { actorUserId: string }) => e.actorUserId === user.user.id),
    ).toBe(true);
    void wsId;
  });

  it("validates query parameters", async () => {
    const owner = await registerUser("audit-validation@example.com");
    const ws = await api(owner.accessToken).post("/api/v1/workspaces").send({ name: "ValWS" });
    const wsId = ws.body.data.id as string;

    const badAction = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/audit-logs?action=bad action!`);
    expect(badAction.status).toBe(400);
    expect(badAction.body.error.code).toBe("VALIDATION_ERROR");

    const badPage = await api(owner.accessToken)
      .get(`/api/v1/workspaces/${wsId}/audit-logs?page=0`);
    expect(badPage.status).toBe(400);

    const badUuid = await api(owner.accessToken).get("/api/v1/workspaces/nope/audit-logs");
    expect(badUuid.status).toBe(400);

    const badLimit = await api(owner.accessToken).get("/api/v1/audit-logs?limit=1000");
    expect(badLimit.status).toBe(400);
  });
});
