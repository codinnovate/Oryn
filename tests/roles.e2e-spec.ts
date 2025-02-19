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

describe("Roles API (e2e)", () => {
  it("lists global permissions for authenticated users", async () => {
    const { accessToken } = await registerUser("perm-list@example.com");
    const res = await api(accessToken).get("/api/v1/permissions");
    expect(res.status).toBe(200);
    const keys = res.body.data.map((p: { key: string }) => p.key);
    expect(keys).toContain("emails:read");
    expect(keys).toContain("roles:manage");
  });

  it("creates, lists, updates and deletes custom roles (owner has roles:manage)", async () => {
    const owner = await registerUser("roles-owner@example.com");
    const ws = await api(owner.accessToken)
      .post("/api/v1/workspaces")
      .send({ name: "RoleWS" });
    expect(ws.status).toBe(201);
    const wsId = ws.body.data.id as string;

    // System roles are listed.
    const list = await api(owner.accessToken).get(`/api/v1/workspaces/${wsId}/roles`);
    expect(list.status).toBe(200);
    expect(
      list.body.data.map((r: { key: string }) => r.key).sort(),
    ).toEqual(["admin", "member", "owner", "viewer"]);

    // Create a custom role.
    const created = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/roles`)
      .send({
        key: "billing",
        name: "Billing",
        description: "Manages billing data",
        permissionKeys: ["analytics:read"],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.isSystem).toBe(false);
    expect(created.body.data.permissionKeys).toEqual(["analytics:read"]);
    const roleId = created.body.data.id as string;

    // Duplicate key rejected; reserved keys rejected; unknown keys rejected.
    const dup = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/roles`)
      .send({ key: "billing", name: "Billing 2", permissionKeys: [] });
    expect(dup.status).toBe(409);

    const reserved = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/roles`)
      .send({ key: "owner", name: "Fake owner", permissionKeys: [] });
    expect(reserved.status).toBe(400);

    const unknownKey = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/roles`)
      .send({ key: "x-role", name: "X", permissionKeys: ["not:a-permission"] });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error.code).toBe("VALIDATION_ERROR");

    // Update permission set.
    const updated = await api(owner.accessToken)
      .patch(`/api/v1/workspaces/${wsId}/roles/${roleId}`)
      .send({ permissionKeys: ["analytics:read", "audit_logs:read"] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissionKeys).toEqual([
      "analytics:read",
      "audit_logs:read",
    ]);

    // System role is immutable.
    const systemRole = list.body.data.find((r: { key: string }) => r.key === "member");
    const touchSystem = await api(owner.accessToken)
      .patch(`/api/v1/workspaces/${wsId}/roles/${systemRole.id}`)
      .send({ name: "New name" });
    expect(touchSystem.status).toBe(403);

    const delSystem = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/roles/${systemRole.id}`,
    );
    expect(delSystem.status).toBe(403);

    // Delete the custom role while unassigned.
    const del = await api(owner.accessToken).delete(
      `/api/v1/workspaces/${wsId}/roles/${roleId}`,
    );
    expect(del.status).toBe(200);

    const afterList = await api(owner.accessToken).get(`/api/v1/workspaces/${wsId}/roles`);
    expect(
      afterList.body.data.some((r: { id: string }) => r.id === roleId),
    ).toBe(false);
  });

  it("blocks role management without roles:manage", async () => {
    const owner = await registerUser("roles-guard-owner@example.com");
    const member = await registerUser("roles-guard-member@example.com");
    const ws = await api(owner.accessToken)
      .post("/api/v1/workspaces")
      .send({ name: "Guarded Roles" });
    const wsId = ws.body.data.id;

    // Invite + accept to make the second user a plain member.
    const invited = await api(owner.accessToken)
      .post(`/api/v1/workspaces/${wsId}/invitations`)
      .send({ email: member.user.email });
    expect(invited.status).toBe(201);
    void invited;

    // Extract token via mailer? We overrode MAILER at module level; grab it.
    const mailerRef = app.get(MAILER) as unknown as FakeMailer;
    const token = mailerRef.sent.at(-1)!.text.match(/invitations\/([A-Za-z0-9_-]+)/)![1];
    const accepted = await api(member.accessToken)
      .post(`/api/v1/invitations/${token}/accept`)
      .send();
    expect(accepted.status).toBe(200);

    const deniedCreate = await api(member.accessToken)
      .post(`/api/v1/workspaces/${wsId}/roles`)
      .send({ key: "sneaky", name: "Sneaky", permissionKeys: ["emails:send"] });
    expect(deniedCreate.status).toBe(403);
    expect(deniedCreate.body.error.code).toBe("FORBIDDEN");

    // Members can still read roles.
    const readOk = await api(member.accessToken).get(`/api/v1/workspaces/${wsId}/roles`);
    expect(readOk.status).toBe(200);
  });
});
