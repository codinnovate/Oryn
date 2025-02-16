import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import { users, type User } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto/passwords";
import { ApiError } from "@/lib/http/api-error";
import { SessionService } from "@/modules/auth/session.service";

/**
 * Profile, preferences and account lifecycle for the authenticated user.
 * Session lifecycle lives in SessionService; this service delegates to it so
 * session rules stay in one place.
 */
@Injectable()
export class UsersService {
  private readonly db = getDb();

  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async getProfile(userId: string): Promise<User> {
    return this.findActiveUser(userId);
  }

  async updateProfile(
    userId: string,
    dto: { name?: string; avatarUrl?: string | null },
  ): Promise<User> {
    await this.findActiveUser(userId);
    const updated = await this.db
      .update(users)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning()
      .then((rows) => rows[0]!);
    return updated;
  }

  /**
   * Verifies the current password (when set), rehashes with a fresh scrypt
   * salt, and revokes every other session. The caller's own session survives
   * so the request is not terminated mid-flight.
   */
  async changePassword(
    userId: string,
    currentSessionId: string | undefined,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.findActiveUser(userId);
    if (user.passwordHash) {
      const ok = await verifyPassword(currentPassword, user.passwordHash);
      if (!ok) {
        // Uniform message — never confirm whether a password exists.
        throw ApiError.unauthorized("Invalid credentials");
      }
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));
    if (currentSessionId) {
      await this.sessions.revokeAllExceptForUser(userId, currentSessionId);
    } else {
      await this.sessions.revokeAllForUser(userId);
    }
  }

  /** Shallow merge at the top level of the preferences JSONB. */
  async updatePreferences(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<User> {
    await this.findActiveUser(userId);
    const [updated] = await this.db
      .update(users)
      .set({
        preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return updated!;
  }

  /** Merges notification settings nested under `preferences.notifications`. */
  async updateNotifications(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<User> {
    await this.findActiveUser(userId);
    const [updated] = await this.db
      .update(users)
      .set({
        preferences: sql`
          jsonb_set(
            coalesce(${users.preferences}, '{}'::jsonb),
            '{notifications}'::text[],
            coalesce(${users.preferences} -> 'notifications', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
          )`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return updated!;
  }

  /**
   * Soft-deletes the account: marks status=deleted, scrubs the login email
   * uniqueness slot, and revokes every session immediately.
   */
  async deleteAccount(userId: string): Promise<void> {
    await this.findActiveUser(userId);
    await this.db
      .update(users)
      .set({
        deletedAt: new Date(),
        status: "deleted",
        emailNormalized: `deleted+${userId}@oryn.invalid`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    await this.sessions.revokeAllForUser(userId);
  }

  private async findActiveUser(userId: string): Promise<User> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || user.deletedAt !== null || user.status === "deleted") {
      throw ApiError.unauthorized();
    }
    return user;
  }
}
