import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import {
  sessions,
  users,
  verificationTokens,
  type Session,
  type User,
} from "@/lib/db/schema";

/**
 * Data access for authentication flows. Kept separate from business logic
 * so services stay testable and queries are auditable in one place.
 */
export class AuthRepository {
  private readonly db = getDb();

  findUserByEmail(emailNormalized: string): Promise<User | undefined> {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.emailNormalized, emailNormalized), isNull(users.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);
  }

  findUserById(id: string): Promise<User | undefined> {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);
  }

  async insertUser(values: Partial<User> & { email: string; emailNormalized: string }): Promise<User> {
    const [row] = await this.db.insert(users).values(values).returning();
    return row!;
  }

  updateUser(id: string, values: Partial<User>): Promise<User | undefined> {
    return this.db
      .update(users)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning()
      .then((rows) => rows[0]);
  }

  insertSession(values: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<Session> {
    return this.db
      .insert(sessions)
      .values(values)
      .returning()
      .then((rows) => rows[0]!);
  }

  /**
   * Resolves a live (non-revoked, non-expired) session with its user.
   * Also refreshes last_used_at at most once per minute to reduce writes.
   */
  async findLiveSessionByTokenHash(tokenHash: string): Promise<{ session: Session; user: User } | null> {
    const rows = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.user.status !== "active" || row.user.deletedAt !== null) {
      return null;
    }
    if (Date.now() - row.session.lastUsedAt.getTime() > 60_000) {
      await this.touchSession(row.session.id);
    }
    return row;
  }

  touchSession(sessionId: string): Promise<void> {
    return this.db
      .update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .then(() => undefined);
  }

  revokeSession(id: string): Promise<void> {
    return this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, id))
      .then(() => undefined);
  }

  revokeAllForUser(userId: string): Promise<void> {
    return this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .then(() => undefined);
  }

  listActiveSessionsForUser(userId: string): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastUsedAt));
  }

  /** Revokes one session only if it belongs to the given user; returns match. */
  revokeSessionForUser(sessionId: string, userId: string): Promise<boolean> {
    return this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id })
      .then((rows) => rows.length > 0);
  }

  revokeAllForUserExcept(userId: string, keepSessionId: string): Promise<number> {
    return this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          ne(sessions.id, keepSessionId),
        ),
      )
      .returning({ id: sessions.id })
      .then((rows) => rows.length);
  }

  insertVerificationToken(values: {
    userId: string;
    type: "verify_email" | "password_reset";
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    // Supersede any outstanding token of the same type for this user.
    return this.db.transaction(async (tx) => {
      await tx
        .update(verificationTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(verificationTokens.userId, values.userId),
            eq(verificationTokens.type, values.type),
            isNull(verificationTokens.usedAt),
          ),
        );
      await tx.insert(verificationTokens).values(values);
    });
  }

  findValidVerificationToken(
    tokenHash: string,
    type: "verify_email" | "password_reset",
  ): Promise<typeof verificationTokens.$inferSelect | undefined> {
    return this.db
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.tokenHash, tokenHash),
          eq(verificationTokens.type, type),
          isNull(verificationTokens.usedAt),
          gt(verificationTokens.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
  }

  consumeVerificationToken(tokenId: string): Promise<void> {
    // Guarded update prevents double-consumption races.
    return this.db
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(verificationTokens.id, tokenId),
          isNull(verificationTokens.usedAt),
        ),
      )
      .returning({ id: verificationTokens.id })
      .then((rows) => {
        if (!rows.length) {
          throw new Error("token_already_used");
        }
      })
      .then(() => undefined);
  }

  countUsers(): Promise<number> {
    return this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .then((rows) => rows[0]?.count ?? 0);
  }
}
