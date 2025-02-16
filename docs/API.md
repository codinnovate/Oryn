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

---

## Planned modules

The following domains are specified in the product plan and will be documented
here as they land: workspaces & members & invitations, roles & permissions,
audit log, OAuth provider connections (Gmail/Outlook), email accounts, sync,
unified inbox, sending & scheduled emails, attachments, webhooks, rules engine,
AI classification/summaries/auto-replies, semantic search, analytics,
notifications, provider capabilities.
