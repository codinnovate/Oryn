import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "@/app.module";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";
import { closeTestDb, truncateTables } from "@tests/helpers/db";

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

async function registerUser(email: string) {
  const res = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email, password: "Sup3rSecret!x", name: "Test" });
  expect(res.status).toBe(201);
  return res.body.data as { user: { id: string }; accessToken: string };
}

function auth(token: string) {
  const server = () => app.getHttpServer();
  const bearer = "Bearer " + token;
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", bearer),
    post: (url: string) => request(server()).post(url).set("Authorization", bearer),
    patch: (url: string) => request(server()).patch(url).set("Authorization", bearer),
    delete: (url: string) => request(server()).delete(url).set("Authorization", bearer),
  };
}

describe("Users API (e2e)", () => {
  it("requires authentication for /users/me", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/users/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns and updates the profile", async () => {
    const { user, accessToken } = await registerUser("profile@example.com");

    const me = await auth(accessToken).get("/api/v1/users/me");
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe("profile@example.com");
    expect(me.body.data).not.toHaveProperty("passwordHash");

    const patched = await auth(accessToken)
      .patch("/api/v1/users/me")
      .send({ name: "Cody" });
    expect(patched.status).toBe(200);
    expect(patched.body.data.name).toBe("Cody");
    expect(patched.body.data.id).toBe(user.id);

    const bad = await auth(accessToken).patch("/api/v1/users/me").send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    const unknown = await auth(accessToken)
      .patch("/api/v1/users/me")
      .send({ nickname: "nope" });
    expect(unknown.status).toBe(400);
  });

  it("merges preferences and nests notifications", async () => {
    const { accessToken } = await registerUser("prefs@example.com");

    const p1 = await auth(accessToken)
      .patch("/api/v1/users/me/preferences")
      .send({ timezone: "UTC" });
    expect(p1.status).toBe(200);

    const n1 = await auth(accessToken)
      .patch("/api/v1/users/me/notifications")
      .send({ emailDigest: true });
    expect(n1.status).toBe(200);
    expect(n1.body.data.notifications).toEqual({ emailDigest: true });

    // Preferences patch must not wipe notification settings.
    const p2 = await auth(accessToken)
      .patch("/api/v1/users/me/preferences")
      .send({ theme: "dark" });
    expect(p2.status).toBe(200);

    const me = await auth(accessToken).get("/api/v1/users/me");
    expect(me.body.data.preferences).toEqual({
      timezone: "UTC",
      theme: "dark",
      notifications: { emailDigest: true },
    });

    const invalid = await auth(accessToken)
      .patch("/api/v1/users/me/notifications")
      .send({ smsAlerts: true });
    expect(invalid.status).toBe(400);
  });

  it("changes password only with the correct current password", async () => {
    const { accessToken } = await registerUser("passwd@example.com");

    const wrong = await auth(accessToken)
      .patch("/api/v1/users/me/password")
      .send({ currentPassword: "nope-nope-nope", newPassword: "NewSecret99!a" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("UNAUTHORIZED");

    const weak = await auth(accessToken)
      .patch("/api/v1/users/me/password")
      .send({ currentPassword: "Sup3rSecret!x", newPassword: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");

    const ok = await auth(accessToken)
      .patch("/api/v1/users/me/password")
      .send({ currentPassword: "Sup3rSecret!x", newPassword: "NewSecret99!a" });
    expect(ok.status).toBe(200);

    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "passwd@example.com", password: "NewSecret99!a" });
    expect(relogin.status).toBe(200);
  });

  it("lists sessions with a current flag and revokes individually", async () => {
    const first = await registerUser("sessions@example.com");
    // Second login creates a second session.
    const second = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: "sessions@example.com", password: "Sup3rSecret!x" });
    expect(second.status).toBe(200);

    const list = await auth(first.accessToken).get("/api/v1/auth/sessions");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    const current = list.body.data.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBeDefined();

    const other = list.body.data.find(
      (s: { current: boolean }) => !s.current,
    ) as { id: string };

    // Foreign/unknown id -> 404.
    const missing = await auth(first.accessToken).delete(
      "/api/v1/auth/sessions/00000000-0000-4000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RESOURCE_NOT_FOUND");

    const revoke = await auth(first.accessToken).delete(
      `/api/v1/auth/sessions/${other.id}`,
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.revoked).toBe(true);

    // The revoked token no longer authenticates.
    const dead = await auth(second.body.data.accessToken).get("/api/v1/users/me");
    expect(dead.status).toBe(401);

    const afterList = await auth(first.accessToken).get("/api/v1/auth/sessions");
    expect(afterList.body.data).toHaveLength(1);
    expect(afterList.body.data[0].current).toBe(true);
  });

  it("revoke-others keeps only the calling session", async () => {
    const first = await registerUser("others@example.com");
    const second = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: "others@example.com", password: "Sup3rSecret!x" });

    const res = await auth(first.accessToken).delete(
      "/api/v1/auth/sessions/current/others",
    );
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBeGreaterThanOrEqual(1);

    const dead = await auth(second.body.data.accessToken).get("/api/v1/users/me");
    expect(dead.status).toBe(401);
    const alive = await auth(first.accessToken).get("/api/v1/users/me");
    expect(alive.status).toBe(200);
  });

  it("deletes the account and invalidates all tokens", async () => {
    const { accessToken } = await registerUser("delete-me@example.com");

    const del = await auth(accessToken).delete("/api/v1/users/me");
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    const dead = await auth(accessToken).get("/api/v1/users/me");
    expect(dead.status).toBe(401);

    // Same credentials cannot log back in.
    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "delete-me@example.com", password: "Sup3rSecret!x" });
    expect(relogin.status).toBe(401);

    // And the email is free again.
    const re = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email: "delete-me@example.com", password: "Sup3rSecret!x", name: "Re" });
    expect(re.status).toBe(201);
  });
});
