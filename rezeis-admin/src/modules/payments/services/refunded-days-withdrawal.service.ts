import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus, type Transaction } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { RENEWAL_PRICED_BEFORE_UPGRADE_KEY } from '../../subscriptions/services/paid-remainder-conversion.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One subscription and the days the refunded payment bought for it. */
interface PaidLine {
  readonly subscriptionId: string;
  readonly days: number;
}

/** What became of one line. */
export interface WithdrawnLine {
  readonly subscriptionId: string;
  readonly days: number;
  readonly fromExpiresAt: string | null;
  readonly toExpiresAt: string | null;
  /** The subscription ended with the refund: the days left were fewer than the days refunded. */
  readonly ended: boolean;
  /** Queued periods the refund unsold (`SubscriptionTermService.cancelScheduledFromInTransaction`). */
  readonly canceledTermIds: readonly string[];
  /** Why nothing was taken off, when nothing was. */
  readonly skipped: string | null;
}

/** The answer `revokeRefundedSubscriptionBestEffort` folds into the reversal's audit. */
export interface DaysWithdrawalOutcome {
  /** Days were taken off at least one subscription. */
  readonly withdrawn: boolean;
  /** Something is left for an operator: a line that could not be undone mechanically. */
  readonly needsManualReview: boolean;
  readonly audit: Record<string, unknown>;
}

/** `gatewayData` key of the lines a refund took days off. */
export const REFUND_WITHDRAWN_DAYS_KEY = 'refundWithdrawnDays';

/**
 * «Снять купленные дни» — the owner's decision of 08.11.2026: money returned
 * for a renewal takes the days that renewal bought off the subscription; the
 * days paid for before stay. If the days left are fewer than the days
 * refunded, the subscription ends now.
 *
 * For a RENEW, and for a NEW purchase whose subscription other payments have
 * renewed since (expiring that one would take paid renewals with it). One
 * subscription, or each line of a combined renewal. A plan change is not undone
 * here: it changed more than the days.
 *
 * Per subscription, in one database transaction under the row lock: the end
 * moves back by the paid days; queued periods that would now start after the
 * end are cancelled (`cancelScheduledFromInTransaction`); the tail term and the
 * add-ons that end with the subscription follow the new end
 * (`alignTailToExpiryInTransaction`, the same step every writer of `expiresAt`
 * takes); and a profile-sync job carries the new end to Remnawave.
 *
 * Handed to an operator instead, untouched: a lifetime subscription, a
 * DISABLED one (an operator's ban outranks a refund), a renewal priced before
 * an upgrade (its money bought other days, `RENEWAL_PRICED_BEFORE_UPGRADE_KEY`),
 * a payment that does not say its days, and a queued period that carries an
 * add-on. A subscription already ended has nothing left to take.
 *
 * Never throws: the money side of the refund is done and stays done.
 */
@Injectable()
export class RefundedDaysWithdrawalService {
  private readonly logger = new Logger(RefundedDaysWithdrawalService.name);
  private readonly terms: SubscriptionTermService;

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly profileSyncQueue?: ProfileSyncQueueService,
    // `AddOnEntitlementsModule` exports it; the stateless fallback keeps specs built by hand working.
    @Optional() terms?: SubscriptionTermService,
  ) {
    this.terms = terms ?? new SubscriptionTermService();
  }

  public async withdraw(transaction: Transaction, now: Date = new Date()): Promise<DaysWithdrawalOutcome> {
    try {
      if (asRecord(transaction.gatewayData)?.[RENEWAL_PRICED_BEFORE_UPGRADE_KEY] !== undefined) {
        return manual({ refundRevocationSkippedReason: 'RENEWAL_PRICED_BEFORE_UPGRADE' });
      }
      const lines = await this.paidLines(transaction);
      if (lines === null) {
        return manual({ refundRevocationSkippedReason: 'PAID_DAYS_UNKNOWN' });
      }
      const results: WithdrawnLine[] = [];
      const syncJobIds: string[] = [];
      for (const line of lines) {
        const result = await this.withdrawLine(transaction.paymentId, line, now);
        results.push(result.line);
        if (result.syncJobId !== null) syncJobIds.push(result.syncJobId);
      }
      for (const jobId of syncJobIds) {
        await this.profileSyncQueue?.enqueue(jobId).catch((error: unknown) => {
          // The job row exists: the profile-sync sweep picks it up.
          this.logger.warn(`Refund sync enqueue failed for ${transaction.id} (sweep will recover): ${errorText(error)}`);
        });
      }
      const withdrawn = results.some((line) => line.skipped === null && line.days > 0);
      const needsManualReview = results.some((line) => line.skipped !== null && line.skipped !== 'ALREADY_ENDED');
      this.logger.warn(
        `Refunded transaction ${transaction.id}: ` +
          results
            .map((line) =>
              line.skipped === null
                ? `${line.days}d off ${line.subscriptionId} (${line.fromExpiresAt} → ${line.toExpiresAt})`
                : `${line.subscriptionId} left (${line.skipped})`,
            )
            .join('; '),
      );
      return {
        withdrawn,
        needsManualReview,
        audit: { [REFUND_WITHDRAWN_DAYS_KEY]: results as unknown as Prisma.JsonArray },
      };
    } catch (error: unknown) {
      this.logger.error(`Taking refunded days off for transaction ${transaction.id} failed: ${errorText(error)}`);
      return manual({ refundRevocationSkippedReason: 'DAYS_WITHDRAWAL_FAILED' });
    }
  }

  /**
   * The subscriptions the payment renewed and the days it bought each: the
   * applied lines of a combined renewal, else the payment's own subscription
   * and its `selectedDurationDays`. Null when the payment does not say.
   */
  private async paidLines(transaction: Transaction): Promise<PaidLine[] | null> {
    const items = await this.prismaService.transactionItem.findMany({
      where: { transactionId: transaction.id, appliedAt: { not: null } },
      select: { subscriptionId: true, durationDays: true },
      orderBy: { id: 'asc' },
    });
    if (items.length > 0) {
      return items.every((item) => isPositiveDays(item.durationDays))
        ? items.map((item) => ({ subscriptionId: item.subscriptionId, days: item.durationDays }))
        : null;
    }
    const days = asRecord(transaction.planSnapshot)?.['selectedDurationDays'];
    if (transaction.subscriptionId === null || !isPositiveDays(days)) return null;
    return [{ subscriptionId: transaction.subscriptionId, days }];
  }

  private async withdrawLine(
    paymentId: string,
    line: PaidLine,
    now: Date,
  ): Promise<{ readonly line: WithdrawnLine; readonly syncJobId: string | null }> {
    return this.prismaService.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; status: SubscriptionStatus; expiresAt: Date | null; remnawaveId: string | null }>
      >(Prisma.sql`
        SELECT "id", "status"::text AS "status", "expires_at" AS "expiresAt", "remnawave_id" AS "remnawaveId"
        FROM "subscriptions"
        WHERE "id" = ${line.subscriptionId}
        FOR UPDATE
      `);
      const subscription = locked[0];
      const untouched = (skipped: string): { readonly line: WithdrawnLine; readonly syncJobId: null } => ({
        line: {
          ...line,
          fromExpiresAt: subscription?.expiresAt?.toISOString() ?? null,
          toExpiresAt: subscription?.expiresAt?.toISOString() ?? null,
          ended: false,
          canceledTermIds: [],
          skipped,
        },
        syncJobId: null,
      });
      if (subscription === undefined || subscription.status === SubscriptionStatus.DELETED) {
        return untouched('ALREADY_ENDED');
      }
      if (subscription.status === SubscriptionStatus.DISABLED) return untouched('SUBSCRIPTION_DISABLED');
      if (subscription.expiresAt === null) return untouched('LIFETIME');
      if (subscription.expiresAt.getTime() <= now.getTime()) return untouched('ALREADY_ENDED');

      const newEnd = new Date(subscription.expiresAt.getTime() - line.days * DAY_MS);
      const ended = newEnd.getTime() <= now.getTime();
      const toExpiresAt = ended ? now : newEnd;
      const queued = await this.terms.cancelScheduledFromInTransaction(tx, {
        subscriptionId: subscription.id,
        newEnd: toExpiresAt,
        now,
      });
      if (queued.outcome === 'ADD_ONS_BLOCK') return untouched('QUEUED_PERIOD_HAS_ADD_ONS');

      await tx.subscription.update({
        where: { id: subscription.id },
        data: { expiresAt: toExpiresAt, ...(ended ? { status: SubscriptionStatus.EXPIRED } : {}) },
      });
      await this.terms.alignTailToExpiryInTransaction(tx, subscription.id, { correlationId: `refund:${paymentId}` });
      const job =
        subscription.remnawaveId === null
          ? null
          : await tx.profileSyncJob.create({
              data: {
                subscriptionId: subscription.id,
                action: SyncAction.UPDATE,
                status: SyncJobStatus.PENDING,
                // No `propagateStatus`, as the revocation of a NEW purchase: the
                // new `expireAt` is what cuts the days, or the access.
                payload: { source: 'PAYMENT_REFUND', paymentId } as Prisma.InputJsonObject,
              },
              select: { id: true },
            });
      return {
        line: {
          ...line,
          fromExpiresAt: subscription.expiresAt.toISOString(),
          toExpiresAt: toExpiresAt.toISOString(),
          ended,
          canceledTermIds: queued.termIds,
          skipped: null,
        },
        syncJobId: job?.id ?? null,
      };
    });
  }
}

function manual(audit: Record<string, unknown>): DaysWithdrawalOutcome {
  return { withdrawn: false, needsManualReview: true, audit };
}

function isPositiveDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
