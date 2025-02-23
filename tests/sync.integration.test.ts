import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, closeDatabase } from "@/lib/db/database";
import { encryptSecret } from "@/lib/crypto/secrets";
import {
  emailAccounts,
  emailMessages,
  users,
  workspaces,
  workspaceMembers,
} from "@/lib/db/schema";
import { NonRetryableSyncError } from "@/modules/sync/sync.service";
import { EMAIL_PROVIDER_ADAPTERS } from "@/providers/provider.factory";
import type { EmailProviderAdapter, ListMessagesResult } from "@/providers/types";

const db = getDb();

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const TEST_ACCOUNT_ID = "00000000-0000-0000-0000-000000000003";
const TEST_PROVIDER_ID = "acc-google-1";

const PAGE_1: ListMessagesResult = {
  messages: [
    {
      providerMessageId: "g-1",
      threadId: "t-1",
      subject: "Welcome",
      fromAddress: "onboarding@example.com",
      toAddresses: ["me@example.com"],
      snippet: "Welcome to Oryn",
      receivedAt: new Date("2025-06-01T10:00:00Z"),
      isRead: true,
      hasAttachments: false,
      sizeBytes: 1024,
      labels: ["INBOX"],
    },
  ],
  nextPageToken: null,
};

function fakeGmailAdapter(): EmailProviderAdapter {
  let callCount = 0;
  return {
    id: "gmail",
    displayName: "Fake Gmail",
    isConfigured: () => true,
    buildAuthorizationUrl: () => "",
    exchangeCode: async () => ({ accessToken: "", expiresInSec: 3600 }),
    refresh: async () => ({ accessToken: "", expiresInSec: 3600 }),
    getProfile: async () => ({ providerAccountId: TEST_PROVIDER_ID, emailAddress: "me@example.com" }),
    listMessages: async (_token, _options) => {
      callCount += 1;
      // Always return g-1 (first run: upsert created; second: upsert updated)
      return {
        messages: [
          {
            providerMessageId: "g-1",
            threadId: "t-1",
            subject: "Welcome",
            fromAddress: "onboarding@example.com",
            toAddresses: ["me@example.com"],
            snippet: "Welcome to Oryn",
            receivedAt: new Date("2025-06-01T10:00:00Z"),
            isRead: true,
            hasAttachments: false,
            sizeBytes: 1024,
            labels: ["INBOX"],
          },
        ],
        nextPageToken: null,
      };
    },
  };
}

async function seedTestData() {
  // Insert user first (workspace owner_id FK requires it)
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: "sync-test@example.com",
    emailNormalized: "sync-test@example.com",
    name: "Sync Test User",
    passwordHash: "fake-hash",
    isEmailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(workspaces).values({
    id: TEST_WORKSPACE_ID,
    name: "Test WS",
    slug: "test-ws",
    ownerId: TEST_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(workspaceMembers).values({
    userId: TEST_USER_ID,
    workspaceId: TEST_WORKSPACE_ID,
    roleId: "member",
  }).onConflictDoNothing();
  await db.insert(emailAccounts).values({
    id: TEST_ACCOUNT_ID,
    workspaceId: TEST_WORKSPACE_ID,
    connectedByUserId: TEST_USER_ID,
    provider: "gmail",
    providerAccountId: TEST_PROVIDER_ID,
    emailAddress: "me@example.com",
    displayName: "Me",
    accessTokenCiphertext: encryptSecret("fake-access-token", "access-token"),
    refreshTokenCiphertext: encryptSecret("fake-refresh-token", "refresh-token"),
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
}

beforeAll(async () => {
  await seedTestData();
});

afterAll(async () => {
  await db
    .delete(emailMessages)
    .where(eq(emailMessages.workspaceId, TEST_WORKSPACE_ID));
  await db.delete(emailAccounts).where(eq(emailAccounts.id, TEST_ACCOUNT_ID));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, TEST_USER_ID));
  await db.delete(workspaces).where(eq(workspaces.id, TEST_WORKSPACE_ID));
  await closeDatabase();
});

describe("SyncService.runAccountSync (integration)", () => {
  it("upserts messages and updates lastSyncedAt", async () => {
    // Import service with real DB + fake adapter
    const adapter = fakeGmailAdapter();
    const SyncService = (await import("@/modules/sync/sync.service")).SyncService;
    const EmailAccountsService = (await import("@/modules/email-accounts/email-accounts.service")).EmailAccountsService;
    const RbacService = (await import("@/modules/rbac/rbac.service")).RbacService;
    const AuditService = (await import("@/modules/audit/audit.service")).AuditService;

    const adapters = { gmail: adapter, outlook: null as unknown as EmailProviderAdapter };
    // Construct services with real deps — rbac/audit/adapters all work offline.
    const accountsService = new EmailAccountsService(
      adapters as any,
      new RbacService(),
      new AuditService(),
    );
    const queueService = { enqueue: async () => "job-1" } as any;
    const svc = new SyncService(accountsService, new RbacService(), queueService, adapters as any);

    // First sync: g-1
    const result = await svc.runAccountSync(TEST_ACCOUNT_ID);
    expect(result.pagesFetched).toBe(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);

    // Verify row stored with correct data
    const rows = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.emailAccountId, TEST_ACCOUNT_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerMessageId).toBe("g-1");
    expect(rows[0]!.subject).toBe("Welcome");
    expect(rows[0]!.direction).toBe("inbound"); // from != account email
    expect(rows[0]!.toAddresses).toEqual(["me@example.com"]);

    // Verify lastSyncedAt was set
    const account = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.id, TEST_ACCOUNT_ID));
    expect(account[0]!.lastSyncedAt).not.toBeNull();
  });

  it("upserts without duplicating on second sync", async () => {
    const adapter = fakeGmailAdapter();
    const SyncService = (await import("@/modules/sync/sync.service")).SyncService;
    const EmailAccountsService = (await import("@/modules/email-accounts/email-accounts.service")).EmailAccountsService;
    const RbacService = (await import("@/modules/rbac/rbac.service")).RbacService;
    const AuditService = (await import("@/modules/audit/audit.service")).AuditService;

    const adapters = { gmail: adapter, outlook: null as unknown as EmailProviderAdapter };
    const accountsService = new EmailAccountsService(
      adapters as any,
      new RbacService(),
      new AuditService(),
    );
    const queueService = { enqueue: async () => "job-2" } as any;
    const svc = new SyncService(accountsService, new RbacService(), queueService, adapters as any);

    // Same account, same messages
    const result = await svc.runAccountSync(TEST_ACCOUNT_ID);
    expect(result.pagesFetched).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.emailAccountId, TEST_ACCOUNT_ID));
    expect(rows).toHaveLength(1);
  });

  it("resolves outbound direction when from matches account email", async () => {
    // Sync with the page2 message (from=me@example.com = outbound)
    const adapter: EmailProviderAdapter = {
      id: "gmail",
      displayName: "Fake",
      isConfigured: () => true,
      buildAuthorizationUrl: () => "",
      exchangeCode: async () => ({ accessToken: "" }),
      refresh: async () => ({ accessToken: "" }),
      getProfile: async () => ({ providerAccountId: "", emailAddress: "" }),
      listMessages: async () => ({
        messages: [
          {
            providerMessageId: "g-outbound-1",
            subject: "Sent mail",
            fromAddress: "me@example.com",
            toAddresses: ["friend@example.com"],
            snippet: "Hi friend",
            receivedAt: new Date("2025-06-03T10:00:00Z"),
            isRead: true,
            hasAttachments: false,
            sizeBytes: 512,
            labels: [],
          },
        ],
        nextPageToken: null,
      }),
    };

    const SyncService = (await import("@/modules/sync/sync.service")).SyncService;
    const EmailAccountsService = (await import("@/modules/email-accounts/email-accounts.service")).EmailAccountsService;
    const RbacService = (await import("@/modules/rbac/rbac.service")).RbacService;
    const AuditService = (await import("@/modules/audit/audit.service")).AuditService;

    const adapters = { gmail: adapter, outlook: null as unknown as EmailProviderAdapter };
    const accountsService = new EmailAccountsService(
      adapters as any,
      new RbacService(),
      new AuditService(),
    );
    const queueService = { enqueue: async () => "job-3" } as any;
    const svc = new SyncService(accountsService, new RbacService(), queueService, adapters as any);

    const result = await svc.runAccountSync(TEST_ACCOUNT_ID);
    expect(result.created).toBe(1);

    const row = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.providerMessageId, "g-outbound-1"));
    expect(row).toHaveLength(1);
    expect(row[0]!.direction).toBe("outbound");
  });

  it("throws NonRetryableSyncError for unavailable accounts", async () => {
    // Mark account as revoked
    await db
      .update(emailAccounts)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(emailAccounts.id, TEST_ACCOUNT_ID));

    const SyncService = (await import("@/modules/sync/sync.service")).SyncService;
    const EmailAccountsService = (await import("@/modules/email-accounts/email-accounts.service")).EmailAccountsService;
    const RbacService = (await import("@/modules/rbac/rbac.service")).RbacService;
    const AuditService = (await import("@/modules/audit/audit.service")).AuditService;

    const adapters = { gmail: fakeGmailAdapter(), outlook: null as unknown as EmailProviderAdapter };
    const accountsService = new EmailAccountsService(
      adapters as any,
      new RbacService(),
      new AuditService(),
    );
    const queueService = { enqueue: async () => "job-4" } as any;
    const svc = new SyncService(accountsService, new RbacService(), queueService, adapters as any);

    await expect(svc.runAccountSync(TEST_ACCOUNT_ID)).rejects.toThrow(NonRetryableSyncError);

    // Restore status for cleanup
    await db
      .update(emailAccounts)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(emailAccounts.id, TEST_ACCOUNT_ID));
  });
});
