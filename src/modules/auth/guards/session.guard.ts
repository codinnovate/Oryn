import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";
import { toPublicUser } from "@/modules/auth/auth.service";
import { IS_PUBLIC_KEY } from "@/modules/auth/decorators/auth.decorators";
import type { AuthenticatedRequest } from "@/modules/auth/decorators/auth.decorators";
import { SESSION_COOKIE_NAME } from "@/lib/http/cookies";
import { SessionService } from "@/modules/auth/session.service";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Authenticates requests via `Authorization: Bearer <token>` or the session
 * cookie. Enforces an origin check for cookie-authenticated state-changing
 * requests (CSRF defense in depth alongside SameSite=Lax).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token =
      extractBearerToken(request) ?? readSessionCookie(request.headers.cookie);

    if (!token) {
      throw ApiError.unauthorized();
    }

    const resolved = await this.sessions.resolve(token);
    if (!resolved) {
      throw ApiError.unauthorized("Invalid or expired session");
    }

    const via: "cookie" | "bearer" = extractBearerToken(request)
      ? "bearer"
      : "cookie";

    if (via === "cookie" && UNSAFE_METHODS.has(request.method)) {
      assertAllowedOrigin(request);
    }

    request.user = toPublicUser(resolved.user);
    request.sessionId = resolved.sessionId;
    request.authVia = via;
    return true;
  }
}

function extractBearerToken(request: AuthenticatedRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
}

function readSessionCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      const value = rest.join("=");
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Cookie-authenticated unsafe methods must present a same-origin Origin or
 * Referer. This blocks CSRF even if cookies are sent cross-site.
 */
export function assertAllowedOrigin(request: AuthenticatedRequest): void {
  const env = getEnv();
  const allowedHosts = new Set<string>();
  try {
    allowedHosts.add(new URL(env.APP_URL).host);
  } catch {
    // APP_URL invalid would have failed env validation already.
  }
  const forwardedHost = request.headers["x-forwarded-host"];
  if (typeof forwardedHost === "string") {
    allowedHosts.add(forwardedHost.split(",")[0]!.trim());
  }
  const hostHeader = request.headers.host;
  if (typeof hostHeader === "string") {
    allowedHosts.add(hostHeader);
  }

  const originHeader = request.headers.origin;
  const referer = request.headers.referer;
  let candidate: string | undefined;
  if (typeof originHeader === "string") {
    candidate = originHeader;
  } else if (typeof referer === "string") {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = undefined;
    }
  }

  if (!candidate) {
    throw ApiError.forbidden("Missing Origin header for cookie-authenticated mutation");
  }
  let originHost: string;
  try {
    originHost = new URL(candidate).host;
  } catch {
    throw ApiError.forbidden("Malformed Origin header");
  }
  if (!allowedHosts.has(originHost)) {
    throw ApiError.forbidden("Cross-origin request rejected");
  }
}
