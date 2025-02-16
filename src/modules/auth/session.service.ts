import { Injectable } from "@nestjs/common";
import { randomToken, hashToken } from "@/lib/crypto/tokens";
import type { Session, User } from "@/lib/db/schema";
import { AuthRepository } from "@/modules/auth/auth.repository";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  token: string;
  session: Session;
  expiresAt: Date;
}

/**
 * Creates and resolves opaque session tokens. Raw tokens are shown once;
 * only SHA-256 hashes are persisted.
 */
@Injectable()
export class SessionService {
  private readonly repo = new AuthRepository();

  async create(userId: string, meta: SessionMeta = {}): Promise<IssuedSession> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await this.repo.insertSession({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });
    return { token, session, expiresAt };
  }

  async resolve(
    rawToken: string,
  ): Promise<{ user: User; sessionId: string } | null> {
    if (!rawToken || rawToken.length > 512) {
      return null;
    }
    const found = await this.repo.findLiveSessionByTokenHash(hashToken(rawToken));
    if (!found) return null;
    return { user: found.user, sessionId: found.session.id };
  }

  /** Rotates a session: revokes the old token and issues a fresh one. */
  async rotate(rawToken: string, meta: SessionMeta = {}): Promise<IssuedSession | null> {
    const resolved = await this.resolve(rawToken);
    if (!resolved) return null;
    await this.revokeByRawToken(rawToken);
    return this.create(resolved.user.id, meta);
  }

  async revokeByRawToken(rawToken: string): Promise<void> {
    const found = await this.repo.findLiveSessionByTokenHash(hashToken(rawToken));
    if (found) {
      await this.repo.revokeSession(found.session.id);
    }
  }

  revokeAllForUser(userId: string): Promise<void> {
    return this.repo.revokeAllForUser(userId);
  }

  /** Active (non-revoked) sessions for a user, most recently used first. */
  listActive(userId: string): Promise<Session[]> {
    return this.repo.listActiveSessionsForUser(userId);
  }

  /** Revokes one session scoped to its owner; false when missing/foreign. */
  async revokeOwned(sessionId: string, userId: string): Promise<boolean> {
    return this.repo.revokeSessionForUser(sessionId, userId);
  }

  /** Revokes every active session except `keepSessionId`; returns count. */
  revokeAllExceptForUser(userId: string, keepSessionId: string): Promise<number> {
    return this.repo.revokeAllForUserExcept(userId, keepSessionId);
  }
}
