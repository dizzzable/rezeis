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
 *     support-tickets detail 5 s, online-trend / activity-feed 30 s,
 *     webhooks / broadcast 10 s). All admin endpoints sit behind
 *     `AdminJwtAuthGuard` so login itself is the abuse vector — that
 *     uses the `strict` throttle below.
 *
 * Individual endpoints can override with @Throttle() decorator:
 *   - Login: 5 attempts per 60 s
 *   - Payments: 10 per 60 s
 *   - Imports: 3 per 60 s
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
      {
        name: 'strict',
        ttl: 60_000,
        limit: 5,
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
