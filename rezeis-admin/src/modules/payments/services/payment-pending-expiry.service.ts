import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';

/**
 * Time a checkout may sit in `PENDING` before it is auto-cancelled. Provider
 * checkout links expire well within this window, so a transaction still
 * pending after it was almost certainly abandoned (the user closed the page,
 * the link expired, the webhook never arrived). Hardcoded by product decision
 * — not env-configurable.
 */
const PENDING_TTL_MS = 30 * 60 * 1000;

/** Max rows transitioned per tick — keeps the sweep bounded under backlog. */
const MAX_PER_TICK = 200;

/**
 * PaymentPendingExpiryService
 * ───────────────────────────
 * Sweeps stale `PENDING` transactions and marks them `CANCELED` so they don't
 * hang "В ожидании" forever. Only `PENDING` rows are touched (fulfillment only
 * happens on `COMPLETED`, so cancelling a pending row has no side effects), and
 * the transition is guarded by `updateMany ... where status = PENDING` so a
 * concurrent webhook always wins the race.
 *
 * Late payments are NOT lost: if a provider webhook reporting SUCCESS arrives
 * after cancellation, `PaymentReconciliationService` revives the transaction
 * to `COMPLETED` and runs fulfillment (see its terminal guard).
 */
@Injectable()
export class PaymentPendingExpiryService {
  private readonly logger = new Logger(PaymentPendingExpiryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'payment-pending-expiry' })
  public async expireStalePending(): Promise<void> {
    if (!shouldRunSchedules()) return;

    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const stale = await this.prismaService.transaction.findMany({
      where: { status: TransactionStatus.PENDING, createdAt: { lt: cutoff } },
      select: {
        id: true,
        paymentId: true,
        userId: true,
        purchaseType: true,
        gatewayType: true,
        amount: true,
        currency: true,
      },
      take: MAX_PER_TICK,
    });
    if (stale.length === 0) return;

    let cancelled = 0;
    for (const tx of stale) {
      // Race guard: only cancel if still PENDING — a webhook that completed it
      // between the read and now must not be overwritten.
      const result = await this.prismaService.transaction.updateMany({
        where: { id: tx.id, status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.CANCELED },
      });
      if (result.count === 0) continue;
      cancelled += 1;
      // INFO (not WARNING) and intentionally NOT mapped to admin push — an
      // abandoned-cart expiry is routine and would be noisy. It still lands in
      // the audit log + realtime feed.
      this.systemEvents.info(
        EVENT_TYPES.PAYMENT_EXPIRED,
        'PAYMENT',
        `Платёж истёк по таймауту (${PENDING_TTL_MS / 60000} мин): ${tx.purchaseType}`,
        {
          userId: tx.userId,
          paymentId: tx.paymentId,
          gatewayType: tx.gatewayType,
          amount: tx.amount.toString(),
          currency: tx.currency,
        },
      );
    }

    if (cancelled > 0) {
      this.logger.log(`Payment expiry: cancelled ${cancelled} stale PENDING transaction(s)`);
    }
  }
}
