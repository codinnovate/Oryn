import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AuthService } from "@/modules/auth/auth.service";
import { SessionService } from "@/modules/auth/session.service";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { UsersService } from "@/modules/users/users.service";
import {
  sessions,
  users,
  verificationTokens,
} from "@/lib/db/schema";
import { closeTestDb, getTestDb, truncateTables } from "@tests/helpers/db";

const db = getTestDb();

class FakeMailer implements Mailer {
  public sent: MailInput[] = [];
  async send(input: MailInput): Promise<void> {
    this.sent.push(input);
  }
  lastToken(): string {
    return this.sent[this.sent.length - 1]!.text.split(/\s+/).pop()!;
  }
}

let mailer: FakeMailer;
let authService: AuthService;
let sessionService: SessionService;
let usersService: UsersService;
const meta = { userAgent: "vitest", ip: "127.0.0.1" };

beforeEach(async () => {
  await truncateTables([sessions, verificationTokens, users]);
  mailer = new FakeMailer();
  sessionService = new SessionService();
  authService = new AuthService(mailer, sessionService);
  usersService = new UsersService(sessionService);
});

afterAll(async () => {
  await closeTestDb();
});

async function registerAndLogin(email = "user@example.com") {
  const { user, session } = await authService.register(
    { email, password: "Sup3rSecret!x", name: "Test" },
    meta,
  );
  return { user, token: session.token, sessionId: session.session.id };
}

describe("UsersService profile", () => {
  it("returns and updates the profile", async () => {
    const { user } = await registerAndLogin();
    const profile = await usersService.getProfile(user.id);
    expect(profile.email).toBe("user@example.com");

    const updated = await usersService.updateProfile(user.id, {
      name: "Cody",
      avatarUrl: null,
    });
    expect(updated.name).toBe("Cody");
    expect(updated.avatarUrl).toBeNull();
  });

  it("merges preferences without clobbering sibling keys", async () => {
    const { user } = await registerAndLogin();
    await usersService.updatePreferences(user.id, { timezone: "Europe/Berlin" });
    await usersService.updatePreferences(user.id, { locale: "de-DE" });
    const merged = await usersService.updatePreferences(user.id, { theme: "dark" });
    expect(merged.preferences).toEqual({
      timezone: "Europe/Berlin",
      locale: "de-DE",
      theme: "dark",
    });
  });

  it("nests notification settings under preferences.notifications", async () => {
    const { user } = await registerAndLogin();
    await usersService.updateNotifications(user.id, { emailDigest: true });
    await usersService.updateNotifications(user.id, { weeklyReport: false });
    const after = await usersService.updateNotifications(user.id, {
      importantEmails: true,
    });
    expect(after.preferences).toMatchObject({
      notifications: {
        emailDigest: true,
        weeklyReport: false,
        importantEmails: true,
      },
    });
  });
});

describe("UsersService.changePassword", () => {
  it("rejects a wrong current password uniformly", async () => {
    const { user, sessionId } = await registerAndLogin();
    await expect(
      usersService.changePassword(user.id, sessionId, "wrong-password", "NewSecret99!a"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("changes the password and revokes other sessions but keeps the caller's", async () => {
    const { user, sessionId } = await registerAndLogin();
    // A second device.
    const second = await sessionService.create(user.id, meta);

    await usersService.changePassword(user.id, sessionId, "Sup3rSecret!x", "NewSecret99!a");

    const revoked = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, second.session.id));
    expect(revoked[0]!.revokedAt).not.toBeNull();

    const kept = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(kept[0]!.revokedAt).toBeNull();

    // Old password no longer works; new one does.
    await expect(
      authService.login({ email: user.email, password: "Sup3rSecret!x" }, meta),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authService.login({ email: user.email, password: "NewSecret99!a" }, meta),
    ).resolves.toBeDefined();
  });
});

describe("UsersService.deleteAccount", () => {
  it("soft-deletes the user, frees the email slot, revokes sessions", async () => {
    const { user, token } = await registerAndLogin();
    await usersService.deleteAccount(user.id);

    const row = (await db.select().from(users).where(eq(users.id, user.id)))[0]!;
    expect(row.status).toBe("deleted");
    expect(row.deletedAt).not.toBeNull();

    const live = await sessionService.resolve(token);
    expect(live).toBeNull();

    // The original email can be registered again.
    const re = await authService.register(
      { email: user.email, password: "Sup3rSecret!x", name: "Again" },
      meta,
    );
    expect(re.user.id).not.toBe(user.id);
  });
});

describe("Session management", () => {
  it("lists active sessions most recently used first with current detection left to caller", async () => {
    const { user, sessionId } = await registerAndLogin();
    const second = await sessionService.create(user.id, meta);
    const list = await sessionService.listActive(user.id);
    expect(list.map((s) => s.id)).toContain(sessionId);
    expect(list.map((s) => s.id)).toContain(second.session.id);
  });

  it("refuses to revoke sessions belonging to another user", async () => {
    const mine = await registerAndLogin("mine@example.com");
    const theirs = await registerAndLogin("theirs@example.com");
    const ok = await sessionService.revokeOwned(theirs.sessionId, mine.user.id);
    expect(ok).toBe(false);
    const stillLive = await sessionService.resolve(theirs.token);
    expect(stillLive).not.toBeNull();
  });

  it("revokeAllExceptForUser keeps exactly one session alive", async () => {
    const { user, sessionId, token } = await registerAndLogin();
    await sessionService.create(user.id, meta);
    await sessionService.create(user.id, meta);
    const revokedCount = await sessionService.revokeAllExceptForUser(user.id, sessionId);
    expect(revokedCount).toBe(2);
    const remaining = await sessionService.listActive(user.id);
    expect(remaining.map((s) => s.id)).toEqual([sessionId]);
    expect((await sessionService.resolve(token))!.sessionId).toBe(sessionId);
  });
});
