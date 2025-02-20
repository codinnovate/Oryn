import { Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import {
  ALL_PERMISSION_KEYS,
  memberRoles,
  permissions,
  rolePermissions,
  roles,
  workspaces,
} from "@/lib/db/schema";
import type { PermissionKey } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/api-error";
import type { AuditEntry } from "@/modules/audit/audit.service";
import { AuditService } from "@/modules/audit/audit.service";

export interface RoleWithPermissions {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissionKeys: string[];
  memberCount?: number;
}

/**
 * CRUD for workspace-scoped roles and their permission bundles.
 * System roles are immutable; custom roles cannot use reserved keys.
 */
@Injectable()
export class RolesService {
  private readonly db = getDb();

  constructor(private readonly audit: AuditService) {}

  private auditRole(entry: AuditEntry): void {
    void this.audit.record(entry);
  }

  async list(workspaceId: string): Promise<RoleWithPermissions[]> {
    const rows = await this.db
      .select({ role: roles })
      .from(roles)
      .where(eq(roles.workspaceId, workspaceId))
      .orderBy(roles.createdAt);

    const withPerms = await Promise.all(
      rows.map(async ({ role }) => ({
        ...role,
        permissionKeys: await this.permissionKeysFor(role.id),
      })),
    );
    return withPerms;
  }

  async get(workspaceId: string, roleId: string): Promise<RoleWithPermissions> {
    const role = await this.findRole(workspaceId, roleId);
    return {
      ...role,
      permissionKeys: await this.permissionKeysFor(role.id),
    };
  }

  async create(
    actorUserId: string,
    workspaceId: string,
    dto: {
      key: string;
      name: string;
      description?: string | null;
      permissionKeys: string[];
    },
  ): Promise<RoleWithPermissions> {
    this.assertValidKeys(dto.permissionKeys);

    const [workspace] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const existing = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), eq(roles.key, dto.key)))
      .limit(1);
    if (existing.length) {
      throw ApiError.conflict(`Role "${dto.key}" already exists`);
    }

    return this.db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({
          workspaceId,
          key: dto.key,
          name: dto.name,
          description: dto.description ?? null,
          isSystem: false,
        })
        .returning();
      if (!role) throw new Error("role_insert_failed");
      await this.replacePermissions(tx, role.id, dto.permissionKeys);
      this.auditRole({
        workspaceId,
        actorUserId,
        action: "role.created",
        targetType: "role",
        targetId: role.id,
        metadata: { key: role.key, permissionKeys: [...dto.permissionKeys].sort() },
      });
      return {
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissionKeys: [...dto.permissionKeys].sort(),
      };
    });
  }

  async update(
    actorUserId: string,
    workspaceId: string,
    roleId: string,
    dto: {
      name?: string;
      description?: string | null;
      permissionKeys?: string[];
    },
  ): Promise<RoleWithPermissions> {
    const role = await this.findRole(workspaceId, roleId);
    if (role.isSystem && (dto.name !== undefined || dto.permissionKeys !== undefined)) {
      // System roles may only have their description tweaked.
      if (dto.description === undefined) {
        throw ApiError.forbidden("System roles are immutable");
      }
    }
    if (dto.permissionKeys) {
      if (role.key === "owner") {
        throw ApiError.forbidden("Owner permissions cannot be changed");
      }
      this.assertValidKeys(dto.permissionKeys);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(roles.id, roleId));
      if (dto.permissionKeys) {
        await this.replacePermissions(tx, roleId, dto.permissionKeys);
      }
    });
    this.auditRole({
      workspaceId,
      actorUserId,
      action: "role.updated",
      targetType: "role",
      targetId: roleId,
      metadata: {
        name: dto.name ?? null,
        permissionKeysChanged: !!dto.permissionKeys,
      },
    });

    return this.get(workspaceId, roleId);
  }

  async delete(actorUserId: string, workspaceId: string, roleId: string): Promise<void> {
    const role = await this.findRole(workspaceId, roleId);
    if (role.isSystem) {
      throw ApiError.forbidden("System roles cannot be deleted");
    }
    const assigned = await this.db
      .select({ memberId: memberRoles.memberId })
      .from(memberRoles)
      .where(eq(memberRoles.roleId, roleId))
      .limit(1);
    if (assigned.length) {
      throw ApiError.conflict("Role is still assigned to members");
    }
    await this.db.delete(roles).where(eq(roles.id, roleId));
    this.auditRole({
      workspaceId,
      actorUserId,
      action: "role.deleted",
      targetType: "role",
      targetId: roleId,
      metadata: { key: role.key },
    });
  }

  /** Global permission catalogue for UIs building role editors. */
  async listGlobalPermissions(): Promise<Array<{ key: string }>> {
    const rows = await this.db
      .select({ key: permissions.key })
      .from(permissions)
      .orderBy(permissions.key);
    // Fall back to the static registry when the table has not been seeded yet.
    return rows.length ? rows : ALL_PERMISSION_KEYS.map((key) => ({ key }));
  }

  private async findRole(workspaceId: string, roleId: string) {
    const rows = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, roleId)))
      .limit(1);
    const role = rows[0];
    if (!role) throw ApiError.notFound("Role not found");
    return role;
  }

  private async permissionKeysFor(roleId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, roleId));
    return rows.map((r) => r.key).sort();
  }

  private assertValidKeys(keys: string[]): void {
    const valid = new Set<string>(ALL_PERMISSION_KEYS as readonly PermissionKey[]);
    const invalid = keys.filter((k) => !valid.has(k));
    if (invalid.length) {
      throw ApiError.validation(`Unknown permission keys: ${invalid.join(", ")}`);
    }
    if (new Set(keys).size !== keys.length) {
      throw ApiError.validation("Duplicate permission keys");
    }
  }

  private async replacePermissions(
    tx: Pick<typeof this.db, "delete" | "insert" | "select">,
    roleId: string,
    keys: string[],
  ): Promise<void> {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (!keys.length) return;
    const permRows = await tx
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.key, keys));
    if (permRows.length !== new Set(keys).size) {
      throw new Error("permissions_missing");
    }
    await tx
      .insert(rolePermissions)
      .values(permRows.map((p) => ({ roleId, permissionId: p.id })));
  }
}
