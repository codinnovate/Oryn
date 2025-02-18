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
  lastInvitationToken(): string {
    return this.sent.at(-1)!.text.match(/invitations\/([A-Za-z0-9_-]+)/)![1];
  }
}

let app: INestApplication;
let mailer: FakeMailer;

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
  mailer = moduleRef.get<Mailer>(MAILER) as FakeMailer;
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

describe("Workspaces API (e2e)", () => {
  it("creates a workspace with caller as owner and lists it", async () => {
    const { accessToken } = await registerUser("ws-owner@example.com");

    const created = await api(accessToken).post("/api/v1/workspaces").send({ name: "Acme" });
    expect(created.status).toBe(201);
    expect(created.body.data.slug).toBe("acme");
    const wsId = created.body.data.id;

    const list = await api(accessToken).get("/api/v1/workspaces");
    expect(list.status).toBe(200);
    expect(list.body.pagination).toMatchObject({ page: 1, total: 1 });
    expect(list.body.data[0].roleKeys).toEqual(["owner"]);

    const detail = await api(accessToken).get(`/api/v1/workspaces/${wsId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.name).toBe("Acme");

    // Anonymous access is rejected.
    const anon = await request(app.getHttpServer()).get(`/api/v1/workspaces/${wsId}`);
    expect(anon.status).toBe(401);

    // Malformed id -> validation error.
    const badId = await api(accessToken).get("/api/v1/workspaces/not-a-uuid");
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe("VALIDATION_ERROR");

    // Unknown but well-formed id -> not found.
    const missing = await api(accessToken).get(
      "/api/v1/workspaces/00000000-0000-4000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("enforces member visibility and owner-only updates", async () => {
    const owner = await registerUser("rbac-owner@example.com");
    const outsider = await registerUser("outsider@example.com");

    const created = await api(owner.accessToken)
      .post("/api/v1/workspaces")
      .send({ name: "Private WS" });
    const wsId = created.body.data.id;

    const peek = await api(outsider.accessToken).get(`/api/v1/workspaces/${wsId}`);
    expect(peek.status).toBe(404); // hidden, not forbidden

    const renameByOutsider = await api(outsider.accessToken)
      .patch(`/api/v1/workspaces/${wsId}`)
      .send({ name: "Mine now" });
    expect(renameByOutsider.status).toBe(404);

    const rename = await api(owner.accessToken)
      .patch(`/api/v1/workspaces/${wsId}`)
      .send({ name: "Renamed" });
    expect(rename.status).toBe(200);
    expect(rename.body.data.name).toBe("Renamed");
  });

  it("invites, previews, accepts and manages members end to end", async () => {
    const owner = await registerUser("flow-owner@example.com");
    const invitee = await registerUser("invitee@example.com");

    const ws = await api(owner.accessToken).post("/api/v1/workspaces").send({ name: "Flow" });
    const wsId = ws.body.data.id;

    const invited = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: invitee.user.email, roleKey: "member" });
    expect(invited.status).toBe(201);

    // Duplicate pending invitation is superseded, not duplicated.
    const again = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: invitee.user.email });
    expect(again.status).toBe(201);

    const token = mailer.lastInvitationToken();

    // Public preview leaks only minimal fields.
    const preview = await request(app.getHttpServer()).get(`/api/v1/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.workspaceName).toBe("Flow");
    expect(preview.body.data).not.toHaveProperty("emailNormalized");

    // A different authenticated account cannot consume the token.
    const stranger = await registerUser("stranger@example.com");
    const wrongAccept = await api(stranger.accessToken)
      .post(`/api/v1/invitations/${token}/accept`)
      .send();
    expect(wrongAccept.status).toBe(404);

    const accept = await api(invitee.accessToken)
      .post(`/api/v1/invitations/${token}/accept`)
      .send();
    expect(accept.status).toBe(200);
    expect(accept.body.data.status).toBe("active");

    // Token is single-use.
    const reuse = await api(invitee.accessToken)
      .post(`/api/v1/invitations/${token}/accept`)
      .send();
    expect(reuse.status).toBe(404);

    // Invitee can now see the workspace and members.
    const members = await api(invitee.accessToken).get(`/api/v1/workspaces/${wsId}/members`);
    expect(members.status).toBe(200);
    expect(members.body.data.map((m: { roleKeys: string[] }) => m.roleKeys).flat()).toContain(
      "owner",
    );

    // Member (no members:manage) cannot suspend anyone.
    const targetMemberId = members.body.data.find(
      (m: { userId: string }) => m.userId === invitee.user.id,
    ).id;
    const suspendByMember = await api(invitee.accessToken)
      .patch(`/api/v1/workspaces/${wsId}/members/${targetMemberId}`)
      .send({ status: "suspended" });
    expect(suspendByMember.status).toBe(403);

    // Owner suspends then removes the member.
    const suspend = await api(owner.accessToken)
      .patch(`/api/v1/workspaces/${wsId}/members/${targetMemberId}`)
      .send({ status: "suspended" });
    expect(suspend.status).toBe(200);

    const suspendedView = await api(invitee.accessToken).get(
      `/api/v1/workspaces/${wsId}`,
    );
    expect(suspendedView.status).toBe(403);

    const remove = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/members/${targetMemberId}`,
    );
    expect(remove.status).toBe(200);

    const gone = await api(invitee.accessToken).get(`/api/v1/workspaces/${wsId}`);
    expect(gone.status).toBe(404);
  });

  it("protects the owner from suspension/removal and role escalation", async () => {
    const owner = await registerUser("owner-guard@example.com");
    const ws = await api(owner.accessToken)
      .post("/api/v1/workspaces")
      .send({ name: "Guarded" });
    const wsId = ws.body.data.id;

    const members = await api(owner.accessToken).get(`/api/v1/workspaces/${wsId}/members`);
    const ownerMemberId = members.body.data[0].id as string;

    const selfSuspend = await api(owner.accessToken)
      .patch(`/api/v1/workspaces/${wsId}/members/${ownerMemberId}`)
      .send({ status: "suspended" });
    expect(selfSuspend.status).toBe(403);

    const escalate = await api(owner.accessToken)
      .patch(`/api/v1/workspaces/${wsId}/members/${ownerMemberId}`)
      .send({ roleKey: "admin" });
    expect(escalate.status).toBe(403);

    const selfRemove = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/members/${ownerMemberId}`,
    );
    expect(selfRemove.status).toBe(403);
  });

  it("revokes pending invitations", async () => {
    const owner = await registerUser("revoke-inv@example.com");
    const invitee = await registerUser("revoked-user@example.com");
    const ws = await api(owner.accessToken)
      .post("/api/v1/workspaces")
      .send({ name: "Revoke WS" });
    const wsId = ws.body.data.id;

    const invited = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: invitee.user.email });
    expect(invited.status).toBe(201);
    const invitationId = invited.body.data.id as string;

    const token = mailer.lastInvitationToken();
    const preview = await request(app.getHttpServer()).get(`/api/v1/invitations/${token}`);
    expect(preview.status).toBe(200);

    const revoked = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/invitations/${invitationId}`,
    );
    expect(revoked.status).toBe(200);

    // Revoked token no longer previews or accepts.
    const after = await request(app.getHttpServer()).get(`/api/v1/invitations/${token}`);
    expect(after.status).toBe(404);
    const accept = await api(invitee.accessToken)
      .post(`/api/v1/invitations/${token}/accept`)
      .send();
    expect(accept.status).toBe(404);
  });

  it("deletes a workspace as owner", async () => {
    const owner = await registerUser("delete-ws@example.com");
    const ws = await api(owner.accessToken)
      .post("/api/v1/workspaces")
      .send({ name: "Doomed" });
    const wsId = ws.body.data.id;

    const del = await api(owner.accessToken).delete(`/api/v1/workspaces/${wsId}`);
    expect(del.status).toBe(200);

    const gone = await api(owner.accessToken).get(`/api/v1/workspaces/${wsId}`);
    expect(gone.status).toBe(404);
  });
});
