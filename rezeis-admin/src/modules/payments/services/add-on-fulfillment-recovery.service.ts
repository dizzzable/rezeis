import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PurchaseType, Transaction, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { isAddOnTransaction } from './payment-subscription-mutation.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';

/**
 * Grace window before a captured-but-unfulfilled add-on transaction becomes a
 * recovery candidate. The live webhook reconciler pre-claims `fulfilledAt`
 * before provisioning and releases it (back to null) only on a pre-commit
 * failure, after which BullMQ retries the webhook. We wait past that live
 * retry horizon so the sweeper is a safety net, not a competitor: a row still
 * inside the window is assumed to be actively retried elsewhere.
 */
const RECOVERY_GRACE_MS = 15 * 60 * 1000;

/** Max rows re-driven per tick — keeps the sweep bounded under backlog. */
const MAX_PER_TICK = 100;

/**
 * AddOnFulfillmentRecoveryService (T-005d)
 * ────────────────────────────────────────
 * Closes the "money captured, nothing delivered" gap for add-on top-ups.
 *
 * A COMPLETED add-on {@link Transaction} whose `fulfilledAt` is still `null`
 * past the grace window is a stranded paid line: the payment was captured
 * (or a zero-price add-on was marked COMPLETED) but fulfillment never ran or
 * every prior attempt failed. This sweeper re-drives each one through the
 * exact same mechanism the live reconciler uses:
 *
 *   1. atomically CLAIM by flipping `fulfilledAt` null → now under a
 *      conditional `updateMany` (so a live reconciler racing the same row
 *      always wins — only the worker whose claim matched provisions);
 *   2. run {@link PaymentSubscriptionMutationService.applyCompletedTransaction}
 *      (idempotent: it re-stamps `fulfilledAt` in its own transaction and
 *      no-ops already-applied work);
 *   3. enqueue the freshly-created profile-sync job(s);
 *   4. on provisioning failure, RELEASE the claim (`fulfilledAt` → null) so a
 *      later tick or a late webhook can retry — never leaving the row worse
 *      than found.
 *
 * The recovery of one row never aborts the sweep of the others.
 */
@Injectable()
export class AddOnFulfillmentRecoveryService {
  private readonly logger = new Logger(AddOnFulfillmentRecoveryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'add-on-fulfillment-recovery' })
  public async sweep(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const { recovered, failed } = await this.recoverStrandedFulfillments();
    if (recovered > 0 || failed > 0) {
      this.logger.log(
        `Add-on fulfillment recovery: recovered ${recovered}, still-failing ${failed}`,
      );
    }
  }

  /**
   * Core sweep. Returns per-tick counters so the cron wrapper and tests can
   * observe outcomes without inspecting logs.
   */
  public async recoverStrandedFulfillments(): Promise<{
    readonly recovered: number;
    readonly failed: number;
  }> {
    const cutoff = new Date(Date.now() - RECOVERY_GRACE_MS);
    const candidates = await this.prismaService.transaction.findMany({
      where: {
        status: TransactionStatus.COMPLETED,
        fulfilledAt: null,
        // Add-on top-ups draft as ADDITIONAL; the precise add-on marker check
        // below filters out non-add-on ADDITIONAL purchases.
        purchaseType: PurchaseType.ADDITIONAL,
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_PER_TICK,
    });

    let recovered = 0;
    let failed = 0;
    for (const transaction of candidates) {
      if (!isAddOnTransaction(transaction as Transaction)) continue;
      const outcome = await this.recoverOne(transaction as Transaction);
      if (outcome === 'RECOVERED') recovered += 1;
      else if (outcome === 'FAILED') failed += 1;
      // 'SKIPPED' (lost the claim race) is neither.
    }
    return { recovered, failed };
  }

  private async recoverOne(
    transaction: Transaction,
  ): Promise<'RECOVERED' | 'FAILED' | 'SKIPPED'> {
    // Conditional claim — a live reconciler or a concurrent sweeper tick that
    // already flipped `fulfilledAt` makes count === 0, so we back off.
    const claim = await this.prismaService.transaction.updateMany({
      where: {
        id: transaction.id,
        status: TransactionStatus.COMPLETED,
        fulfilledAt: null,
      },
      data: { fulfilledAt: new Date() },
    });
    if (claim.count !== 1) return 'SKIPPED';

    // Fulfillment (limit raise / ledger + `fulfilledAt` re-stamp) is atomic in
    // applyCompletedTransaction's own transaction. Release the claim ONLY if
    // THAT throws (nothing committed) — never for a later enqueue failure,
    // which would re-run and DOUBLE-APPLY the non-idempotent legacy increment.
    let syncJobs;
    try {
      ({ syncJobs } =
        await this.paymentSubscriptionMutationService.applyCompletedTransaction(transaction));
    } catch (error: unknown) {
      // Provisioning failed before its own transaction committed. Release the
      // claim so a later tick / late webhook can retry instead of leaving the
      // payment stranded paid-but-undelivered with a spuriously-set flag.
      await this.prismaService.transaction
        .updateMany({
          where: { id: transaction.id, fulfilledAt: { not: null } },
          data: { fulfilledAt: null },
        })
        .catch(() => undefined);
      this.logger.error(
        `Add-on fulfillment recovery failed for transaction ${transaction.id} (payment ${transaction.paymentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'FAILED';
    }

    // Money work is committed. Enqueue is best-effort: a failure here must NOT
    // release the claim (the increment is already applied). The profile-sync
    // sweep re-enqueues any PENDING job, so a dropped enqueue self-heals.
    for (const syncJob of syncJobs) {
      await this.profileSyncQueueService.enqueue(syncJob.id).catch((error: unknown) => {
        this.logger.warn(
          `Recovered add-on ${transaction.id}: enqueue of sync job ${syncJob.id} failed (will be re-swept): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_FULFILLMENT_RECOVERED,
      'PAYMENT',
      'Восстановлено исполнение доп-опции (платёж был получен, но не применён)',
      {
        userId: transaction.userId,
        paymentId: transaction.paymentId,
        purchaseType: transaction.purchaseType,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        gatewayType: transaction.gatewayType,
      },
    );
    return 'RECOVERED';
  }
}
