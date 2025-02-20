# Oryn API Reference

Base URL: `/api/v1`

Interactive docs: `GET /api/docs` (Swagger UI, non-production or when
`ENABLE_API_DOCS=true`). Machine-readable OpenAPI document: `GET /api/v1/openapi.json`.

## Conventions

### Authentication

All endpoints require authentication unless marked **Public**. Two transports:

- `Authorization: Bearer <accessToken>` (API clients)
- `oryn_session` HttpOnly cookie (browser clients; SameSite=Lax)

Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE`) must send a
same-origin `Origin` or `Referer` header — cross-origin requests are rejected
with `403 FORBIDDEN` (CSRF defense).

### Response envelope

```jsonc
// success
{ "data": { ... } }
// success (collection)
{ "data": [], "pagination": { "page": 1, "limit": 50, "total": 230, "hasNextPage": true, "hasPreviousPage": false } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": null, "requestId": "req_123" } }
```

Stable error codes: `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`,
`RESOURCE_NOT_FOUND`, `EMAIL_ACCOUNT_NOT_CONNECTED`, `OAUTH_TOKEN_EXPIRED`,
`PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `SYNC_FAILED`,
`ATTACHMENT_TOO_LARGE`, `INVALID_ATTACHMENT`, `RULE_EXECUTION_FAILED`,
`AI_SERVICE_UNAVAILABLE`.

---

## System

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | Public | Liveness probe with database check |

## Auth

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/register` | Public | Create account. Body: `{ email, password, name? }`. Returns `{ user, accessToken, expiresAt }`; sets session cookie. Sends verification email. |
| POST | `/auth/login` | Public | Exchange credentials for a session. Body: `{ email, password }`. Uniform failure (`401`) for unknown email or wrong password. |
| POST | `/auth/logout` | Bearer/Cookie | Revoke the current session and clear the cookie. |
| POST | `/auth/refresh` | Public* | Rotate the current session token; old token is revoked. *Requires a valid token to rotate. |
| GET | `/auth/me` | Bearer/Cookie | Get the authenticated user. |
| POST | `/auth/forgot-password` | Public | Request a password reset email. Always returns `{ accepted: true }` (no enumeration). |
| POST | `/auth/reset-password` | Public | Consume reset token. Body: `{ token, newPassword }`. Revokes all sessions. |
| POST | `/auth/verify-email` | Public | Consume an email-verification token (single-use). Body: `{ token }`. |
| POST | `/auth/resend-verification` | Bearer/Cookie | Resend the verification email. Returns `{ sent: boolean }`. |

Password rules: min 10 chars, at least one letter and one number/symbol.
Sessions expire after 30 days of issue; refresh rotates the token.

## Users

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/users/me` | Bearer/Cookie | Current profile (includes `preferences`). |
| PATCH | `/users/me` | Bearer/Cookie | Update profile. Body: `{ name?, avatarUrl? }` (at least one field). |
| PATCH | `/users/me/password` | Bearer/Cookie | Change password. Body: `{ currentPassword, newPassword }`. Wrong current password → `401`. Revokes all other sessions; calling session survives. |
| PATCH | `/users/me/preferences` | Bearer/Cookie | Merge keys into preferences JSONB. Known keys: `timezone`, `locale`, `theme`, `defaultAccountId`. Unknown keys → `400`. |
| PATCH | `/users/me/notifications` | Bearer/Cookie | Merge notification settings (stored under `preferences.notifications`). Keys: `emailDigest`, `importantEmails`, `automationResults`, `weeklyReport`. Unknown keys → `400`. |
| DELETE | `/users/me` | Bearer/Cookie | Soft-delete the account and revoke every session immediately. The email becomes registrable again. |

## Sessions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/sessions` | Bearer/Cookie | List active sessions (most recently used first). Each item: `{ id, userAgent, ip (masked), createdAt, lastUsedAt, expiresAt, current }`. |
| DELETE | `/auth/sessions/current/others` | Bearer/Cookie | Revoke every other session; keep the calling one. Returns `{ revoked: <count> }`. |
| DELETE | `/auth/sessions/:sessionId` | Bearer/Cookie | Revoke a specific session owned by the caller. Foreign/unknown id → `404 RESOURCE_NOT_FOUND`. Revoking the calling session via this route is rejected (`{ revoked: false, self: true }`) — use `POST /auth/logout` instead so cookies are cleared. |

## Workspaces

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/workspaces` | Bearer/Cookie | Create a workspace; caller becomes owner and a system role set (`owner`/`admin`/`member`/`viewer`) is seeded. Body: `{ name, slug? }`. Slug conflicts auto-suffix when derived from `name`; explicit invalid slug → `400`. |
| GET | `/workspaces` | Bearer/Cookie | List own active memberships. Query: `page`, `limit`. Each item includes `roleKeys`. |
| GET | `/workspaces/:workspaceId` | Member | Get one workspace. Non-members get `404 RESOURCE_NOT_FOUND` (existence is not leaked). |
| PATCH | `/workspaces/:workspaceId` | Owner | Rename or replace settings. Body: `{ name?, settings? }`. Non-owners → `403 FORBIDDEN`. |
| DELETE | `/workspaces/:workspaceId` | Owner | Soft-delete the workspace. |
| GET | `/workspaces/:workspaceId/members` | Member | List members with `roleKeys`, `status`, `joinedAt`. |
| PATCH | `/workspaces/:workspaceId/members/:memberId` | members:manage | Update member. Body: `{ status?: "active"\|"suspended", roleKey? }`. The owner cannot be modified or escalated to; `"owner"` role assignment is rejected until ownership transfer exists. |
| DELETE | `/workspaces/:workspaceId/members/:memberId` | members:manage or self | Remove a member. Members may always remove themselves; admins may remove others; the owner can never be removed. |

## Invitations

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/workspaces/:workspaceId/invitations` | members:invite | Invite by email. Body: `{ email, roleKey? }` (default `member`). Any prior pending invitation for the same email is superseded. Sends an email containing the accept URL. Inviting someone already a member → `409 RESOURCE_CONFLICT`. |
| GET | `/invitations/:token` | Public | Preview an invitation: returns `{ workspaceName, expiresAt }` only — no emails, no tokens. Unknown/used/expired token → `404`. |
| POST | `/invitations/:token/accept` | Bearer/Cookie | Accept. The authenticated account's email must match the invited address; otherwise `404` (same as unknown token). Tokens are single-use; membership becomes `active` and the invitation's role is assigned. |
| DELETE | `/workspaces/:workspaceId/invitations/:invitationId` | members:invite | Revoke a pending invitation. |

## Roles & Permissions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/permissions` | Bearer/Cookie | Global permission catalogue (`emails:read`, `roles:manage`, ...). |
| GET | `/workspaces/:workspaceId/roles` | Member | All workspace roles (system + custom) with `permissionKeys`. |
| POST | `/workspaces/:workspaceId/roles` | roles:manage | Create a custom role. Body: `{ key, name, description?, permissionKeys[] }`. Reserved keys (`owner`/`admin`/`member`/`viewer`) → `400`; duplicates → `409`; unknown permission keys → `400 VALIDATION_ERROR`. |
| PATCH | `/workspaces/:workspaceId/roles/:roleId` | roles:manage | Update name/description/permissionKeys. System roles are immutable (`403`); owner's permissions can never change. |
| DELETE | `/workspaces/:workspaceId/roles/:roleId` | roles:manage | Delete an unassigned custom role. System roles → `403`; still-assigned roles → `409 RESOURCE_CONFLICT`. |

Permission model: system roles per workspace —
`owner` (all permissions incl. workspace management), `admin` (everything except
deletion/ownership), `member` (inbox day-to-day), `viewer` (read-only).
Authorization failures use stable codes: non-members receive `RESOURCE_NOT_FOUND`,
members lacking a permission receive `FORBIDDEN`.

## Audit logs

Append-only trail of security-relevant actions. Entries are never updated or
deleted by application code; recording is fire-and-forget so an audit outage
never breaks the operation it observes.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/workspaces/:workspaceId/audit-logs` | audit_logs:read | Workspace trail, newest first. Query: `page`, `limit`, `action?` (prefix match on the dotted action namespace, e.g. `member.` or `role.`). |
| GET | `/audit-logs` | Bearer/Cookie | The caller's own actions across all their workspaces. Query: `page`, `limit`. |

Each entry: `{ id, action, actorUserId, targetType, targetId, metadata, createdAt }`.

Recorded actions: `workspace.created`, `workspace.updated`, `workspace.deleted`,
`member.invited`, `member.joined`, `member.updated`, `member.removed`,
`invitation.revoked`, `role.created`, `role.updated`, `role.deleted`, plus
account-level events (`user.registered`, `user.login`, `user.logout`,
`user.password_reset_requested`, `user.password_reset_completed`,
`user.password_changed`, `user.email_verified`, `user.account_deleted`).

---

## Planned modules

The following domains are specified in the product plan and will be documented
here as they land: workspaces & members & invitations, roles & permissions,
audit log, OAuth provider connections (Gmail/Outlook), email accounts, sync,
unified inbox, sending & scheduled emails, attachments, webhooks, rules engine,
AI classification/summaries/auto-replies, semantic search, analytics,
notifications, provider capabilities.
