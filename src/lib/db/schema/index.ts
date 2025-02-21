export * from "./_shared";
export * from "./users.schema";
export * from "./workspaces.schema";
export * from "./rbac.schema";
export * from "./audit.schema";
export * from "./emailAccounts.schema";

/**
 * Canonical permission keys. The permissions table is seeded from this
 * registry; services authorize against these constants.
 */
export const PermissionKeys = {
  WorkspaceManage: "workspaces:manage",
  MembersInvite: "members:invite",
  MembersManage: "members:manage",
  RolesManage: "roles:manage",
  EmailAccountsManage: "email_accounts:manage",
  EmailsRead: "emails:read",
  EmailsWrite: "emails:write",
  EmailsSend: "emails:send",
  RulesManage: "rules:manage",
  AiUse: "ai:use",
  AnalyticsRead: "analytics:read",
  AuditLogsRead: "audit_logs:read",
  WebhooksManage: "webhooks:manage",
} as const;

export type PermissionKey = (typeof PermissionKeys)[keyof typeof PermissionKeys];

export const ALL_PERMISSION_KEYS = Object.values(PermissionKeys);

export const SYSTEM_ROLES: Array<{
  key: string;
  name: string;
  description: string;
  permissionKeys: readonly string[] | "*";
}> = [
  {
    key: "owner",
    name: "Owner",
    description: "Full control over the workspace",
    permissionKeys: "*",
  },
  {
    key: "admin",
    name: "Admin",
    description: "Manage everything except workspace deletion/ownership transfer",
    permissionKeys: ALL_PERMISSION_KEYS.filter(
      (k) => k !== PermissionKeys.WorkspaceManage,
    ),
  },
  {
    key: "member",
    name: "Member",
    description: "Day-to-day inbox access",
    permissionKeys: [
      PermissionKeys.EmailsRead,
      PermissionKeys.EmailsWrite,
      PermissionKeys.EmailsSend,
      PermissionKeys.AiUse,
    ],
  },
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only access",
    permissionKeys: [PermissionKeys.EmailsRead, PermissionKeys.AnalyticsRead],
  },
];
