import type { NestMiddleware } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * Assigns a request id to every request (honoring an inbound
 * `x-request-id` header) so errors and logs can be correlated.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-request-id"];
    const id =
      typeof inbound === "string" && inbound.length > 0 && inbound.length <= 128 && /^[\w.-]+$/.test(inbound)
        ? inbound
        : `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    (req as Request & { id: string }).id = id;
    res.setHeader("X-Request-Id", id);
    next();
  }
}
