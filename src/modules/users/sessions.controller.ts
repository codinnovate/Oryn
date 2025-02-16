import { Controller, Delete, Get, HttpCode, Param, NotFoundException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import type { Session } from "@/lib/db/schema";
import {
  CurrentUser,
  type AuthenticatedRequest,
} from "@/modules/auth/decorators/auth.decorators";
import { Req } from "@nestjs/common";
import { SessionService } from "@/modules/auth/session.service";

@ApiTags("sessions")
@Controller("auth/sessions")
export class SessionsController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  @ApiOperation({ summary: "List active sessions for the current user" })
  async list(
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user?: { id: string },
  ) {
    const rows = await this.sessions.listActive(user!.id);
    return {
      data: rows.map((s) => serializeSession(s, s.id === req.sessionId)),
    };
  }

  @HttpCode(200)
  @Delete("current/others")
  @ApiOperation({ summary: "Revoke every other session; keep this one" })
  async revokeOthers(@Req() req: AuthenticatedRequest) {
    const revoked = await this.sessions.revokeAllExceptForUser(
      req.user!.id,
      req.sessionId!,
    );
    return { data: { revoked } };
  }

  @HttpCode(200)
  @Delete(":sessionId")
  @ApiOperation({ summary: "Revoke a specific session" })
  async revokeOne(
    @Param("sessionId", new ZodValidationPipe(uuidParamSchema)) sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (sessionId === req.sessionId) {
      // Revoking the calling session via this endpoint is not allowed; use
      // POST /auth/logout so cookies are cleared properly.
      return { data: { revoked: false, self: true } };
    }
    const ok = await this.sessions.revokeOwned(sessionId, req.user!.id);
    if (!ok) {
      throw new NotFoundException({
        error: { code: "RESOURCE_NOT_FOUND", message: "Session not found" },
      });
    }
    return { data: { revoked: true } };
  }
}

function serializeSession(s: Session, isCurrent: boolean) {
  return {
    id: s.id,
    userAgent: s.userAgent ?? null,
    ip: s.ip ? maskIp(s.ip) : null,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    current: isCurrent,
  };
}

/** Trims the last octet/group so full client IPs are not exposed back to clients. */
function maskIp(ip: string): string {
  if (ip.includes(":")) {
    // IPv6: keep first 3 groups.
    const groups = ip.split(":").filter(Boolean);
    if (groups.length > 3) return `${groups.slice(0, 3).join(":")}::`;
    return ip;
  }
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  return ip;
}
