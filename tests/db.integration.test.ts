import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  permissions,
  roles,
  sessions,
  users,
  verificationTokens,
  workspaceMembers,
  workspaces,
} from "@/lib/db/schema";
import {
  closeTestDb,
  expectPgCode,
  getTestDb,
  truncateTables,
} from "@tests/helpers/db";

const db = getTestDb();

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await truncateTables([
    workspaceMembers,
    workspaces,
    sessions,
    verificationTokens,
    users,
    roles,
    permissions,
  ]);
});

describe("users table", () => {
  it("inserts and finds a user", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: "Alice@Example.com",
        emailNormalized: "alice@example.com",
        name: "Alice",
        passwordHash: "$bcrypt-hash",
      })
      .returning();
    expect(user).toBeDefined();
    expect(user!.emailNormalized).toBe("alice@example.com");

    const found = await db
      .select()
      .from(users)
      .where(eq(users.emailNormalized, "alice@example.com"));
    expect(found).toHaveLength(1);
  });

  it("enforces case-insensitive unique emails", async () => {
    await db.insert(users).values({
      email: "dup@example.com",
      emailNormalized: "dup@example.com",
    });
    await expectPgCode(
      () =>
        db.insert(users).values({
          email: "DUP@example.com",
          emailNormalized: "dup@example.com",
        }),
      "23505",
    );
  });

  it("rejects invalid enum status values at the DB level", async () => {
    await expectPgCode(
      () =>
        db.execute(
          sql`INSERT INTO users (email, email_normalized, status) VALUES (${"badstatus@example.com"}, ${"badstatus@example.com"}, ${"not-a-status"})`,
        ),
      "22P02",
    );
  });

  it("cascades session deletion on user hard delete", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "cascade@example.com", emailNormalized: "cascade@example.com" })
      .returning();
    await db.insert(sessions).values({
      userId: user!.id,
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.delete(users).where(eq(users.id, user!.id));
    const remaining = await db.select().from(sessions);
    expect(remaining).toHaveLength(0);
  });

  it("stores preferences as jsonb with defaults", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "prefs@example.com", emailNormalized: "prefs@example.com" })
      .returning();
    expect(user!.preferences).toEqual({});
  });
});

describe("verification tokens", () => {
  it("rejects duplicate token hashes and invalid types", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "vt@example.com", emailNormalized: "vt@example.com" })
      .returning();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(verificationTokens).values({
      userId: user!.id,
      type: "verify_email",
      tokenHash: "b".repeat(64),
      expiresAt,
    });
    await expectPgCode(
      () =>
        db.insert(verificationTokens).values({
          userId: user!.id,
          type: "verify_email",
          tokenHash: "b".repeat(64),
          expiresAt,
        }),
      "23505",
    );
    await expectPgCode(
      () =>
        db.execute(
          sql`INSERT INTO verification_tokens (user_id, type, token_hash, expires_at) VALUES (${user!.id}, ${"bogus_type"}, ${"c".repeat(64)}, ${expiresAt.toISOString()})`,
        ),
      "22P02",
    );
  });
});

describe("workspaces + members + rbac", () => {
  it("creates workspace with unique slug; roles/permissions/members constraints hold", async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: "owner@example.com", emailNormalized: "owner@example.com" })
      .returning();

    const [ws] = await db
      .insert(workspaces)
      .values({ name: "Acme", slug: "acme", ownerId: owner!.id })
      .returning();

    await expectPgCode(
      () =>
        db
          .insert(workspaces)
          .values({ name: "Other", slug: "acme", ownerId: owner!.id }),
      "23505",
    );

    const permRows = await db
      .insert(permissions)
      .values([
        { key: "emails:read", description: "Read emails" },
        { key: "emails:send", description: "Send emails" },
      ])
      .onConflictDoNothing()
      .returning();
    expect(permRows.length).toBeGreaterThan(0);

    const [role] = await db
      .insert(roles)
      .values({ workspaceId: ws!.id, key: "owner", name: "Owner", isSystem: true })
      .returning();
    expect(role!.workspaceId).toBe(ws!.id);

    const [member] = await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: owner!.id, status: "active" })
      .returning();
    expect(member!.joinedAt).toBeNull();

    // One membership per (workspace,user).
    await expectPgCode(
      () =>
        db
          .insert(workspaceMembers)
          .values({ workspaceId: ws!.id, userId: owner!.id }),
      "23505",
    );
  });

  it("deleting a workspace cascades members and roles", async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: "del@example.com", emailNormalized: "del@example.com" })
      .returning();
    const [ws] = await db
      .insert(workspaces)
      .values({ name: "Gone", slug: "gone", ownerId: owner!.id })
      .returning();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: owner!.id });
    await db.insert(roles).values({ workspaceId: ws!.id, key: "member", name: "Member" });

    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    expect(await db.select().from(workspaceMembers)).toHaveLength(0);
    expect(await db.select().from(roles)).toHaveLength(0);
  });
});
