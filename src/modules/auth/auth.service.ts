import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { ApiError } from "@/lib/http/api-error";
import type { Mailer } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";
import { hashPassword, verifyPassword } from "@/lib/crypto/passwords";
import { hashToken, randomToken } from "@/lib/crypto/tokens";
import type { User } from "@/lib/db/schema";
import { AuthRepository } from "@/modules/auth/auth.repository";
import {
  normalizeEmail,
  type LoginDto,
  type RegisterDto,
  type ResetPasswordDto,
} from "@/modules/auth/schemas";
import type { SessionService} from "@/modules/auth/session.service";
import { type IssuedSession, type SessionMeta } from "@/modules/auth/session.service";

const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30m

/** Public shape of a user — never exposes password hashes or internal fields. */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  isEmailVerified: boolean;
  status: string;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isEmailVerified: user.isEmailVerified,
    status: user.status,
    createdAt: user.createdAt,
  };
}

@Injectable()
export class AuthService {
  private readonly repo = new AuthRepository();

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly sessions: SessionService,
  ) {}

  async register(dto: RegisterDto, meta: SessionMeta): Promise<{ user: PublicUser; session: IssuedSession }> {
    const emailNormalized = normalizeEmail(dto.email);
    const existing = await this.repo.findUserByEmail(emailNormalized);
    if (existing) {
      throw ApiError.conflict("An account with this email already exists");
    }
    const passwordHash = await hashPassword(dto.password);
    let user = await this.repo.insertUser({
      email: dto.email.trim(),
      emailNormalized,
      name: dto.name ?? null,
      passwordHash,
    });

    await this.sendVerificationToken(user);

    const session = await this.sessions.create(user.id, meta);
    user = (await this.repo.updateUser(user.id, { lastLoginAt: new Date() })) ?? user;
    return { user: toPublicUser(user), session };
  }

  async login(dto: LoginDto, meta: SessionMeta): Promise<{ user: PublicUser; session: IssuedSession }> {
    const user = await this.repo.findUserByEmail(normalizeEmail(dto.email));
    // Uniform failure message prevents user enumeration.
    if (!user || !user.passwordHash) {
      throw ApiError.unauthorized("Invalid email or password");
    }
    const ok = await verifyPassword(dto.password, user.passwordHash);
    if (!ok) {
      throw ApiError.unauthorized("Invalid email or password");
    }
    if (user.status !== "active") {
      throw ApiError.forbidden("This account is suspended");
    }
    const session = await this.sessions.create(user.id, meta);
    await this.repo.updateUser(user.id, { lastLoginAt: new Date() });
    return { user: toPublicUser(user), session };
  }

  async logout(rawToken: string): Promise<void> {
    await this.sessions.revokeByRawToken(rawToken);
  }

  async refresh(rawToken: string, meta: SessionMeta): Promise<IssuedSession> {
    const rotated = await this.sessions.rotate(rawToken, meta);
    if (!rotated) {
      throw ApiError.unauthorized("Invalid or expired session");
    }
    return rotated;
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw ApiError.unauthorized();
    }
    return toPublicUser(user);
  }

  /**
   * Always resolves successfully — never reveals whether the email exists.
   * The response is constant regardless of account existence.
   */
  async requestPasswordReset(email: string): Promise<{ accepted: true }> {
    const user = await this.repo.findUserByEmail(normalizeEmail(email));
    if (user && user.passwordHash) {
      const rawToken = randomToken(32);
      await this.repo.insertVerificationToken({
        userId: user.id,
        type: "password_reset",
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      });
      await this.mailer.send({
        to: user.email,
        subject: "Reset your Oryn password",
        text: `Use this token to reset your password (valid 30 minutes): ${rawToken}`,
      });
    }
    return { accepted: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const record = await this.repo.findValidVerificationToken(
      hashToken(dto.token),
      "password_reset",
    );
    if (!record) {
      throw ApiError.validation("Invalid or expired reset token");
    }
    try {
      await this.repo.consumeVerificationToken(record.id);
    } catch {
      throw ApiError.conflict("Reset token was already used");
    }
    const passwordHash = await hashPassword(dto.password);
    await this.repo.updateUser(record.userId, { passwordHash });
    // Password change invalidates every existing session.
    await this.sessions.revokeAllForUser(record.userId);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const record = await this.repo.findValidVerificationToken(
      hashToken(rawToken),
      "verify_email",
    );
    if (!record) {
      throw ApiError.validation("Invalid or expired verification token");
    }
    try {
      await this.repo.consumeVerificationToken(record.id);
    } catch {
      throw ApiError.conflict("Verification token was already used");
    }
    await this.repo.updateUser(record.userId, { isEmailVerified: true });
  }

  async resendVerification(userId: string): Promise<{ sent: boolean }> {
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw ApiError.unauthorized();
    }
    if (user.isEmailVerified) {
      return { sent: false };
    }
    await this.sendVerificationToken(user);
    return { sent: true };
  }

  private async sendVerificationToken(user: User): Promise<void> {
    const rawToken = randomToken(32);
    await this.repo.insertVerificationToken({
      userId: user.id,
      type: "verify_email",
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + VERIFY_EMAIL_TTL_MS),
    });
    await this.mailer.send({
      to: user.email,
      subject: "Verify your Oryn email address",
      text: `Verify your email with this token (valid 24 hours): ${rawToken}`,
    });
  }
}
