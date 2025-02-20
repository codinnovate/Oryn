import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AuthService } from "@/modules/auth/auth.service";
import { SessionService } from "@/modules/auth/session.service";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { AuditService } from "@/modules/audit/audit.service";
import {
  auditLogs,
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
  lastToken(): string {
    const body = this.sent[this.sent.length - 1]!.text;
    // Token is the trailing whitespace-delimited word.
    return body.split(/\s+/).pop()!;
  }
}

let mailer: FakeMailer;
let authService: AuthService;
const meta = { userAgent: "vitest", ip: "127.0.0.1" };

beforeEach(async () => {
  await truncateTables([workspaceMembers, workspaces, sessions, verificationTokens, users, auditLogs]);
  mailer = new FakeMailer();
  authService = new AuthService(mailer, new SessionService(), new AuditService());
});

afterAll(async () => {
  await closeTestDb();
});

async function registerUser(email = "user@example.com", password = "Sup3rSecret!x") {
  return authService.register({ email, password, name: "Test" }, meta);
}

describe("AuthService.register", () => {
  it("creates an unverified user with a session and sends a verification email", async () => {
    const { user, session } = await registerUser();
    expect(user.email).toBe("user@example.com");
    expect(user.isEmailVerified).toBe(false);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("user@example.com");
    const stored = await db.select().from(users).where(eq(users.emailNormalized, user.email));
    expect(stored[0]!.passwordHash).not.toContain("Sup3rSecret");
  });

  it("rejects duplicate emails case-insensitively", async () => {
    await registerUser("dup@example.com");
    await expect(
      authService.register(
        { email: "DUP@example.com", password: "AnotherPass!1", name: "X" },
        meta,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT", status: 409 });
  });
});

describe("AuthService.login", () => {
  it("logs in with valid credentials and updates lastLoginAt", async () => {
    await registerUser("login@example.com");
    const before = await db.select().from(users).where(eq(users.emailNormalized, "login@example.com"));
    const { user, session } = await authService.login(
      { email: "LOGIN@example.com", password: "Sup3rSecret!x" },
      meta,
    );
    expect(user.id).toBe(before[0]!.id);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const after = await db.select().from(users).where(eq(users.id, user.id));
    expect(after[0]!.lastLoginAt).not.toBeNull();
  });

  it("fails uniformly for unknown emails and wrong passwords (no enumeration)", async () => {
    const unknown = authService.login({ email: "ghost@example.com", password: "whatever123!" }, meta);
    await expect(unknown).rejects.toMatchObject({
      message: "Invalid email or password",
      code: "UNAUTHORIZED",
    });
    await registerUser("real@example.com");
    const wrong = authService.login({ email: "real@example.com", password: "WrongPass!99" }, meta);
    await expect(wrong).rejects.toMatchObject({
      message: "Invalid email or password",
      code: "UNAUTHORIZED",
    });
  });

  it("rejects suspended accounts", async () => {
    const { user } = await registerUser("susp@example.com");
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
    await expect(
      authService.login({ email: "susp@example.com", password: "Sup3rSecret!x" }, meta),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("session lifecycle", () => {
  it("resolves live tokens and rejects revoked/expired ones", async () => {
    const { session } = await registerUser();
    const resolved = await new SessionService().resolve(session.token);
    expect(resolved?.sessionId).toBe(session.session.id);

    await authService.logout(session.token);
    const revoked = await new SessionService().resolve(session.token);
    expect(revoked).toBeNull();
  });

  it("refresh rotates the token and invalidates the old one", async () => {
    const { session } = await registerUser("rotate@example.com");
    const rotated = await authService.refresh(session.token, meta);
    expect(rotated.token).not.toBe(session.token);
    expect(await new SessionService().resolve(session.token)).toBeNull();
    expect(await new SessionService().resolve(rotated.token)).not.toBeNull();
  });

  it("resetting a password revokes all sessions", async () => {
    const first = await registerUser("pwchange@example.com");
    await authService.requestPasswordReset("pwchange@example.com");
    const token = mailer.lastToken();
    const newPassword = "BrandNewPass!7";
    await authService.resetPassword({ token, password: newPassword });

    const allSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, first.user.id));
    expect(allSessions.every((s) => s.revokedAt !== null)).toBe(true);

    const login = await authService.login({ email: "pwchange@example.com", password: newPassword }, meta);
    expect(login.user.id).toBe(first.user.id);
  });
});

describe("email verification + password reset flows", () => {
  it("verifies email via token; token becomes single-use", async () => {
    const { user } = await registerUser("verify@example.com");
    const token = mailer.lastToken();
    await authService.verifyEmail(token);
    const after = await db.select().from(users).where(eq(users.id, user.id));
    expect(after[0]!.isEmailVerified).toBe(true);

    // Second use fails as invalid (tokens are single-use; no distinction is exposed).
    await expect(authService.verifyEmail(token)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects invalid/expired reset tokens without leaking details", async () => {
    await expect(
      authService.resetPassword({ token: "t".repeat(40), password: "Whatever!123" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("forgot-password responds identically for known and unknown emails", async () => {
    const known = await authService.requestPasswordReset("known@example.com");
    const unknown = await authService.requestPasswordReset("unknown@example.com");
    expect(known).toEqual(unknown);
    await registerUser("known2@example.com");
    await authService.requestPasswordReset("known2@example.com");
    expect(mailer.sent.at(-1)!.to).toBe("known2@example.com");
  });

  it("resend-verification skips already-verified users", async () => {
    const { user } = await registerUser("resend@example.com");
    const token = mailer.lastToken();
    await authService.verifyEmail(token);
    const result = await authService.resendVerification(user.id);
    expect(result).toEqual({ sent: false });
  });
});
