import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

/**
 * Global rate limiting module.
 *
 * Default limits:
 *   - 600 requests per 60 seconds per IP (general API)
 *     Generous to accommodate the admin SPA's polling endpoints
 *     (dashboard summary 30 s, system-health 10 s, system-logs 2 s,
 *     support-tickets detail 5 s, activity-feed 30 s, the online card's
 *     online-overview / online-distribution 60 s,
 *     webhooks / broadcast 10 s). All admin endpoints sit behind
 *     `AdminJwtAuthGuard` so login itself is the abuse vector — that
 *     uses a much tighter per-endpoint override (see below).
 *
 * Individual endpoints can override with @Throttle() decorator on
 * the same `default` throttler namespace, e.g. login uses
 *   @Throttle({ default: { ttl: 60_000, limit: 5 } })
 *
 * Earlier versions defined a *separate* `strict` throttler at module
 * scope (5/60 s). Because `@nestjs/throttler` runs **every named
 * throttler** for every request unless explicitly skipped per-name,
 * that strict tier silently capped the entire API at 5/60 s — the
 * dashboard's 10 s `system-health` poll triggered 429s on every page
 * load. Lesson: prefer per-endpoint @Throttle overrides over named
 * tiers when only one endpoint needs the tighter budget.
 *
 * Pure read-only metric endpoints (dashboard summary / system-health /
 * client-error reporting) are decorated with @SkipThrottle() so they
 * never count against the budget.
 *
 * The guard is registered globally via APP_GUARD. Endpoints that should
 * be exempt (health checks, webhooks) use @SkipThrottle().
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 600,
      },
    ]),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class ThrottleModule {}
