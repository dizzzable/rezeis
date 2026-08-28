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
import { SubscriptionNoticePayloadService } from '../remnawave/services/subscription-notice-payload.service';

/**
 * One tick's worth of expiry warnings. Larger than the expired batch because a
 * warning window is entered by every ACTIVE subscription approaching its date,
 * while the expired one is entered only as a subscription lapses.
 */
const WARNING_BATCH_SIZE = 200;

const BATCH_SIZE = 100;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Start charging this long before expiresAt. */
const AUTOPAY_WINDOW_MS = 5 * 60 * 1000;
/** Max off-session charge attempts per subscription expiry epoch. */
const MAX_AUTOPAY_ATTEMPTS = 3;
const IDEMPOTENCY_PREFIX = 'auto-renew:';
/**
 * How far back an expiry notice looks from its mark.
 *
 * Three hours, the same span the warnings use ahead of theirs. It has to be
 * comfortably wider than the cron interval so nothing slips between ticks, and
 * narrow enough that a subscription which ended long ago never re-enters the
 * window when the 20-hour throttle ages out.
 */
const EXPIRY_NOTICE_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Everything an expiry notice needs from the row.
 *
 * Borrowed from the payload builder rather than restated: the columns a
 * notice prints are decided there, and a local copy would silently stop
 * selecting a field the builder started reading.
 */
const EXPIRY_NOTICE_SELECT = SubscriptionNoticePayloadService.SELECT;

/**
 * Auto-renewal service — donor: altshop `src/services/auto_renew.py` +
 * scheduled Taskiq tasks.
 *
 * Responsibilities:
 *  1. Within T-5m of expiry: charge preferred saved method (autopay on), up to 3 attempts
 *  2. On SUCCESS: never extend here — webhook reconcile → applyCompletedTransaction
 *     (create may return IMMEDIATE/succeeded; sub stays unextended until callback)
 *  3. After 3 failed attempts (or no chargeable method past due): mark EXPIRED
 *  4. Create `UserNotificationEvent` rows for expiry warnings (3d, 1d)
 *
 * This service never writes expiresAt. COMPLETED is only counted as autopay
 * success / skip-expire; paid extension runs via webhook → reconciliation →
 * PaymentSubscriptionMutationService.applyCompletedTransaction.
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
    /**
     * Assembles the facts a notice prints. Shared with the panel webhook, so
     * a limit notice and an expiry notice describe the same subscription in
     * the same words.
     */
    private readonly noticePayload: SubscriptionNoticePayloadService,
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
        // A blocked owner is excluded HERE rather than refused downstream.
        //
        // This is the one payment path with no session and no screen in front
        // of it: the scheduler reads the table and charges a saved card. Until
        // this line existed, blocking an account stopped their VPN and kept
        // charging them for it every renewal — which is worse than a hole, it
        // is taking money for a service we are deliberately refusing.
        //
        // Filtered in the query so the charge is never ATTEMPTED. A refusal
        // thrown later would still count as a failed autopay attempt against
        // the retry budget and would still notify the customer about a payment
        // problem they cannot act on.
        user: { isBlocked: false },
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
          // Even redirect-required (3DS) charges must stay PENDING so a late
          // SUCCESS webhook can still fulfill — mark FAILED only after the
          // provider cancels/expires the payment.
          skipped += 1;
          this.logger.log(
            checkout.checkoutUrl !== null
              ? `Autopay waiting for user confirmation (3DS/redirect) for subscription ${sub.id} (payment ${checkout.paymentId}, attempt ${nextAttempt})`
              : `Autopay pending for subscription ${sub.id} (payment ${checkout.paymentId}, attempt ${nextAttempt})`,
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
        if (checkout.transactionStatus === TransactionStatus.PENDING) {
          // Keep PENDING (including 3DS/redirect) so webhook fulfillment can
          // still succeed; do not force-fail and free the attempt slot.
          continue;
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
  /**
   * Runs one notification family, and contains its failure to itself.
   *
   * Answers `0` on a throw — the same value the family reports when it had
   * nothing to send. Those are genuinely different facts, which is why the
   * failure is logged at ERROR with the family named: the cycle result feeds an
   * operator summary, and a family that crashed must be findable there rather
   * than blending into a quiet night.
   *
   * What it must NOT do is rethrow. The five families run in sequence, and a
   * single unusable row — a `userId` whose `User` was deleted between the read
   * and the insert, a serialization failure — would otherwise take every family
   * after it down with it, on every tick, for as long as that row sat inside
   * its window.
   */
  private async runEmitter(family: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.logger.error(
        `Notification family '${family}' failed this cycle and was skipped; the others ran: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }

  /**
   * The customers already told about this notification type inside the throttle
   * window.
   *
   * READ FIRST AND EXCLUDED IN THE QUERY, which is the whole point. Both
   * emitters used to take a batch and then drop the already-notified rows in
   * memory — so once the batch was full of customers who had all been told, the
   * same batch came back every tick and the ones behind it were never reached.
   *
   * That is not a delay, it is a permanent miss: a subscription only sits in
   * its window for three hours, and the rows the ordering put last are the ones
   * closest to falling out of it. More than a batch of expiries inside one
   * window and the oldest simply never heard from us, with nothing logged —
   * `created` was 0, which reads exactly like a quiet night.
   */
  private async recentlyNotifiedUserIds(
    notificationType: string,
    since: Date,
  ): Promise<readonly string[]> {
    const rows = await this.prismaService.userNotificationEvent.findMany({
      where: { type: notificationType, createdAt: { gt: since } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((row) => row.userId);
  }

  public async createExpiryWarnings(input: {
    readonly daysAhead: number;
    readonly notificationType: string;
  }): Promise<number> {
    const now = new Date();
    const horizon = new Date(now.getTime() + input.daysAhead * ONE_DAY_MS);
    const windowStart = new Date(horizon.getTime() - 3 * 60 * 60 * 1000);
    const recentThreshold = new Date(now.getTime() - 20 * 60 * 60 * 1000);

    const alreadyNotifiedIds = await this.recentlyNotifiedUserIds(
      input.notificationType,
      recentThreshold,
    );

    const expiringSoon = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { gt: windowStart, lt: horizon },
        // Excluded HERE, not after the take — see `recentlyNotifiedUserIds`.
        ...(alreadyNotifiedIds.length > 0
          ? { userId: { notIn: [...alreadyNotifiedIds] } }
          : {}),
      },
      select: EXPIRY_NOTICE_SELECT,
      // Soonest first. The batch is a bound on one tick's work, so whatever it
      // cannot reach waits for the next one — and the row nearest its deadline
      // is the one that must not wait.
      orderBy: { expiresAt: 'asc' },
      take: WARNING_BATCH_SIZE,
    });

    if (expiringSoon.length === 0) {
      return 0;
    }
    if (expiringSoon.length === WARNING_BATCH_SIZE) {
      this.logger.log(
        `"${input.notificationType}": the batch was full, so more subscriptions are waiting ` +
          'in this window and will be picked up by the following ticks.',
      );
    }

    const notifiedUserIds = new Set<string>(alreadyNotifiedIds);

    let created = 0;
    for (const sub of expiringSoon) {
      if (notifiedUserIds.has(sub.userId)) {
        continue;
      }
      notifiedUserIds.add(sub.userId);

      await this.userNotifications.create({
        userId: sub.userId,
        type: input.notificationType,
        payload: await this.noticePayload.build(sub, { daysLeft: input.daysAhead }),
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
   * Notifies about a subscription that has ALREADY ended.
   *
   * ── Why this did not exist ────────────────────────────────────────────
   *
   * The catalog has shipped `expired` and `expired_1_day_ago` templates since
   * the bot-map module landed — editable, toggleable, with their own buttons,
   * and wired into the notification target resolver. Nothing ever created
   * one. An operator could write the copy, switch it on, and no customer
   * would ever receive it; the only expiry notices in the product were the
   * two warnings that fire BEFORE the fact.
   *
   * ── The window, and why it is not just `status = EXPIRED` ─────────────
   *
   * A bare status filter would re-notify every expired subscription forever,
   * throttled only by the 20-hour guard below — so a customer who left a year
   * ago would get a fresh reminder a year later, whenever the guard aged out.
   * The window bounds it to subscriptions that crossed the mark recently,
   * exactly as the warnings bound themselves to ones approaching it.
   *
   * A renewal moves `expiresAt` forward and puts the row back to ACTIVE, so a
   * customer who paid never falls into either arm.
   */
  public async createExpiredNotices(input: {
    readonly daysAgo: number;
    readonly notificationType: string;
  }): Promise<number> {
    const now = new Date();
    const mark = new Date(now.getTime() - input.daysAgo * ONE_DAY_MS);
    const windowStart = new Date(mark.getTime() - EXPIRY_NOTICE_WINDOW_MS);
    const recentThreshold = new Date(now.getTime() - 20 * 60 * 60 * 1000);

    const alreadyNotifiedIds = await this.recentlyNotifiedUserIds(
      input.notificationType,
      recentThreshold,
    );

    const justEnded = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.EXPIRED,
        expiresAt: { gt: windowStart, lte: mark },
        // Excluded HERE, not after the take — see `recentlyNotifiedUserIds`.
        ...(alreadyNotifiedIds.length > 0
          ? { userId: { notIn: [...alreadyNotifiedIds] } }
          : {}),
      },
      select: EXPIRY_NOTICE_SELECT,
      take: BATCH_SIZE,
      // OLDEST first, which is the reverse of what this used to do. The window
      // is three hours wide and the oldest rows leave it first, so serving the
      // newest meant the ones about to become unreachable were served last.
      orderBy: { expiresAt: 'asc' },
    });
    if (justEnded.length === 0) return 0;
    if (justEnded.length === BATCH_SIZE) {
      this.logger.log(
        `"${input.notificationType}": the batch was full, so more subscriptions are waiting ` +
          'in this window and will be picked up by the following ticks.',
      );
    }

    const notifiedUserIds = new Set<string>(alreadyNotifiedIds);

    let created = 0;
    for (const sub of justEnded) {
      if (notifiedUserIds.has(sub.userId)) continue;
      notifiedUserIds.add(sub.userId);
      await this.userNotifications.create({
        userId: sub.userId,
        type: input.notificationType,
        payload: await this.noticePayload.build(sub, { daysLeft: 0 }),
      });
      created++;
    }
    if (created > 0) {
      this.logger.log(`Created ${created} "${input.notificationType}" notifications`);
    }
    return created;
  }

  /**
   * Full cycle: pre-expiry autopay → mark expired (with past-due retries) → warnings.
   */
  public async runCycle(): Promise<{
    readonly expired: number;
    readonly warnings3d: number;
    readonly warnings2d: number;
    readonly warnings1d: number;
    readonly expiredNotices: number;
    readonly expiredYesterdayNotices: number;
    readonly autopayAttempted: number;
    readonly autopaySucceeded: number;
    readonly autopayFailed: number;
    readonly autopaySkipped: number;
  }> {
    const autopay = await this.processAutopayCharges();
    const expired = await this.markExpiredSubscriptions();
    // EACH FAMILY IS ISOLATED, and that is not defensive dressing — it is the
    // difference between one customer's notice failing and five families going
    // silent.
    //
    // These five ran as a bare `await` chain. Any throw inside one — a userId
    // whose `User` row was deleted between the read and the insert (the FK
    // cascades, so the race is real), a serialization failure, a rejected JSON
    // payload — propagated out of `runCycle` and every family AFTER it was
    // skipped for that tick. `createExpiredNotices` orders deterministically,
    // so the next tick stops on the same row: `expired` and `expired_1_day_ago`
    // would stay silent for as long as the poison row sat inside its window,
    // with a stack trace as the only symptom. The webhook path already got
    // this right; the cron did not.
    const warnings3d = await this.runEmitter('expires_in_3_days', () =>
      this.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' }),
    );
    // The two-day warning has had a template, a toggle and a place in the
    // target resolver since the catalog was written, and nothing ever created
    // one. Same for both arms below it.
    const warnings2d = await this.runEmitter('expires_in_2_days', () =>
      this.createExpiryWarnings({ daysAhead: 2, notificationType: 'expires_in_2_days' }),
    );
    const warnings1d = await this.runEmitter('expires_in_1_days', () =>
      this.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' }),
    );
    const expiredNotices = await this.runEmitter('expired', () =>
      this.createExpiredNotices({ daysAgo: 0, notificationType: 'expired' }),
    );
    const expiredYesterdayNotices = await this.runEmitter('expired_1_day_ago', () =>
      this.createExpiredNotices({ daysAgo: 1, notificationType: 'expired_1_day_ago' }),
    );
    return {
      expired,
      warnings3d,
      warnings2d,
      warnings1d,
      expiredNotices,
      expiredYesterdayNotices,
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
        // Any PENDING attempt (including 3DS redirect and lost-response claims)
        // blocks a new attempt for this expiry epoch until it settles or the
        // provider cancels it. Creating a2 would use a new provider key and
        // risk a double charge.
        pending = true;
      }
    }

    return { usedAttempts, pending, completed };
  }

  // Intentionally no force-fail helper for redirect/3DS: a PENDING charge must
  // stay open for webhook fulfillment. Provider cancel/expire is the only
  // terminal path that frees the attempt slot.
}

function buildAttemptIdempotencyKey(
  subscriptionId: string,
  expiresAtMs: number,
  attempt: number,
): string {
  return `${IDEMPOTENCY_PREFIX}${subscriptionId}:${expiresAtMs}:a${attempt}`;
}

