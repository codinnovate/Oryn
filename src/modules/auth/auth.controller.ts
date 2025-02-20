import { Body, Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { getEnv } from "@/lib/env";
import { buildClearedSessionCookie, buildSessionCookie, SESSION_COOKIE_NAME } from "@/lib/http/cookies";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { AuthService } from "@/modules/auth/auth.service";
import {
  CurrentUser,
  Public,
  type AuthenticatedRequest,
} from "@/modules/auth/decorators/auth.decorators";
import { Req } from "@nestjs/common";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type LoginDto,
  type RegisterDto,
  type ResetPasswordDto,
} from "@/modules/auth/schemas";
import type { SessionMeta } from "@/modules/auth/session.service";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private sessionCookieOptions(): boolean {
    return getEnv().NODE_ENV === "production" || getEnv().APP_URL.startsWith("https://");
  }

  private metaFrom(req: AuthenticatedRequest): SessionMeta {
    return {
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip ?? null,
    };
  }

  @Public()
  @Post("register")
  @ApiOperation({ summary: "Create an account; returns session token and sets cookie" })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, session } = await this.authService.register(dto, this.metaFrom(req));
    res.setHeader("Set-Cookie", buildSessionCookie(session.token, this.sessionCookieOptions()));
    return {
      data: {
        user,
        accessToken: session.token,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  @Public()
  @HttpCode(200)
  @Post("login")
  @ApiOperation({ summary: "Exchange credentials for a session" })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, session } = await this.authService.login(dto, this.metaFrom(req));
    res.setHeader("Set-Cookie", buildSessionCookie(session.token, this.sessionCookieOptions()));
    return {
      data: {
        user,
        accessToken: session.token,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  @HttpCode(200)
  @Post("logout")
  @ApiOperation({ summary: "Revoke the current session and clear the cookie" })
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: { id: string },
  ) {
    const token = bearerOrCookieToken(req);
    if (token) {
      await this.authService.logout(token, user?.id, this.metaFrom(req));
    }
    res.setHeader("Set-Cookie", buildClearedSessionCookie(this.sessionCookieOptions()));
    return { data: { success: true } };
  }

  @Public()
  @HttpCode(200)
  @Post("refresh")
  @ApiOperation({ summary: "Rotate the current session token" })
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = bearerOrCookieToken(req);
    const rotated = await this.authService.refresh(token ?? "", this.metaFrom(req));
    res.setHeader("Set-Cookie", buildSessionCookie(rotated.token, this.sessionCookieOptions()));
    return {
      data: { accessToken: rotated.token, expiresAt: rotated.expiresAt.toISOString() },
    };
  }

  @Get("me")
  @ApiOperation({ summary: "Get the authenticated user" })
  async me(@CurrentUser() user?: { id: string }) {
    const me = await this.authService.me(user!.id);
    return { data: me };
  }

  @Public()
  @HttpCode(200)
  @Post("forgot-password")
  @ApiOperation({ summary: "Request a password reset email (constant response)" })
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) dto: { email: string },
  ) {
    await this.authService.requestPasswordReset(dto.email);
    // Constant response — no account enumeration.
    return { data: { accepted: true } };
  }

  @Public()
  @HttpCode(200)
  @Post("reset-password")
  @ApiOperation({ summary: "Consume a reset token, set new password, revoke all sessions" })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto,
  ) {
    await this.authService.resetPassword(dto);
    return { data: { success: true } };
  }

  @Public()
  @HttpCode(200)
  @Post("verify-email")
  @ApiOperation({ summary: "Consume an email verification token (single-use)" })
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) dto: { token: string },
  ) {
    await this.authService.verifyEmail(dto.token);
    return { data: { success: true } };
  }

  @HttpCode(200)
  @Post("resend-verification")
  @ApiOperation({ summary: "Resend the verification email for the current user" })
  async resendVerification(@CurrentUser() user?: { id: string }) {
    const result = await this.authService.resendVerification(user!.id);
    return { data: result };
  }
}

function bearerOrCookieToken(req: AuthenticatedRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7) || null;
  }
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return null;
}
