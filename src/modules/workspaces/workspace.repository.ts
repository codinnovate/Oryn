import { randomUUID } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type Column,
} from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import {
  invitations,
  memberRoles,
  permissions,
  rolePermissions,
  roles,
  users,
  workspaceMembers,
  workspaces,
  type Invitation,
  type Workspace,
  type WorkspaceMember,
} from "@/lib/db/schema";
import { SYSTEM_ROLES, ALL_PERMISSION_KEYS } from "@/lib/db/schema";
import { hashToken } from "@/lib/crypto/tokens";

export interface MemberWithUser extends WorkspaceMember {
  userEmail: string;
  userName: string | null;
}

/**
 * Data access for workspaces, memberships, system-role seeding and
 * invitations. Business rules live in WorkspacesService.
 */
export class WorkspaceRepository {
  private readonly db = getDb();

  findActiveBySlug(slug: string): Promise<Workspace | undefined> {
    return this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.slug, slug), isNull(workspaces.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);
  }

  findActiveById(id: string): Promise<Workspace | undefined> {
    return this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);
  }

  /**
   * Creates the workspace, seeds its system roles (with permission bundles)
   * and the owner membership — all in one transaction.
   */
  async createWithOwner(values: {
    name: string;
    slug: string;
    ownerId: string;
    plan?: string;
  }): Promise<{ workspace: Workspace; memberId: string }> {
    return this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          name: values.name,
          slug: values.slug,
          ownerId: values.ownerId,
          plan: values.plan ?? "free",
        })
        .returning();
      if (!workspace) throw new Error("workspace_insert_failed");

      // Ensure global system permission rows exist (idempotent), then load them.
      await tx
        .insert(permissions)
        .values(
          ALL_PERMISSION_KEYS.map((key) => ({
            key,
            description: null,
            isSystem: true,
          })),
        )
        .onConflictDoNothing({ target: permissions.key });
      const permissionRows = await tx
        .select({ id: permissions.id, key: permissions.key })
        .from(permissions)
        .where(inArraySafe(permissions.key, ALL_PERMISSION_KEYS));
      const byKey = new Map(permissionRows.map((p) => [p.key, p.id]));

      const roleIds = new Map<string, string>();
      for (const def of SYSTEM_ROLES) {
        const keys =
          def.permissionKeys === "*" ? ALL_PERMISSION_KEYS : def.permissionKeys;
        const [role] = await tx
          .insert(roles)
          .values({
            workspaceId: workspace.id,
            key: def.key,
            name: def.name,
            description: def.description,
            isSystem: true,
          })
          .returning();
        if (!role) throw new Error("role_insert_failed");
        roleIds.set(def.key, role.id);
        const permIds = keys
          .map((k) => byKey.get(k))
          .filter((id): id is string => Boolean(id));
        if (permIds.length) {
          await tx
            .insert(rolePermissions)
            .values(permIds.map((permissionId) => ({ roleId: role.id, permissionId })));
        }
      }

      const [member] = await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: workspace.id,
          userId: values.ownerId,
          status: "active",
          joinedAt: new Date(),
        })
        .returning();
      if (!member) throw new Error("member_insert_failed");

      const ownerRoleId = roleIds.get("owner");
      if (ownerRoleId) {
        await tx
          .insert(memberRoles)
          .values({ memberId: member.id, roleId: ownerRoleId });
      }
      return { workspace, memberId: member.id };
    });
  }

  update(id: string, values: Partial<Workspace>): Promise<Workspace | undefined> {
    return this.db
      .update(workspaces)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .returning()
      .then((rows) => rows[0]);
  }

  /** Soft delete; keeps membership history intact. */
  softDelete(id: string): Promise<void> {
    return this.db
      .update(workspaces)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .then(() => undefined);
  }

  listForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: Array<Workspace & { roleKeys: string[] }>; total: number }> {
    return (async () => {
      const items = await this.db
        .select({
          workspace: workspaces,
          member: workspaceMembers,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.status, "active"),
            isNull(workspaces.deletedAt),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(limit)
        .offset(offset);

      const totalRows = await this.db
        .select({ value: count() })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.status, "active"),
            isNull(workspaces.deletedAt),
          ),
        );

      const withRoles = await Promise.all(
        items.map(async ({ workspace, member }) => ({
          ...workspace,
          roleKeys: await this.roleKeysFor(member.id),
        })),
      );
      return { items: withRoles, total: totalRows[0]?.value ?? 0 };
    })();
  }

  listMembers(workspaceId: string): Promise<MemberWithUser[]> {
    return this.db
      .select({
        id: workspaceMembers.id,
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        status: workspaceMembers.status,
        invitedByUserId: workspaceMembers.invitedByUserId,
        joinedAt: workspaceMembers.joinedAt,
        createdAt: workspaceMembers.createdAt,
        updatedAt: workspaceMembers.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(workspaceMembers.createdAt);
  }

  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMember | undefined> {
    return this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
  }

  findMemberById(
    workspaceId: string,
    memberId: string,
  ): Promise<WorkspaceMember | undefined> {
    return this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.id, memberId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
  }

  updateMember(memberId: string, values: Partial<WorkspaceMember>): Promise<void> {
    return this.db
      .update(workspaceMembers)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(workspaceMembers.id, memberId))
      .then(() => undefined);
  }

  removeMember(memberId: string): Promise<void> {
    // Cascades to member_roles.
    return this.db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, memberId))
      .then(() => undefined);
  }

  roleIdsForWorkspace(workspaceId: string): Promise<Map<string, string>> {
    return this.db
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(eq(roles.workspaceId, workspaceId))
      .then((rows) => new Map(rows.map((r) => [r.key, r.id])));
  }

  async assignRole(memberId: string, roleKey: string, workspaceId: string): Promise<void> {
    const ids = await this.roleIdsForWorkspace(workspaceId);
    const roleId = ids.get(roleKey);
    if (!roleId) throw new Error(`unknown_role_${roleKey}`);
    // Replace existing roles with the single requested one.
    await this.db.transaction(async (tx) => {
      await tx.delete(memberRoles).where(eq(memberRoles.memberId, memberId));
      await tx.insert(memberRoles).values({ memberId, roleId });
    });
  }

  async createInvitation(values: {
    workspaceId: string;
    emailNormalized: string;
    invitedByUserId: string;
    expiresAt: Date;
    roleKey: string;
  }): Promise<{ invitation: Invitation; token: string }> {
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    return this.db.transaction(async (tx) => {
      // Supersede any pending invitation for the same (workspace, email).
      await tx
        .update(invitations)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(
          and(
            eq(invitations.workspaceId, values.workspaceId),
            eq(invitations.emailNormalized, values.emailNormalized),
            sql`${invitations.status} = 'pending'`,
          ),
        );
      const [invitation] = await tx
        .insert(invitations)
        .values({
          workspaceId: values.workspaceId,
          emailNormalized: values.emailNormalized,
          invitedByUserId: values.invitedByUserId,
          tokenHash: hashToken(token),
          expiresAt: values.expiresAt,
          status: "pending",
        })
        .returning();
      if (!invitation) throw new Error("invitation_insert_failed");
      return { invitation, token };
    });
  }

  findPendingByTokenHash(tokenHash: string): Promise<Invitation | undefined> {
    return this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          sql`${invitations.status} = 'pending'`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
  }

  async acceptInvitation(
    invitationId: string,
    acceptedByUserId: string,
    roleKey: string,
  ): Promise<WorkspaceMember> {
    return this.db.transaction(async (tx) => {
      // Guarded transition: only a pending, unexpired invitation can be accepted.
      const updated = await tx
        .update(invitations)
        .set({ status: "accepted", acceptedAt: new Date(), acceptedByUserId })
        .where(
          and(
            eq(invitations.id, invitationId),
            sql`${invitations.status} = 'pending'`,
          ),
        )
        .returning();
      const invitation = updated[0];
      if (!invitation) throw new Error("invitation_not_acceptable");

      const existing = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, invitation.workspaceId),
            eq(workspaceMembers.userId, acceptedByUserId),
          ),
        )
        .limit(1);

      let member = existing[0];
      if (member) {
        const activated = await tx
          .update(workspaceMembers)
          .set({
            status: "active",
            joinedAt: member.joinedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(workspaceMembers.id, member.id))
          .returning();
        member = activated[0]!;
      } else {
        const inserted = await tx
          .insert(workspaceMembers)
          .values({
            workspaceId: invitation.workspaceId,
            userId: acceptedByUserId,
            status: "active",
            invitedByUserId: invitation.invitedByUserId,
            joinedAt: new Date(),
          })
          .returning();
        member = inserted[0]!;
      }

      const [role] = await tx
        .select()
        .from(roles)
        .where(
          and(eq(roles.workspaceId, invitation.workspaceId), eq(roles.key, roleKey)),
        )
        .limit(1);
      if (role) {
        await tx.delete(memberRoles).where(eq(memberRoles.memberId, member.id));
        await tx.insert(memberRoles).values({ memberId: member.id, roleId: role.id });
      }
      return member;
    });
  }

  revokeInvitation(invitationId: string): Promise<boolean> {
    return this.db
      .update(invitations)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(eq(invitations.id, invitationId), sql`${invitations.status} = 'pending'`),
      )
      .returning({ id: invitations.id })
      .then((rows) => rows.length > 0);
  }

  listInvitations(workspaceId: string): Promise<Array<Invitation & { roleKey?: string }>> {
    return this.db
      .select()
      .from(invitations)
      .where(eq(invitations.workspaceId, workspaceId))
      .orderBy(desc(invitations.createdAt));
  }

  roleKeysFor(memberId: string): Promise<string[]> {
    return this.db
      .select({ key: roles.key })
      .from(memberRoles)
      .innerJoin(roles, eq(roles.id, memberRoles.roleId))
      .where(eq(memberRoles.memberId, memberId))
      .then((rows) => rows.map((r) => r.key));
  }
}

/** drizzle inArray that tolerates empty arrays. */
function inArraySafe<T extends Column>(column: T, values: readonly string[]) {
  return values.length ? inArray(column, [...values]) : sql`false`;
}
