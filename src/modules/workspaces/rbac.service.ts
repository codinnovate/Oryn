import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import {
  memberRoles,
  permissions,
  rolePermissions,
  roles,
  workspaceMembers,
  workspaces,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/api-error";

/**
 * Resolves a user's effective permissions inside a workspace:
 * membership (must be active) -> roles -> permission keys.
 */
@Injectable()
export class RbacService {
  private readonly db = getDb();

  /**
   * Returns the active membership or throws RESOURCE_NOT_FOUND (never
   * FORBIDDEN for non-members, so workspace existence is not leaked).
   */
  async requireMembership(userId: string, workspaceId: string) {
    const rows = await this.db
      .select({ member: workspaceMembers, workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw ApiError.notFound("Workspace not found");
    }
    if (row.member.status !== "active") {
      throw ApiError.forbidden("Membership is not active");
    }
    return row;
  }

  /** Effective permission keys for an active member. */
  async permissionsFor(userId: string, workspaceId: string): Promise<Set<string>> {
    await this.requireMembership(userId, workspaceId);
    return this.effectivePermissions(userId, workspaceId);
  }

  /** Throws FORBIDDEN unless the user holds the permission key. */
  async requirePermission(
    userId: string,
    workspaceId: string,
    key: string,
  ): Promise<void> {
    const perms = await this.permissionsFor(userId, workspaceId);
    if (!perms.has(key)) {
      throw ApiError.forbidden(`Missing permission: ${key}`);
    }
  }

  async roleKeysFor(memberId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: roles.key })
      .from(memberRoles)
      .innerJoin(roles, eq(roles.id, memberRoles.roleId))
      .where(eq(memberRoles.memberId, memberId));
    return rows.map((r) => r.key);
  }

  private async effectivePermissions(
    userId: string,
    workspaceId: string,
  ): Promise<Set<string>> {
    const rows = await this.db
      .select({ permissionKey: permissions.key })
      .from(memberRoles)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.id, memberRoles.memberId),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, memberRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId));
    return new Set(rows.map((r) => r.permissionKey));
  }
}
