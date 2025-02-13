import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Request } from "express";
import type { PublicUser } from "@/modules/auth/auth.service";

export const IS_PUBLIC_KEY = "oryn:isPublic";

/** Marks a route as not requiring authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthenticatedRequest extends Request {
  user?: PublicUser & { id: string };
  sessionId?: string;
  authVia?: "cookie" | "bearer";
}

/** Injects the authenticated user into a handler parameter. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
