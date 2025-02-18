import { Inject, Injectable } from "@nestjs/common";
import { normalizeEmail } from "@/modules/auth/schemas";
import type { Mailer, MailInput } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";
import { getEnv } from "@/lib/env";
import { randomToken, hashToken } from "@/lib/crypto/tokens";
import { ApiError } from "@/lib/http/api-error";
import { PermissionKeys } from "@/lib/db/schema";
import type { Invitation, Workspace, WorkspaceMember } from "@/lib/db/schema";
import { RbacService } from "@/modules/workspaces/rbac.service";
import {
  slugify,
  type InviteMemberDto,
  type SystemRoleKey,
  type UpdateMemberDto,
  type UpdateWorkspaceDto,
} from "@/modules/workspaces/schemas";
import { WorkspaceRepository } from "@/modules/workspaces/workspace.repository";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SLUG_ATTEMPTS = 6;

/**
 * Workspace lifecycle, membership administration and invitations.
 * Authorization is delegated to RbacService; persistence to the repository.
 */
@Injectable()
export class WorkspacesService {
  private readonly repo = new WorkspaceRepository();

  constructor(
    private readonly rbac: RbacService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async create(
    userId: string,
    dto: { name: string; slug?: string },
  ): Promise<Workspace> {
    const base = slugify(dto.slug ?? dto.name);
    if (!base) {
      throw ApiError.validation("Could not derive a valid slug");
    }
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${randomToken(2).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || Math.random().toString(36).slice(2, 6)}`;
      const taken = await this.repo.findActiveBySlug(candidate);
      if (taken) continue;
      const { workspace } = await this.repo.createWithOwner({
        name: dto.name,
        slug: candidate,
        ownerId: userId,
      });
      return workspace;
    }
    throw ApiError.conflict("Could not allocate a unique slug, try a custom one");
  }

  async getForUser(userId: string, workspaceId: string): Promise<Workspace> {
    await this.rbac.requireMembership(userId, workspaceId);
    return this.repo.findActiveById(workspaceId) as Promise<Workspace>;
  }

  async listForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: Array<Workspace & { roleKeys: string[] }>; total: number }> {
    return this.repo.listForUser(userId, limit, offset);
  }

  async update(userId: string, workspaceId: string, dto: UpdateWorkspaceDto): Promise<Workspace> {
    // Only owners may rename or change settings (admin intentionally excluded).
    await this.rbac.requirePermission(userId, workspaceId, PermissionKeys.WorkspaceManage);
    const updated = await this.repo.update(workspaceId, {
      ...(dto.name ? { name: dto.name } : {}),
      ...(dto.settings ? { settings: dto.settings } : {}),
    });
    if (!updated) throw ApiError.notFound("Workspace not found");
    return updated;
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    const { workspace } = await this.rbac.requireMembership(userId, workspaceId);
    if (workspace.ownerId !== userId) {
      throw ApiError.forbidden("Only the owner can delete a workspace");
    }
    await this.repo.softDelete(workspaceId);
  }

  async listMembers(
    userId: string,
    workspaceId: string,
  ): Promise<Array<{ member: WorkspaceMember; email: string; name: string | null; roleKeys: string[] }>> {
    await this.rbac.requireMembership(userId, workspaceId);
    const members = await this.repo.listMembers(workspaceId);
    return Promise.all(
      members.map(async (m) => ({
        member: m,
        email: m.userEmail,
        name: m.userName,
        roleKeys: await this.repo.roleKeysFor(m.id),
      })),
    );
  }

  async updateMember(
    actorId: string,
    workspaceId: string,
    targetMemberId: string,
    dto: UpdateMemberDto,
  ): Promise<void> {
    await this.rbac.requirePermission(actorId, workspaceId, PermissionKeys.MembersManage);
    const target = await this.repo.findMemberById(workspaceId, targetMemberId);
    if (!target) throw ApiError.notFound("Member not found");

    const { workspace } = await this.rbac.requireMembership(actorId, workspaceId);
    const isOwnerTarget = target.userId === workspace.ownerId;
    if (isOwnerTarget && (dto.status === "suspended" || dto.roleKey)) {
      throw ApiError.forbidden("The workspace owner cannot be modified");
    }
    if (dto.roleKey === "owner") {
      throw ApiError.forbidden("Ownership transfer is not supported yet");
    }
    if (dto.status) {
      await this.repo.updateMember(target.id, { status: dto.status });
    }
    if (dto.roleKey) {
      await this.repo.assignRole(target.id, dto.roleKey, workspaceId);
    }
  }

  async removeMember(
    actorId: string,
    workspaceId: string,
    targetMemberId: string,
  ): Promise<void> {
    const { workspace } = await this.rbac.requireMembership(actorId, workspaceId);
    const target = await this.repo.findMemberById(workspaceId, targetMemberId);
    if (!target) throw ApiError.notFound("Member not found");

    const selfRemoval = target.userId === actorId;
    if (!selfRemoval) {
      await this.rbac.requirePermission(actorId, workspaceId, PermissionKeys.MembersManage);
    }
    if (target.userId === workspace.ownerId) {
      throw ApiError.forbidden("The workspace owner cannot be removed");
    }
    await this.repo.removeMember(target.id);
  }

  async invite(
    actorId: string,
    workspaceId: string,
    dto: InviteMemberDto,
  ): Promise<{ invitation: Invitation }> {
    await this.rbac.requirePermission(actorId, workspaceId, PermissionKeys.MembersInvite);
    if (dto.roleKey === "owner") {
      throw ApiError.validation("Cannot invite someone as owner");
    }
    const { workspace } = await this.rbac.requireMembership(actorId, workspaceId);

    // Existing active member?
    const normalized = normalizeEmail(dto.email);
    const existingMembers = await this.repo.listMembers(workspaceId);
    if (
      existingMembers.some((m) => normalizeEmail(m.userEmail) === normalized)
    ) {
      throw ApiError.conflict("User is already a member of this workspace");
    }

    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const { invitation, token } = await this.repo.createInvitation({
      workspaceId,
      emailNormalized: normalized,
      invitedByUserId: actorId,
      expiresAt,
      roleKey: dto.roleKey,
    });

    const input: MailInput = {
      to: dto.email,
      subject: `You're invited to ${workspace.name} on Oryn`,
      text: [
        `You have been invited to join ${workspace.name}.`,
        "",
        "Accept your invitation:",
        `${getEnv().APP_URL}/invitations/${token}`,
        "",
        "This link expires in 7 days.",
      ].join("\n"),
    };
    await this.mailer.send(input);
    return { invitation };
  }

  /** Public preview — only minimal, non-sensitive fields. */
  async previewInvitation(token: string): Promise<{
    workspaceName: string;
    roleKey: SystemRoleKey | "member";
    expiresAt: Date;
  }> {
    const invitation = await this.findLiveInvitation(token);
    const workspace = await this.repo.findActiveById(invitation.workspaceId);
    if (!workspace) throw ApiError.notFound("Invitation not found");
    return {
      workspaceName: workspace.name,
      roleKey: "member",
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Accepts an invitation. The caller must be authenticated AND their account
   * email must match the invited address — tokens are not bearer capabilities.
   */
  async acceptInvitation(
    userId: string,
    userEmail: string,
    token: string,
  ): Promise<WorkspaceMember> {
    const invitation = await this.findLiveInvitation(token);
    if (normalizeEmail(userEmail) !== invitation.emailNormalized) {
      // Same message as unknown token: do not confirm which part failed.
      throw ApiError.notFound("Invitation not found");
    }
    try {
      return await this.repo.acceptInvitation(invitation.id, userId, "member");
    } catch (err) {
      if (err instanceof Error && err.message === "invitation_not_acceptable") {
        throw ApiError.notFound("Invitation not found");
      }
      throw err;
    }
  }

  async revokeInvitation(
    actorId: string,
    workspaceId: string,
    invitationId: string,
  ): Promise<void> {
    await this.rbac.requirePermission(actorId, workspaceId, PermissionKeys.MembersInvite);
    const ok = await this.repo.revokeInvitation(invitationId);
    if (!ok) throw ApiError.notFound("Pending invitation not found");
  }

  private async findLiveInvitation(token: string): Promise<Invitation> {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
      throw ApiError.notFound("Invitation not found");
    }
    const invitation = await this.repo.findPendingByTokenHash(hashToken(token));
    if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
      throw ApiError.notFound("Invitation not found");
    }
    return invitation;
  }
}
