import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { getLogger } from "@/lib/logger";

/**
 * Emits one structured log line per completed request with duration and
 * outcome. Never logs bodies or headers (may contain secrets/email data).
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  private readonly logger = getLogger();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { id?: string; user?: { id?: string } }>();
    const res = http.getResponse<Response>();

    return next.handle().pipe(
      tap({
        next: () => {
          this.emit(req, res.statusCode, startedAt);
        },
        error: (err) => {
          const status =
            typeof err?.getStatus === "function"
              ? (err.getStatus() as number)
              : 500;
          this.emit(req, status, startedAt);
        },
      }),
    );
  }

  private emit(
    req: Request & { id?: string },
    status: number,
    startedAt: number,
  ): void {
    const payload = {
      context: "http",
      requestId: req.id,
      method: req.method,
      url: req.originalUrl ?? req.url,
      status,
      durationMs: Date.now() - startedAt,
    };
    if (status >= 500) {
      this.logger.error(payload, "request failed");
    } else if (status >= 400) {
      this.logger.warn(payload, "request rejected");
    } else {
      this.logger.info(payload, "request completed");
    }
  }
}
