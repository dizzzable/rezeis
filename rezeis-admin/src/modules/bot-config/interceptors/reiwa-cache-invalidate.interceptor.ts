import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { ReiwaCacheInvalidatorService } from '../services/reiwa-cache-invalidator.service';

/**
 * ReiwaCacheInvalidateInterceptor
 * ───────────────────────────────
 * Wraps any controller method that mutates bot-config and pushes a
 * synchronous cache-bust to reiwa-bot after a successful response.
 *
 * Apply with `@UseInterceptors(ReiwaCacheInvalidateInterceptor)` on the
 * controller class to cover every route, or per-method for finer
 * control.
 *
 * The push is fire-and-forget — the Observable returned to NestJS
 * resolves with the original handler value before the HTTP call to
 * reiwa-bot completes, so the admin response latency is unaffected.
 *
 * On the failure paths:
 *   - Handler threw      → no invalidate (the underlying record wasn't
 *                          changed, no cache to bust)
 *   - Invalidate failed  → logged at warn; admin response is still 2xx
 *                          because the save did succeed
 */
@Injectable()
export class ReiwaCacheInvalidateInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ReiwaCacheInvalidateInterceptor.name);

  public constructor(private readonly invalidator: ReiwaCacheInvalidatorService) {}

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      route?: { path?: string };
      url?: string;
    }>();
    const method = (request.method ?? 'GET').toUpperCase();
    // Only mutations bust the cache. Read-only requests fall through.
    const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (!isMutation) return next.handle();
    const reason = `${method} ${request.route?.path ?? request.url ?? '?'}`;
    return next.handle().pipe(
      tap({
        next: () => {
          // Fire-and-forget: don't await, don't block the HTTP response.
          this.invalidator.invalidate(reason).catch((err: unknown) => {
            this.logger.warn(
              `invalidate threw post-handler: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        },
      }),
    );
  }
}
