import { Test, type TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";
import { AppModule } from "@/app.module";
import { PinoLoggerService } from "@/lib/logger";
import {
  sessions,
  users,
  verificationTokens,
  workspaceMembers,
  workspaces,
} from "@/lib/db/schema";
import { closeTestDb, getTestDb, truncateTables } from "@tests/helpers/db";

const db = getTestDb();

class FakeMailer implements Mailer {
  public sent: MailInput[] = [];
  async send(input: MailInput): Promise<void> {
    this.sent.push(input);
  }
}

let app: INestApplication;
let mailer: FakeMailer;

beforeAll(async () => {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAILER)
    .useClass(FakeMailer)
    .compile();

  app = moduleRef.createNestApplication({ logger: new PinoLoggerService() });
  app.setGlobalPrefix("api/v1");
  await app.init();
  mailer = app.get<FakeMailer>(MAILER);
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

const VALID_PASSWORD = "Sup3rSecret!x";

async function registerAndLogin(email: string) {
  const res = await request(app.getHttpServer())
    .post("/api/v1/auth/register")
    .send({ email, password: VALID_PASSWORD, name: "E2E" });
  expect(res.status).toBe(201);
  return res.body.data as { user: { id: string }; accessToken: string };
}

describe("Auth API (e2e)", () => {
  beforeEach(async () => {
    await truncateTables([workspaceMembers, workspaces, sessions, verificationTokens, users]);
  });

  it("registers, logs in, reads /auth/me and /users-style protected routes require auth", async () => {
    const { accessToken, user } = await registerAndLogin("e2e@example.com");
    expect(accessToken).toBeTruthy();

    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ email: "e2e@example.com", id: user.id });

    const anon = await request(app.getHttpServer()).get("/api/v1/auth/me");
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("UNAUTHORIZED");
  });

  it("sets an HttpOnly session cookie on login and clears it on logout", async () => {
    await registerAndLogin("cookie@example.com");
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "cookie@example.com", password: VALID_PASSWORD });
    const setCookie = login.headers["set-cookie"] as unknown as string[];
    const cookie = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as unknown as string);
    expect(cookie).toContain("oryn_session=");
    expect(cookie).toContain("HttpOnly");

    // Cookie alone authenticates /auth/me.
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookie.split(";")[0]!);
    expect(me.status).toBe(200);

    // Logout via bearer.
    const logout = await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .set("Origin", "http://localhost:3000");
    expect(logout.status).toBe(200);

    // Old token no longer works.
    const after = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`);
    expect(after.status).toBe(401);
  });

  it("rejects malformed payloads with VALIDATION_ERROR and field paths", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = (res.body.error.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toContain("email");
    expect(paths).toContain("password");
  });

  it("enforces the password policy", async () => {
    const weak = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email: "weak@example.com", password: "aaaaaaaaaa" });
    expect(weak.status).toBe(400);
  });

  it("refresh rotates access tokens; old token dies", async () => {
    const { accessToken } = await registerAndLogin("refresh@example.com");
    const refreshed = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(refreshed.status).toBe(200);
    const newToken = refreshed.body.data.accessToken;
    expect(newToken).not.toBe(accessToken);

    const oldMe = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(oldMe.status).toBe(401);
  });

  it("verify-email flow works end to end through the fake mailer", async () => {
    await registerAndLogin("verifyflow@example.com");
    expect(mailer.sent.length).toBeGreaterThan(0);
    const body = mailer.sent.at(-1)!.text;
    const token = body.split(/\s+/).pop()!;

    const verified = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token });
    expect(verified.status).toBe(200);

    const reused = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("forgot-password never leaks account existence", async () => {
    const ghost = await request(app.getHttpServer())
      .post("/api/v1/auth/forgot-password")
      .send({ email: "ghost@example.com" });
    await registerAndLogin("real-fp@example.com");
    const known = await request(app.getHttpServer())
      .post("/api/v1/auth/forgot-password")
      .send({ email: "real-fp@example.com" });
    expect(known.status).toBe(200);
    expect(ghost.status).toBe(200);
    expect(ghost.body).toEqual(known.body); // identical response either way
  });

  it("reset-password invalidates old password and all sessions", async () => {
    const { accessToken } = await registerAndLogin("reset@example.com");
    await request(app.getHttpServer())
      .post("/api/v1/auth/forgot-password")
      .send({ email: "reset@example.com" });
    const token = mailer.sent
      .filter((m) => m.subject.includes("Reset"))
      .at(-1)!
      .text.split(/\s+/)
      .pop()!;

    const reset = await request(app.getHttpServer())
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "NewPassword!42" });
    expect(reset.status).toBe(200);

    const oldSession = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(oldSession.status).toBe(401);

    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "reset@example.com", password: "NewPassword!42" });
    expect(relogin.status).toBe(200);
  });

  it("cookie-authenticated mutations from a foreign origin are rejected (CSRF)", async () => {
    await registerAndLogin("csrf@example.com");
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "csrf@example.com", password: VALID_PASSWORD });
    const cookie = (login.headers["set-cookie"] as string[])[0]!.split(";")[0]!;

    const evil = await request(app.getHttpServer())
      .post("/api/v1/auth/resend-verification")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example.com");
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("FORBIDDEN");

    const sameOrigin = await request(app.getHttpServer())
      .post("/api/v1/auth/resend-verification")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3000");
    expect(sameOrigin.status).toBe(200);
  });
});
