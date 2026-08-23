import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { BlockedIpService } from '../../blocked-ips/services/blocked-ip.service';

/**
 * Login Guard — fail2ban-style brute force protection for the admin login
 * endpoint.
 *
 * Strategy
 *   - Every login attempt is logged to `admin_login_attempts`.
 *   - On each attempt, we look at the previous N failures from the same
 *     IP within the past `WINDOW_MINUTES`. If the count exceeds
 *     `MAX_FAILURES_PER_WINDOW`, the IP is auto-added to `blocked_ips`
 *     for `BLOCK_DURATION_MINUTES`.
 *   - We also rate-limit per-(login, ip): a single IP can fail at most
 *     `MAX_FAILURES_PER_LOGIN` times against a given login before getting
 *     blocked, regardless of the global per-IP threshold.
 *
 * What the window is, exactly
 *   Both lookups count EVERY failure inside `WINDOW_MINUTES`. A successful
 *   authentication does not reset, shorten, or otherwise affect them: no
 *   query in this file reads a `success: true` row.
 *
 *   This paragraph used to say the opposite — "successful authentications
 *   reset the per-IP failure counter (handled implicitly: the lookup is
 *   'failures since the last success', not all failures ever)". No such
 *   lookup was ever written. `test/login-guard-window-semantics.spec.ts`
 *   now holds the prose and the code together: the claim cannot come back
 *   into this comment without a success lookup arriving with it.
 *
 *   Before changing that, know what a reset would and would not buy. It
 *   would NOT fix the case operators actually hit, because the password step
 *   and the TOTP step draw on one shared per-(login, ip) budget:
 *   `AdminAuthService.loginAdmin()` records `reason: 'totp_required'` and
 *   `reason: 'totp_invalid'` as failures, and records `success: true` only
 *   after BOTH factors pass. So three mistyped passwords followed by two
 *   fumbled codes is five failures and a lockout for the rest of the window
 *   — even though the password was correct for the last two attempts, there
 *   is no success row in between to reset from. Separating the two budgets
 *   is a change in `AdminAuthService`, not here.
 *
 * Cleanup
 *   The `cleanupOldAttempts()` cron runs daily and trims rows older than
 *   30 days so the table doesn't grow unbounded.
 */
@Injectable()
export class LoginGuardService {
  private readonly logger = new Logger(LoginGuardService.name);

  // Configurable thresholds. Kept as constants for now; can be promoted to
  // settings (DB-backed) if operators need to tune them per-deployment.
  private readonly WINDOW_MINUTES = 15;
  private readonly MAX_FAILURES_PER_WINDOW = 10;
  private readonly MAX_FAILURES_PER_LOGIN = 5;
  private readonly BLOCK_DURATION_MINUTES = 30;
  private readonly RETENTION_DAYS = 30;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly blockedIpService: BlockedIpService,
  ) {}

  /**
   * Records a login attempt and, on enough failures, auto-blocks the IP.
   * Returns the action taken so callers can include it in the audit log.
   */
  public async recordAttempt(input: {
    readonly loginNormalized: string;
    readonly ipAddress: string;
    readonly success: boolean;
    readonly reason?: string | null;
    readonly userAgent?: string | null;
  }): Promise<{ readonly autoBlocked: boolean; readonly failureCount: number }> {
    await this.prismaService.adminLoginAttempt.create({
      data: {
        loginNormalized: input.loginNormalized,
        ipAddress: input.ipAddress,
        success: input.success,
        reason: input.reason ?? null,
        userAgent: input.userAgent ?? null,
      },
    });

    if (input.success) {
      return { autoBlocked: false, failureCount: 0 };
    }

    return this.evaluateAndBlock(input.loginNormalized, input.ipAddress);
  }

  /**
   * Returns `true` when the IP has too many recent failures and should be
   * rejected before we even consult the password store. The HTTP layer
   * surfaces this as `429 Too Many Requests`.
   *
   * Both counts are "failures in the last `WINDOW_MINUTES`" — not "failures
   * since the last success". See the class header for why the difference is
   * spelled out rather than assumed.
   */
  public async isRateLimited(ipAddress: string, loginNormalized: string): Promise<boolean> {
    const since = new Date(Date.now() - this.WINDOW_MINUTES * 60 * 1000);

    // Cheap path: per-IP failure count
    const ipFailures = await this.prismaService.adminLoginAttempt.count({
      where: {
        ipAddress,
        success: false,
        createdAt: { gte: since },
      },
    });
    if (ipFailures >= this.MAX_FAILURES_PER_WINDOW) return true;

    // Per-(login, ip) failure count
    if (loginNormalized.length > 0) {
      const loginFailures = await this.prismaService.adminLoginAttempt.count({
        where: {
          loginNormalized,
          ipAddress,
          success: false,
          createdAt: { gte: since },
        },
      });
      if (loginFailures >= this.MAX_FAILURES_PER_LOGIN) return true;
    }

    return false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async evaluateAndBlock(
    loginNormalized: string,
    ipAddress: string,
  ): Promise<{ readonly autoBlocked: boolean; readonly failureCount: number }> {
    const since = new Date(Date.now() - this.WINDOW_MINUTES * 60 * 1000);

    const failureCount = await this.prismaService.adminLoginAttempt.count({
      where: {
        ipAddress,
        success: false,
        createdAt: { gte: since },
      },
    });

    if (failureCount < this.MAX_FAILURES_PER_WINDOW) {
      return { autoBlocked: false, failureCount };
    }

    // Threshold crossed — block the IP. Idempotent: if already blocked,
    // BlockedIpService.create() throws ConflictException which we ignore.
    try {
      const expiresAt = new Date(Date.now() + this.BLOCK_DURATION_MINUTES * 60 * 1000);
      await this.blockedIpService.create({
        address: ipAddress,
        reason: `Auto-blocked: ${failureCount} failed login attempts in ${this.WINDOW_MINUTES}m (login=${loginNormalized || 'unknown'})`,
        source: 'login_guard',
        createdById: null,
        expiresAt,
      });
      this.logger.warn(
        `Login guard auto-blocked ${ipAddress} for ${this.BLOCK_DURATION_MINUTES} min ` +
          `(${failureCount} failures, target login: ${loginNormalized || 'unknown'})`,
      );
      return { autoBlocked: true, failureCount };
    } catch (err) {
      // Already in blocklist — that's fine, we've done our part.
      this.logger.debug(`Login guard couldn't block ${ipAddress}: ${(err as Error).message}`);
      return { autoBlocked: false, failureCount };
    }
  }

  /**
   * Daily cleanup — drops rows older than `RETENTION_DAYS` so the table
   * doesn't grow unbounded.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  public async cleanupOldAttempts(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const cutoff = new Date(Date.now() - this.RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prismaService.adminLoginAttempt.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} old admin_login_attempts rows`);
    }
  }
}
