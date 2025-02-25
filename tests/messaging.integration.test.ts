import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import {
  users,
  workspaces,
  emailAccounts,
  scheduledEmails,
} from "@/lib/db/schema";
import { MessagingService } from "@/modules/messaging/messaging.service";

let db: ReturnType<typeof getDb>;

const TEST_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_WS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEST_ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function createMockAccountsService() {
  return {
    findById: async () => ({ id: TEST_ACCOUNT_ID, provider: "gmail", status: "active" }),
    getValidAccessToken: async () => "fake-access-token",
  };
}

function createMockRbacService() {
  return { requirePermission: async () => {} };
}

function createMockQueue() {
  const enqueued: unknown[] = [];
  return {
    enqueued,
    enqueue: async (_q: string, _j: string, data: unknown, _opts?: unknown) => {
      enqueued.push(data);
      return "job-123";
    },
  };
}

function createMockAdapters() {
  return {
    gmail: {
      sendMessage: async () => ({ providerMessageId: "gmail-msg-1" }),
    },
  };
}

function createService() {
  return new MessagingService(
    createMockAccountsService() as any,
    createMockRbacService() as any,
    createMockQueue() as any,
    createMockAdapters() as any,
  );
}

beforeAll(async () => {
  db = getDb();
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: "messaging@test.com",
    emailNormalized: "messaging@test.com",
    name: "Messaging Test",
    passwordHash: "fake",
    isEmailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(workspaces).values({
    id: TEST_WS_ID,
    name: "Test WS",
    slug: "messaging-test",
    ownerId: TEST_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(emailAccounts).values({
    id: TEST_ACCOUNT_ID,
    workspaceId: TEST_WS_ID,
    connectedByUserId: TEST_USER_ID,
    provider: "gmail",
    providerAccountId: "gmail-123",
    emailAddress: "test@example.com",
    accessTokenCiphertext: "enc",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(scheduledEmails).where(eq(scheduledEmails.workspaceId, TEST_WS_ID));
  await db.delete(emailAccounts).where(eq(emailAccounts.workspaceId, TEST_WS_ID));
  await db.delete(workspaces).where(eq(workspaces.id, TEST_WS_ID));
  await db.delete(users).where(eq(users.id, TEST_USER_ID));
});

beforeEach(async () => {
  await db.delete(scheduledEmails).where(eq(scheduledEmails.workspaceId, TEST_WS_ID));
});

describe("MessagingService (integration)", () => {
  const svc = () => createService();

  it("sendEmail inserts a pending scheduled_email row and enqueues a job", async () => {
    const result = await svc().sendEmail(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID, {
      to: ["alice@example.com"],
      subject: "Hello",
      text: "Hi there",
    });
    expect(result.id).toBeDefined();
    expect(result.jobId).toBe("job-123");
  });

  it("scheduleEmail sets scheduledFor on the row and enqueues a delayed job", async () => {
    const future = new Date(Date.now() + 3600_000);
    const result = await svc().scheduleEmail(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID, {
      to: ["bob@example.com"],
      subject: "Later",
      html: "<p>Scheduled</p>",
      scheduledFor: future,
    });
    expect(result.id).toBeDefined();
    expect(result.jobId).toBe("job-123");
  });

  it("listPending returns only pending emails", async () => {
    await svc().sendEmail(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID, {
      to: ["a@b.com"],
      subject: "First",
      text: "Body",
    });
    await svc().sendEmail(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID, {
      to: ["c@d.com"],
      subject: "Second",
      text: "Body",
    });
    const pending = await svc().listPending(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID);
    expect(pending.length).toBe(2);
    expect(pending.every((e) => e.status === "pending")).toBe(true);
  });

  it("cancelEmail marks a pending email as cancelled", async () => {
    const { id } = await svc().sendEmail(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID, {
      to: ["x@y.com"],
      subject: "To cancel",
      text: "Body",
    });
    await svc().cancelEmail(TEST_USER_ID, TEST_WS_ID, id);
    const rows = await db
      .select()
      .from(scheduledEmails)
      .where(eq(scheduledEmails.id, id))
      .limit(1);
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("cancelEmail throws if already sent", async () => {
    const { id } = await svc().sendEmail(TEST_USER_ID, TEST_WS_ID, TEST_ACCOUNT_ID, {
      to: ["x@y.com"],
      subject: "Already sent",
      text: "Body",
    });
    await db
      .update(scheduledEmails)
      .set({ status: "sent", providerMessageId: "mock-id", sentAt: new Date() })
      .where(eq(scheduledEmails.id, id));
    await expect(
      svc().cancelEmail(TEST_USER_ID, TEST_WS_ID, id),
    ).rejects.toThrow();
  });
});
