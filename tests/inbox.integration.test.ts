import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, closeDatabase } from "@/lib/db/database";
import { encryptSecret } from "@/lib/crypto/secrets";
import {
  emailAccounts,
  emailMessages,
  users,
  workspaces,
  workspaceMembers,
} from "@/lib/db/schema";
import { InboxService } from "@/modules/inbox/inbox.service";

const db = getDb();

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WS_ID = "10000000-0000-4000-8000-000000000002";
const ACC_ID = "10000000-0000-4000-8000-000000000003";

const MSG_ID_A = "20000000-0000-4000-8000-000000000001";
const MSG_ID_B = "20000000-0000-4000-8000-000000000002";
const MSG_ID_C = "20000000-0000-4000-8000-000000000003";

const MSG_A = {
  id: MSG_ID_A,
  workspaceId: WS_ID,
  emailAccountId: ACC_ID,
  providerMessageId: "gmail-aaa",
  subject: "Project kickoff",
  fromAddress: "alice@example.com",
  toAddresses: ["me@example.com"],
  snippet: "Let us begin the project",
  direction: "inbound",
  isRead: false,
  hasAttachments: false,
  sizeBytes: 2048,
  labels: ["INBOX"],
  receivedAt: new Date("2025-07-01T10:00:00Z"),
};

const MSG_B = {
  id: MSG_ID_B,
  workspaceId: WS_ID,
  emailAccountId: ACC_ID,
  providerMessageId: "gmail-bbb",
  subject: "Re: Kickoff follow-up",
  fromAddress: "me@example.com",
  toAddresses: ["alice@example.com"],
  snippet: "Sounds good to me",
  direction: "outbound",
  isRead: true,
  hasAttachments: true,
  sizeBytes: 8192,
  labels: ["SENT"],
  receivedAt: new Date("2025-07-02T14:00:00Z"),
};

const MSG_C = {
  id: MSG_ID_C,
  workspaceId: WS_ID,
  emailAccountId: ACC_ID,
  providerMessageId: "gmail-ccc",
  subject: "Invoice #42",
  fromAddress: "billing@example.com",
  toAddresses: ["me@example.com"],
  snippet: "Please find attached the invoice",
  direction: "inbound",
  isRead: false,
  hasAttachments: true,
  sizeBytes: 10240,
  labels: ["INBOX"],
  receivedAt: new Date("2025-07-03T09:00:00Z"),
};

beforeAll(async () => {
  await db.insert(users).values({
    id: USER_ID,
    email: "inbox-test@example.com",
    emailNormalized: "inbox-test@example.com",
    name: "Inbox Tester",
    passwordHash: "fake",
    isEmailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(workspaces).values({
    id: WS_ID,
    name: "Inbox WS",
    slug: "inbox-ws",
    ownerId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(workspaceMembers).values({
    userId: USER_ID,
    workspaceId: WS_ID,
    roleId: "member",
  }).onConflictDoNothing();
  await db.insert(emailAccounts).values({
    id: ACC_ID,
    workspaceId: WS_ID,
    connectedByUserId: USER_ID,
    provider: "gmail",
    providerAccountId: "inbox-acc-1",
    emailAddress: "me@example.com",
    accessTokenCiphertext: encryptSecret("tok", "access-token"),
    refreshTokenCiphertext: encryptSecret("tok", "refresh-token"),
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(emailMessages).values([MSG_A, MSG_B, MSG_C]).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(emailMessages).where(eq(emailMessages.workspaceId, WS_ID));
  await db.delete(emailAccounts).where(eq(emailAccounts.id, ACC_ID));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, USER_ID));
  await db.delete(workspaces).where(eq(workspaces.id, WS_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await closeDatabase();
});

function svc() {
  // Stub RBAC — integration tests exercise query logic, not authorization.
  return new InboxService({
    requirePermission: async () => {},
  } as never);
}

describe("InboxService (integration)", () => {
  it("lists all messages sorted newest-first by default", async () => {
    const { items, total } = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 50,
      sort: "-receivedAt",
    });
    expect(total).toBe(3);
    expect(items).toHaveLength(3);
    // Newest first: C (Jul 3) > B (Jul 2) > A (Jul 1)
    expect(items[0]!.providerMessageId).toBe("gmail-ccc");
    expect(items[2]!.providerMessageId).toBe("gmail-aaa");
  });

  it("sorts oldest-first when sort=receivedAt", async () => {
    const { items } = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 50,
      sort: "receivedAt",
    });
    expect(items[0]!.providerMessageId).toBe("gmail-aaa");
  });

  it("filters by isRead", async () => {
    const { items, total } = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 50,
      sort: "-receivedAt",
      isRead: true,
    });
    expect(total).toBe(1);
    expect(items[0]!.providerMessageId).toBe("gmail-bbb");
  });

  it("filters by direction", async () => {
    const { items, total } = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 50,
      sort: "-receivedAt",
      direction: "outbound",
    });
    expect(total).toBe(1);
    expect(items[0]!.providerMessageId).toBe("gmail-bbb");
  });

  it("filters by q (subject search)", async () => {
    const { items, total } = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 50,
      sort: "-receivedAt",
      q: "invoice",
    });
    expect(total).toBe(1);
    expect(items[0]!.subject).toBe("Invoice #42");
  });

  it("filters by date range (receivedAfter/receivedBefore)", async () => {
    const { items, total } = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 50,
      sort: "-receivedAt",
      receivedAfter: new Date("2025-07-02T00:00:00Z"),
      receivedBefore: new Date("2025-07-03T00:00:00Z"),
    });
    expect(total).toBe(1);
    expect(items[0]!.providerMessageId).toBe("gmail-bbb");
  });

  it("paginates correctly", async () => {
    const page1 = await svc().listMessages(USER_ID, WS_ID, {
      page: 1,
      limit: 2,
      sort: "-receivedAt",
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await svc().listMessages(USER_ID, WS_ID, {
      page: 2,
      limit: 2,
      sort: "-receivedAt",
    });
    expect(page2.items).toHaveLength(1);
  });

  it("getMessage returns a single message", async () => {
    const msg = await svc().getMessage(USER_ID, WS_ID, MSG_ID_A);
    expect(msg.id).toBe(MSG_ID_A);
    expect(msg.subject).toBe("Project kickoff");
    expect(msg.fromAddress).toBe("alice@example.com");
  });

  it("getMessage throws 404 for unknown id", async () => {
    await expect(
      svc().getMessage(USER_ID, WS_ID, "00000000-0000-4000-8000-999999999999"),
    ).rejects.toThrow("Message not found");
  });

  it("updateMessage patches isRead and labels", async () => {
    const updated = await svc().updateMessage(USER_ID, WS_ID, MSG_ID_A, {
      isRead: true,
      labels: ["INBOX", "ARCHIVED"],
    });
    expect(updated.isRead).toBe(true);
    expect(updated.labels).toEqual(["INBOX", "ARCHIVED"]);

    // Verify persisted
    const msg = await svc().getMessage(USER_ID, WS_ID, MSG_ID_A);
    expect(msg.isRead).toBe(true);

    // Reset for other tests
    await svc().updateMessage(USER_ID, WS_ID, MSG_ID_A, {
      isRead: false,
      labels: ["INBOX"],
    });
  });

  it("updateMessage throws 404 for unknown id", async () => {
    await expect(
      svc().updateMessage(USER_ID, WS_ID, "00000000-0000-4000-8000-999999999999", {
        isRead: true,
      }),
    ).rejects.toThrow("Message not found");
  });
});
