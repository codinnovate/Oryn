import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AuthService } from "@/modules/auth/auth.service";
import { SessionService } from "@/modules/auth/session.service";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { RbacService } from "@/modules/workspaces/rbac.service";
import { WorkspacesService } from "@/modules/workspaces/workspaces.service";
import {
  invitations,
  memberRoles,
  permissions,
  rolePermissions,
  roles,
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

let mailer: FakeMailer;
let authService: AuthService;
let workspacesService: WorkspacesService;
const meta = { userAgent: "vitest", ip: "127.0.0.1" };

beforeEach(async () => {
  await truncateTables([
    memberRoles,
    rolePermissions,
    permissions,
    roles,
    invitations,
    workspaceMembers,
    workspaces,
    sessions,
    verificationTokens,
    users,
  ]);
  mailer = new FakeMailer();
  authService = new AuthService(mailer, new SessionService());
  workspacesService = new WorkspacesService(new RbacService(), mailer);
});

afterAll(async () => {
  await closeTestDb();
});

async function user(email: string) {
  const { user } = await authService.register(
    { email, password: "Sup3rSecret!x", name: "T" },
    meta,
  );
  return user;
}

async function setupOwner() {
  const owner = await user("owner@example.com");
  const workspace = await workspacesService.create(owner.id, {
    name: "Acme Corp",
  });
  return { owner, workspace };
}

describe("WorkspacesService.create", () => {
  it("creates the workspace with the creator as active owner", async () => {
    const { owner, workspace } = await setupOwner();
    expect(workspace.slug).toBe("acme-corp");
    expect(workspace.ownerId).toBe(owner.id);

    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.userId).toBe(owner.id);
    expect(members[0]!.status).toBe("active");

    // System roles seeded with permission bundles.
    const roleRows = await db
      .select({ key: roles.key })
      .from(roles)
      .where(eq(roles.workspaceId, workspace.id));
    const keys = roleRows.map((r) => r.key).sort();
    expect(keys).toEqual(["admin", "member", "owner", "viewer"]);

    const ownerRole = (
      await db.select().from(roles).where(eq(roles.key, "owner"))
    )[0]!;
    const perms = await db
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, ownerRole.id));
    expect(perms.length).toBeGreaterThanOrEqual(10);
  });

  it("derives unique slugs on conflict", async () => {
    const a = await user("a@example.com");
    const b = await user("b@example.com");
    const wa = await workspacesService.create(a.id, { name: "Team Rocket" });
    const wb = await workspacesService.create(b.id, { name: "Team Rocket" });
    expect(wa.slug).toBe("team-rocket");
    expect(wb.slug).toMatch(/^team-rocket-/);
    expect(wb.slug).not.toBe(wa.slug);
  });

  it("rejects names that produce no usable slug", async () => {
    const u = await user("slugless@example.com");
    await expect(workspacesService.create(u.id, { name: "--" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("Workspace visibility and updates", () => {
  it("hides workspaces from non-members entirely", async () => {
    const { workspace } = await setupOwner();
    const outsider = await user("out@example.com");
    await expect(
      workspacesService.getForUser(outsider.id, workspace.id),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("only owners may rename or change settings", async () => {
    const { owner, workspace } = await setupOwner();
    const member = await user("member@example.com");
    await workspacesService.invite(owner.id, workspace.id, {
      email: member.email,
      roleKey: "member",
    });
    const invitationToken = mailer.sent[mailer.sent.length - 1]!.text.match(/invitations\/([A-Za-z0-9_-]+)/)![1];
    await workspacesService.acceptInvitation(member.id, member.email, invitationToken);

    await expect(
      workspacesService.update(member.id, workspace.id, { name: "Hacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const updated = await workspacesService.update(owner.id, workspace.id, {
      settings: { aiEnabled: true },
    });
    expect(updated.settings).toEqual({ aiEnabled: true });
  });

  it("lists only own workspaces with role keys", async () => {
    const { owner, workspace } = await setupOwner();
    const outsider = await user("other@example.com");
    await workspacesService.create(outsider.id, { name: "Other WS" });

    const mine = await workspacesService.listForUser(owner.id, 25, 0);
    expect(mine.total).toBe(1);
    expect(mine.items[0]!.id).toBe(workspace.id);
    expect(mine.items[0]!.roleKeys).toEqual(["owner"]);

    const theirs = await workspacesService.listForUser(outsider.id, 25, 0);
    expect(theirs.total).toBe(1);
    expect(theirs.items[0]!.name).toBe("Other WS");
  });

  it("soft-deletes only by owner", async () => {
    const { owner, workspace } = await setupOwner();
    const member = await user("del-member@example.com");
    await workspacesService.invite(owner.id, workspace.id, {
      email: member.email,
      roleKey: "member",
    });
    const token = mailer.sent.at(-1)!.text.match(/invitations\/([A-Za-z0-9_-]+)/)![1];
    await workspacesService.acceptInvitation(member.id, member.email, token);

    await expect(
      workspacesService.delete(member.id, workspace.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await workspacesService.delete(owner.id, workspace.id);
    await expect(
      workspacesService.getForUser(owner.id, workspace.id),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});
