import { Injectable, Logger } from '@nestjs/common';
import {
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { UserNotificationsService } from '../notifications/services/user-notifications.service';
import { PaymentsRenewalCheckoutService } from '../payments/services/payments-renewal-checkout.service';
import { SavedPaymentMethodService } from '../payments/services/saved-payment-method.service';

const BATCH_SIZE = 100;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Start charging this long before expiresAt. */
const AUTOPAY_WINDOW_MS = 5 * 60 * 1000;
/** Max off-session charge attempts per subscription expiry epoch. */
const MAX_AUTOPAY_ATTEMPTS = 3;
const IDEMPOTENCY_PREFIX = 'auto-renew:';

/**
 * Auto-renewal service — donor: altshop `src/services/auto_renew.py` +
 * scheduled Taskiq tasks.
 *
 * Responsibilities:
 *  1. Within T-5m of expiry: charge preferred saved method (autopay on), up to 3 attempts
 *  2. On success: renewal checkout fulfills → ACTIVE + extended expiresAt
 *  3. After 3 failed attempts (or no chargeable method past due): mark EXPIRED
 *  4. Create `UserNotificationEvent` rows for expiry warnings (3d, 1d)
 *
 * Attempt accounting is derived from transaction idempotency keys
 * `auto-renew:{subscriptionId}:{expiresAtMs}:a{n}` — no extra schema.
 */
@Injectable()
export class AutoRenewService {
  private readonly logger = new Logger(AutoRenewService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly userNotifications: UserNotificationsService,
    private readonly paymentsRenewalCheckoutService: PaymentsRenewalCheckoutService,
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
  ) {}

  /**
   * Charges subscriptions that enter the T-5m pre-expiry window via
   * off-session renewal checkout (saved method + YOOKASSA).
   */
  public async processAutopayCharges(): Promise<{
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
  }> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + AUTOPAY_WINDOW_MS);

    const candidates = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { gt: now, lte: windowEnd },
      },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
      },
      take: BATCH_SIZE,
      orderBy: { expiresAt: 'asc' },
    });

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const sub of candidates) {
      if (sub.expiresAt === null) {
        skipped += 1;
        continue;
      }

      const expiresAtMs = sub.expiresAt.getTime();
      const attemptState = await this.readAttemptState(sub.id, expiresAtMs);

      if (attemptState.completed) {
        skipped += 1;
        continue;
      }
      if (attemptState.pending) {
        skipped += 1;
        continue;
      }
      if (attemptState.usedAttempts >= MAX_AUTOPAY_ATTEMPTS) {
        skipped += 1;
        continue;
      }

      const method = await this.savedPaymentMethodService.findPreferredForCharge(sub.userId);
      if (method === null) {
        skipped += 1;
        continue;
      }

      const nextAttempt = attemptState.usedAttempts + 1;
      const idempotencyKey = buildAttemptIdempotencyKey(sub.id, expiresAtMs, nextAttempt);
      attempted += 1;

      try {
        const checkout = await this.paymentsRenewalCheckoutService.renewalCheckout({
          userId: sub.userId,
          subscriptionIds: [sub.id],
          gatewayType: method.gatewayType,
          channel: PurchaseChannel.WEB,
          savedPaymentMethodId: method.id,
          idempotencyKey,
        });

        if (checkout.transactionStatus === TransactionStatus.COMPLETED) {
          succeeded += 1;
          this.logger.log(
            `Autopay succeeded for subscription ${sub.id} (payment ${checkout.paymentId}, attempt ${nextAttempt})`,
          );
          continue;
        }

        if (checkout.transactionStatus === TransactionStatus.PENDING) {
          // Off-session may still settle via webhook/reconcile; do not burn
          // another attempt while a PENDING draft exists for this attempt key.
          if (checkout.checkoutUrl !== null) {
            // Needs user redirect (3DS) — treat as failed attempt for autopay.
            failed += 1;
            this.logger.warn(
              `Autopay needs redirect for subscription ${sub.id} (payment ${checkout.paymentId}, attempt ${nextAttempt}) — counting as failed`,
            );
            await this.markTransactionFailedIfStillPending(checkout.paymentId);
            continue;
          }
          skipped += 1;
          this.logger.log(
            `Autopay pending for subscription ${sub.id} (payment ${checkout.paymentId}, attempt ${nextAttempt})`,
          );
          continue;
        }

        failed += 1;
        this.logger.warn(
          `Autopay non-success for subscription ${sub.id}: status=${checkout.transactionStatus} attempt=${nextAttempt}`,
        );
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Autopay charge failed for subscription ${sub.id} attempt=${nextAttempt}: ${message}`,
        );
      }
    }

    if (attempted > 0 || succeeded > 0 || failed > 0) {
      this.logger.log(
        `Autopay cycle: attempted=${attempted} succeeded=${succeeded} failed=${failed} skipped=${skipped}`,
      );
    }

    return { attempted, succeeded, failed, skipped };
  }

  /**
   * Marks expired subscriptions as EXPIRED only when they are not still
   * eligible for further autopay retries (no method / 3 attempts exhausted /
   * still pending settle is allowed to wait until past due without method).
   */
  public async markExpiredSubscriptions(): Promise<number> {
    const now = new Date();
    const expired = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { lt: now, not: null },
      },
      select: { id: true, userId: true, expiresAt: true },
      take: BATCH_SIZE,
    });

    if (expired.length === 0) {
      return 0;
    }

    const idsToExpire: string[] = [];

    for (const sub of expired) {
      if (sub.expiresAt === null) {
        idsToExpire.push(sub.id);
        continue;
      }

      const expiresAtMs = sub.expiresAt.getTime();
      const attemptState = await this.readAttemptState(sub.id, expiresAtMs);

      // Successful renew should have already extended expiresAt; if COMPLETED
      // exists for this epoch, skip expire (race with fulfillment).
      if (attemptState.completed) {
        continue;
      }

      // Pending off-session charge still settling — give reconcile a chance.
      if (attemptState.pending) {
        continue;
      }

      const method = await this.savedPaymentMethodService.findPreferredForCharge(sub.userId);
      if (method !== null && attemptState.usedAttempts < MAX_AUTOPAY_ATTEMPTS) {
        // Still has retries left — leave ACTIVE so processAutopayCharges can
        // fire on next tick even if slightly past expiresAt (window closed for
        // pre-expiry, but past-due retries still allowed until max attempts).
        continue;
      }

      idsToExpire.push(sub.id);
    }

    // Past-due retry pass: charge if still under max attempts and ACTIVE past expiresAt.
    for (const sub of expired) {
      if (sub.expiresAt === null) {
        continue;
      }
      if (idsToExpire.includes(sub.id)) {
        continue;
      }
      const expiresAtMs = sub.expiresAt.getTime();
      const attemptState = await this.readAttemptState(sub.id, expiresAtMs);
      if (attemptState.completed || attemptState.pending) {
        continue;
      }
      if (attemptState.usedAttempts >= MAX_AUTOPAY_ATTEMPTS) {
        if (!idsToExpire.includes(sub.id)) {
          idsToExpire.push(sub.id);
        }
        continue;
      }

      const method = await this.savedPaymentMethodService.findPreferredForCharge(sub.userId);
      if (method === null) {
        if (!idsToExpire.includes(sub.id)) {
          idsToExpire.push(sub.id);
        }
        continue;
      }

      const nextAttempt = attemptState.usedAttempts + 1;
      const idempotencyKey = buildAttemptIdempotencyKey(sub.id, expiresAtMs, nextAttempt);
      try {
        const checkout = await this.paymentsRenewalCheckoutService.renewalCheckout({
          userId: sub.userId,
          subscriptionIds: [sub.id],
          gatewayType: method.gatewayType,
          channel: PurchaseChannel.WEB,
          savedPaymentMethodId: method.id,
          idempotencyKey,
        });
        if (checkout.transactionStatus === TransactionStatus.COMPLETED) {
          this.logger.log(
            `Past-due autopay succeeded for subscription ${sub.id} (payment ${checkout.paymentId})`,
          );
          continue;
        }
        if (
          checkout.transactionStatus === TransactionStatus.PENDING &&
          checkout.checkoutUrl === null
        ) {
          continue;
        }
        if (checkout.checkoutUrl !== null) {
          await this.markTransactionFailedIfStillPending(checkout.paymentId);
        }
        // Re-check attempts after this failure for expire eligibility next loop.
        const after = await this.readAttemptState(sub.id, expiresAtMs);
        if (!after.completed && !after.pending && after.usedAttempts >= MAX_AUTOPAY_ATTEMPTS) {
          idsToExpire.push(sub.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Past-due autopay failed for ${sub.id}: ${message}`);
        const after = await this.readAttemptState(sub.id, expiresAtMs);
        if (!after.completed && !after.pending && after.usedAttempts >= MAX_AUTOPAY_ATTEMPTS) {
          idsToExpire.push(sub.id);
        } else if (after.usedAttempts === 0) {
          // Charge threw before creating a tx — count as soft fail by creating
          // a FAILED marker is heavy; instead expire only when no method or max.
          // If throw left no row, usedAttempts stays same → may retry.
        }
      }
    }

    // Re-evaluate exhausted after past-due retries
    const uniqueIds = Array.from(new Set(idsToExpire));
    if (uniqueIds.length === 0) {
      return 0;
    }

    const result = await this.prismaService.subscription.updateMany({
      where: { id: { in: uniqueIds }, status: SubscriptionStatus.ACTIVE },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    this.logger.log(`Marked ${result.count} subscriptions as EXPIRED`);
    return result.count;
  }

  /**
   * Creates expiry warning notification events for subscriptions expiring
   * within the given horizon (e.g., 3 days, 1 day). Idempotent — skips
   * users who already have a recent notification of the same type.
   */
  public async createExpiryWarnings(input: {
    readonly daysAhead: number;
    readonly notificationType: string;
  }): Promise<number> {
    const now = new Date();
    const horizon = new Date(now.getTime() + input.daysAhead * ONE_DAY_MS);
    const windowStart = new Date(horizon.getTime() - 3 * 60 * 60 * 1000);
    const recentThreshold = new Date(now.getTime() - 20 * 60 * 60 * 1000);

    const expiringSoon = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { gt: windowStart, lt: horizon },
      },
      select: { id: true, userId: true, expiresAt: true, planSnapshot: true },
      take: 200,
    });

    if (expiringSoon.length === 0) {
      return 0;
    }

    const userIds = Array.from(new Set(expiringSoon.map((sub) => sub.userId)));
    const alreadyNotified = await this.prismaService.userNotificationEvent.findMany({
      where: {
        userId: { in: userIds },
        type: input.notificationType,
        createdAt: { gt: recentThreshold },
      },
      select: { userId: true },
    });
    const notifiedUserIds = new Set(alreadyNotified.map((event) => event.userId));

    let created = 0;
    for (const sub of expiringSoon) {
      if (notifiedUserIds.has(sub.userId)) {
        continue;
      }
      notifiedUserIds.add(sub.userId);

      const planName = readPlanName(sub.planSnapshot);
      await this.userNotifications.create({
        userId: sub.userId,
        type: input.notificationType,
        payload: {
          subscriptionId: sub.id,
          expiresAt: sub.expiresAt?.toISOString() ?? null,
          plan: planName,
          planName,
          daysLeft: input.daysAhead,
        },
      });
      created++;
    }

    if (created > 0) {
      this.logger.log(
        `Created ${created} "${input.notificationType}" notifications`,
      );
    }
    return created;
  }

  /**
   * Full cycle: pre-expiry autopay → mark expired (with past-due retries) → warnings.
   */
  public async runCycle(): Promise<{
    readonly expired: number;
    readonly warnings3d: number;
    readonly warnings1d: number;
    readonly autopayAttempted: number;
    readonly autopaySucceeded: number;
    readonly autopayFailed: number;
    readonly autopaySkipped: number;
  }> {
    const autopay = await this.processAutopayCharges();
    const expired = await this.markExpiredSubscriptions();
    const warnings3d = await this.createExpiryWarnings({
      daysAhead: 3,
      notificationType: 'expires_in_3_days',
    });
    const warnings1d = await this.createExpiryWarnings({
      daysAhead: 1,
      notificationType: 'expires_in_1_days',
    });
    return {
      expired,
      warnings3d,
      warnings1d,
      autopayAttempted: autopay.attempted,
      autopaySucceeded: autopay.succeeded,
      autopayFailed: autopay.failed,
      autopaySkipped: autopay.skipped,
    };
  }

  private async readAttemptState(
    subscriptionId: string,
    expiresAtMs: number,
  ): Promise<{
    readonly usedAttempts: number;
    readonly pending: boolean;
    readonly completed: boolean;
  }> {
    const prefix = `${IDEMPOTENCY_PREFIX}${subscriptionId}:${expiresAtMs}:`;
    const rows = await this.prismaService.transaction.findMany({
      where: {
        purchaseType: PurchaseType.RENEW,
        idempotencyKey: { startsWith: prefix },
      },
      select: {
        status: true,
        idempotencyKey: true,
        checkoutUrl: true,
        gatewayId: true,
      },
      take: MAX_AUTOPAY_ATTEMPTS + 2,
    });

    let usedAttempts = 0;
    let pending = false;
    let completed = false;

    for (const row of rows) {
      const key = row.idempotencyKey ?? '';
      const match = /:a(\d+)$/.exec(key);
      if (match !== null) {
        const n = Number.parseInt(match[1] ?? '0', 10);
        if (Number.isFinite(n) && n > usedAttempts) {
          usedAttempts = n;
        }
      } else if (key.startsWith(prefix)) {
        usedAttempts = Math.max(usedAttempts, 1);
      }

      if (row.status === TransactionStatus.COMPLETED) {
        completed = true;
      }
      if (row.status === TransactionStatus.PENDING) {
        // Redirect-required PENDING is not a live settle path for autopay.
        // Claim-prefix gatewayId (provider create that never finished) is also
        // not settleable — treat as non-pending so retries/expire can run.
        const isProviderClaim =
          typeof row.gatewayId === 'string' &&
          row.gatewayId.startsWith('__RENEWAL_PROVIDER_CREATE__:');
        if (row.checkoutUrl === null && !isProviderClaim) {
          pending = true;
        }
      }
    }

    return { usedAttempts, pending, completed };
  }

  private async markTransactionFailedIfStillPending(paymentId: string): Promise<void> {
    try {
      await this.prismaService.transaction.updateMany({
        where: {
          paymentId,
          status: TransactionStatus.PENDING,
        },
        data: {
          status: TransactionStatus.FAILED,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to mark redirect autopay as FAILED for ${paymentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function buildAttemptIdempotencyKey(
  subscriptionId: string,
  expiresAtMs: number,
  attempt: number,
): string {
  return `${IDEMPOTENCY_PREFIX}${subscriptionId}:${expiresAtMs}:a${attempt}`;
}

function readPlanName(snapshot: unknown): string {
  if (typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)) {
    const candidate = (snapshot as Record<string, unknown>).name;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return 'Unknown';
}
