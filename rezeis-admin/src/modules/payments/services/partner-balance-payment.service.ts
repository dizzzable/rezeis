import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGuard, AccessModeGate } from '../../settings/services/access-mode-guard.service';
import { assertPurchaserNotBlocked } from '../utils/blocked-purchaser.util';
import { SettingsService } from '../../settings/services/settings.service';
import { InternalPaymentCheckoutInterface } from '../interfaces/internal-payment-checkout.interface';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { PaymentsTransactionsService } from './payments-transactions.service';
import { releasePaidTrialClaim } from '../../subscriptions/services/trial-claim-ledger.util';

/**
 * Key under `Transaction.gatewayData` holding a balance restore we still owe a
 * partner. `gatewayData` is the row's ops scratchpad — `PaymentReconciliation`
 * already parks `paymentNeedsManualReview` there and the МойНалог processor its
 * receipt ids — and for a PARTNER_BALANCE row there is no provider payload to
 * collide with. Living on the transaction itself (rather than in a new table)
 * means the debt is written where the debit's own audit trail already is, and
 * needs no migration to survive a restart.
 */
const OWED_REFUND_KEY = 'partnerBalanceRefund';

/** `partnerBalanceRefund.state`: the increment has not been applied yet. */
const OWED_REFUND_STATE_OWED = 'OWED';

/** `partnerBalanceRefund.state`: the increment committed; nothing is owed. */
const OWED_REFUND_STATE_RESTORED = 'RESTORED';

/**
 * `partnerBalanceRefund.state`: the marker says a refund is owed but carries a
 * partner id or an amount nothing may be spent against, so no automated retry
 * can ever settle it. Terminal, and deliberately outside the `OWED` the sweep
 * selects on — see {@link PartnerBalancePaymentService.settleOwedBalanceRestore}.
 */
const OWED_REFUND_STATE_UNRESOLVABLE = 'UNRESOLVABLE';

/** Max owed restores re-driven per sweep tick — keeps the pass bounded. */
const MAX_REFUND_RECOVERY_PER_TICK = 100;

/** A balance restore that was attempted, failed, and is still outstanding. */
interface OwedBalanceRestore {
  readonly partnerId: string;
  readonly amountMinor: number;
  readonly releaseReason: string;
  readonly attempts: number;
}

/** Everything the compensating action needs to unwind — or to record — a debit. */
interface DebitCompensationContext {
  readonly partnerId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly transactionId: string;
  readonly paymentId: string;
  readonly currency: Currency;
  readonly releaseReason: string;
  /** Redacted message of the failure that made the debit worth unwinding. */
  readonly cause: string;
}

export interface PartnerBalancePaymentInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly purchaseType: PurchaseType;
  readonly planId: string;
  readonly durationDays: number;
  readonly subscriptionId?: string;
  readonly channel?: PurchaseChannel;
  readonly deviceType?: string;
}

/**
 * PartnerBalancePaymentService
 * ────────────────────────────
 * Lets an active partner pay for a subscription (NEW / ADDITIONAL / RENEW /
 * UPGRADE) with their accrued partner balance instead of an external gateway.
 *
 * Flow (mirrors the synchronous "free add-on" completion path):
 *   1. Gate by access mode + the `partnerSettings.allowBalancePayment` toggle.
 *   2. Price the purchase in the partner's balance currency via the shared
 *      quote/draft pipeline (`createDraft` with `currencyOverride`).
 *   3. Atomically debit the balance (guarded `updateMany`, so a concurrent
 *      attempt can't overspend).
 *   4. Fulfil the transaction through the standard mutation service and mark
 *      it COMPLETED.
 *
 * By design there is NO refund-to-balance on later cancellation — an operator
 * can adjust the balance and remove the subscription manually if needed. The
 * only rollback here is a defensive one when fulfillment itself fails (a
 * system error), so the partner is never debited for nothing.
 *
 * That rollback is a compensating action, and a compensating action can fail.
 * When it does the money is genuinely gone: the balance stays debited, the
 * partner has no subscription, and the fulfillment error the caller rethrows
 * says nothing about the refund. So the failure branch is durable rather than
 * silent — see {@link PartnerBalancePaymentService.restoreBalanceAndReleaseTrial}
 * and the {@link PartnerBalancePaymentService.recoverOwedBalanceRestores} sweep
 * that re-drives it.
 */
@Injectable()
export class PartnerBalancePaymentService {
  private readonly logger = new Logger(PartnerBalancePaymentService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
    private readonly paymentsTransactionsService: PaymentsTransactionsService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly events: SystemEventsService,
  ) {}

  public async pay(input: PartnerBalancePaymentInput): Promise<InternalPaymentCheckoutInterface> {
    const channel = input.channel ?? PurchaseChannel.WEB;

    // 1. Access-mode gate (same gates as a normal purchase of this type).
    const policy = await this.settingsService.getInternalPlatformPolicy();
    const rejection = this.accessModeGuard.evaluate({
      gate: mapPurchaseTypeToAccessGate(input.purchaseType),
      mode: policy.accessMode,
    });
    if (rejection !== null) {
      throw rejection.status === 503
        ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
        : new ForbiddenException({ code: rejection.code, message: rejection.message });
    }

    // 2. Resolve the canonical user + their balance currency.
    const user = await this.resolveUser(input);
    await assertPurchaserNotBlocked(this.prismaService, { userId: user.id });

    // 3. Operator toggle.
    const partnerSettings = await this.settingsService.getPartnerSettings();
    if (partnerSettings['allowBalancePayment'] !== true) {
      throw new ForbiddenException({
        code: 'PARTNER_BALANCE_DISABLED',
        message: 'Paying with partner balance is disabled.',
      });
    }

    // 4. Active partner record.
    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { id: true, isActive: true, balance: true },
    });
    if (partner === null || !partner.isActive) {
      throw new ForbiddenException({
        code: 'PARTNER_BALANCE_NOT_AVAILABLE',
        message: 'You are not an active partner.',
      });
    }

    // 5. Balance currency: per-user override → operator default.
    const balanceCurrency: Currency =
      user.partnerBalanceCurrencyOverride ?? (policy.defaultCurrency as Currency);

    // 6. Price the purchase in the balance currency (shared quote pipeline).
    //    Throws PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE when the plan has no price in
    //    that currency or the purchase isn't allowed.
    const draft = await this.paymentsTransactionsService.createCheckoutDraft({
      userId: user.id,
      purchaseType: input.purchaseType,
      planId: input.planId,
      durationDays: input.durationDays,
      gatewayType: PaymentGatewayType.PARTNER_BALANCE,
      sourceSubscriptionId: input.subscriptionId,
      channel,
      deviceType: input.deviceType,
      currencyOverride: balanceCurrency,
    });

    const amountMinor = toExactMinorUnits(draft.amount.toString());
    if (amountMinor === null) {
      await releasePaidTrialClaim(
        this.prismaService,
        draft.id,
        'PARTNER_BALANCE_INVALID_AMOUNT_PRE_DEBIT',
      );
      throw new BadRequestException('PARTNER_BALANCE_INVALID_AMOUNT');
    }
    if (partner.balance < amountMinor) {
      await releasePaidTrialClaim(
        this.prismaService,
        draft.id,
        'PARTNER_BALANCE_INSUFFICIENT_PRE_DEBIT',
      );
      throw new BadRequestException({
        code: 'INSUFFICIENT_PARTNER_BALANCE',
        message: 'Partner balance is insufficient for this purchase.',
      });
    }

    // 7. Read the draft row BEFORE the debit.
    //
    //    Nothing between `createCheckoutDraft` and here writes to it, so this
    //    read is order-independent — but the compensating action it used to
    //    guard was not. Reading it after the debit meant a missing row had to
    //    be unwound by restoring the balance, i.e. a whole class of "charged
    //    for nothing" existed only because of statement order. Moving the read
    //    up removes that call site rather than compensating for it: with no
    //    debit yet, releasing the trial reservation is the entire rollback.
    const transactionRow = await this.prismaService.transaction.findUnique({
      where: { id: draft.id },
    });
    if (transactionRow === null) {
      await releasePaidTrialClaim(
        this.prismaService,
        draft.id,
        'PARTNER_BALANCE_DRAFT_MISSING_PRE_DEBIT',
      );
      throw new NotFoundException('Transaction draft not found');
    }

    // 8. Atomic, guarded debit — a concurrent attempt with the same balance
    //    can't overspend (only one `balance >= amount` update wins). This must
    //    stay ahead of fulfillment: it is the guard that stops two concurrent
    //    purchases spending the same balance, and a debit-after-fulfilment
    //    would trade "partner charged for nothing" for "partner provisioned
    //    for free" while losing that guard.
    const debit = await this.prismaService.partner.updateMany({
      where: { id: partner.id, balance: { gte: amountMinor } },
      data: { balance: { decrement: amountMinor } },
    });
    if (debit.count === 0) {
      await releasePaidTrialClaim(
        this.prismaService,
        draft.id,
        'PARTNER_BALANCE_RACE_LOST_PRE_DEBIT',
      );
      throw new BadRequestException({
        code: 'INSUFFICIENT_PARTNER_BALANCE',
        message: 'Partner balance is insufficient for this purchase.',
      });
    }

    // 9. Fulfil + mark COMPLETED. If fulfillment throws (system error), refund
    //    the debit so the partner isn't charged for nothing.
    //
    // Post-fulfilment hooks are intentionally NOT run here: this is paid from a
    // partner's internal balance, not with new external money. Registering it as
    // МойНалог income would double-declare revenue that was already declared when
    // the customer paid, and paying partner commission on a balance spend would
    // recycle commission already earned. Whether such a purchase should count as
    // advertising revenue is a product decision, not a bug fix.
    let syncJobs;
    try {
      ({ syncJobs } =
        await this.paymentSubscriptionMutationService.applyCompletedTransaction(transactionRow));
    } catch (err: unknown) {
      const cause = describeFailure(err);
      this.logger.error(
        `Partner-balance payment fulfillment failed for user ${user.id}: ${cause}`,
      );
      // Rethrowing the fulfillment error is right — it is what the caller
      // asked about. It just says nothing about whether the refund landed, so
      // the compensating action reports its own failure through its own
      // channels rather than through this throw.
      await this.restoreBalanceAndReleaseTrial({
        partnerId: partner.id,
        userId: user.id,
        amountMinor,
        transactionId: draft.id,
        paymentId: draft.paymentId,
        currency: balanceCurrency,
        releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
        cause,
      });
      throw err;
    }
    // From here entitlement + paid-trial claim are durably committed. Never
    // restore balance after this boundary: a status/queue hiccup is recoverable,
    // while refunding would give the user a live subscription for free.
    for (const syncJob of syncJobs) {
      try {
        await this.profileSyncQueueService.enqueue(syncJob.id);
      } catch (err: unknown) {
        this.logger.warn(
          `Partner-balance sync enqueue failed for transaction ${draft.id} ` +
            `(sweep will recover): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.events.info(
      EVENT_TYPES.PARTNER_BALANCE_ADJUSTED,
      'PARTNER',
      `Partner paid ${draft.amount} ${balanceCurrency} from balance`,
      { userId: user.id, amountMinor, purchaseType: input.purchaseType, paymentId: draft.paymentId },
    );

    const finalTransaction =
      (await this.prismaService.transaction.findUnique({ where: { id: draft.id } })) ?? transactionRow;
    return {
      paymentId: finalTransaction.paymentId,
      transactionStatus: finalTransaction.status,
      gatewayType: finalTransaction.gatewayType,
      purchaseType: finalTransaction.purchaseType,
      amount: finalTransaction.amount.toString(),
      currency: finalTransaction.currency,
      checkoutUrl: null,
      providerMode: 'NONE',
      createdAt: finalTransaction.createdAt.toISOString(),
    };
  }

  /**
   * Compensating action for a debit whose fulfillment failed.
   *
   * The restore itself is unchanged: one transaction, balance increment plus
   * the trial-claim release, all-or-nothing. What changed is the failure
   * branch. It used to be `catch { return false; }` into two callers that
   * `await`ed the boolean and discarded it, so a compensation that threw left
   * the partner short with the fulfillment error as the only trace — an error
   * about a different thing entirely. A failed compensation now leaves:
   *
   *   * `gatewayData.partnerBalanceRefund = { state: 'OWED', … }` on the row
   *     that was paid for. It survives a restart and is what
   *     {@link recoverOwedBalanceRestores} re-drives every five minutes, so
   *     the money comes back without a human if the fault was transient;
   *   * `paymentNeedsManualReview`, the flag `PaymentPendingExpiryService`
   *     already honours, so a purchase the partner actually paid for is not
   *     filed as an abandoned cart while the debt is open;
   *   * `PARTNER_BALANCE_REFUND_FAILED` at ERROR, naming the partner, the
   *     amount and the original failure. An operator can refund by hand, but
   *     only if they are told — and `emit` persists to `AdminAuditLog` through
   *     a path independent of the row write above, so one channel failing does
   *     not take the other with it.
   *
   * Returns whether the balance is back. The caller still rethrows the
   * fulfillment error either way; nothing here depends on it reading this.
   */
  private async restoreBalanceAndReleaseTrial(
    context: DebitCompensationContext,
  ): Promise<boolean> {
    const attemptedAt = new Date().toISOString();
    try {
      await this.prismaService.$transaction(async (tx) => {
        // The outcome marker rides the increment, exactly as the sweep's
        // conditional claim does — and for the same reason. A bare increment
        // leaves nothing behind that distinguishes "the transaction rolled
        // back" from "it committed and the connection died before the
        // acknowledgement arrived": the client throws the identical error for
        // both. The failure branch then records a debt the sweep pays again
        // five minutes later, so a partner who is already whole is credited
        // twice and nothing anywhere records the extra money.
        //
        // Written inside the transaction, the marker is not bookkeeping — it
        // is the evidence. Either both land or neither does, so the row itself
        // answers the question the thrown error cannot.
        const current = await tx.transaction.findUnique({
          where: { id: context.transactionId },
          select: { gatewayData: true },
        });
        await tx.transaction.update({
          where: { id: context.transactionId },
          data: {
            gatewayData: mergeGatewayData(current?.gatewayData ?? null, {
              [OWED_REFUND_KEY]: {
                state: OWED_REFUND_STATE_RESTORED,
                partnerId: context.partnerId,
                amountMinor: context.amountMinor,
                releaseReason: context.releaseReason,
                currency: context.currency,
                cause: context.cause,
                attempts: 1,
                lastAttemptAt: attemptedAt,
                restoredAt: attemptedAt,
              },
            }) as Prisma.InputJsonValue,
          },
        });
        await tx.partner.update({
          where: { id: context.partnerId },
          data: { balance: { increment: context.amountMinor } },
        });
        await releasePaidTrialClaim(tx, context.transactionId, context.releaseReason);
      });
      return true;
    } catch (restoreError: unknown) {
      return await this.recordOwedBalanceRestore(context, describeFailure(restoreError));
    }
  }

  /**
   * Writes the debt down and tells an operator. Never throws: it is the last
   * stop on a path that is already unwinding a failure, and the caller has a
   * fulfillment error of its own to rethrow.
   *
   * Returns whether the balance is in fact already back — see the lost-ACK
   * check below, which is the one way out of here that is not a debt.
   */
  private async recordOwedBalanceRestore(
    context: DebitCompensationContext,
    failure: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    let durablyRecorded = false;
    try {
      const current = await this.prismaService.transaction.findUnique({
        where: { id: context.transactionId },
        select: { gatewayData: true },
      });
      // This read, not the thrown error, is what says whether the money moved:
      // the restore writes its RESTORED marker inside the same transaction as
      // the increment, so a row that carries one is a row whose increment
      // committed. Filing a debt on top of it is how a lost commit
      // acknowledgement becomes a second, unearned refund on the next sweep.
      //
      // Reusing this call's own read closes the window a separate probe would
      // open: there is no moment between "we checked" and "we wrote".
      if (balanceRestoreIsSettled(current?.gatewayData ?? null)) {
        this.logger.warn(
          `Partner-balance refund of ${context.amountMinor} to partner ${context.partnerId} ` +
            `reported "${failure}", but transaction ${context.transactionId} records it as ` +
            'committed — the acknowledgement was lost, not the money; no debt recorded',
        );
        return true;
      }
      await this.prismaService.transaction.update({
        where: { id: context.transactionId },
        data: {
          gatewayData: mergeGatewayData(current?.gatewayData ?? null, {
            [OWED_REFUND_KEY]: {
              state: OWED_REFUND_STATE_OWED,
              partnerId: context.partnerId,
              amountMinor: context.amountMinor,
              releaseReason: context.releaseReason,
              currency: context.currency,
              cause: context.cause,
              failure,
              attempts: 1,
              firstFailedAt: now,
              lastAttemptAt: now,
            },
            paymentNeedsManualReview: true,
          }) as Prisma.InputJsonValue,
        },
      });
      durablyRecorded = true;
    } catch (writeError: unknown) {
      this.logger.error(
        `Partner-balance refund of ${context.amountMinor} to partner ${context.partnerId} ` +
          `failed AND could not be recorded on transaction ${context.transactionId}: ` +
          `${describeFailure(writeError)}`,
      );
    }

    // Emitted whether or not the row write landed — if it did not, the audit
    // log entry this produces is the only record that the money is owed.
    this.events.error(
      EVENT_TYPES.PARTNER_BALANCE_REFUND_FAILED,
      'PARTNER',
      `Не удалось вернуть ${context.amountMinor} (мин. ед.) ${context.currency} на баланс ` +
        `партнёра ${context.partnerId} после сбоя выдачи — требуется ручной возврат`,
      {
        userId: context.userId,
        partnerId: context.partnerId,
        amountMinor: context.amountMinor,
        currency: context.currency,
        paymentId: context.paymentId,
        transactionId: context.transactionId,
        releaseReason: context.releaseReason,
        cause: context.cause,
        failure,
        durablyRecorded,
      },
    );
    this.logger.error(
      `Partner-balance refund of ${context.amountMinor} to partner ${context.partnerId} ` +
        `failed (transaction ${context.transactionId}, cause "${context.cause}"): ${failure}`,
    );
    return false;
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'partner-balance-refund-recovery' })
  public async sweepOwedBalanceRestores(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const { restored, stillOwed } = await this.recoverOwedBalanceRestores();
    if (restored > 0 || stillOwed > 0) {
      this.logger.log(
        `Partner-balance refund recovery: restored ${restored}, still owed ${stillOwed}`,
      );
    }
  }

  /**
   * Re-drives every balance restore still marked `OWED`.
   *
   * A one-shot compensation is only as good as the moment it ran: the failures
   * that break it — a dropped connection, a deadlock, a restart mid-unwind —
   * are exactly the ones that are gone a minute later. This is the same shape
   * as {@link AddOnFulfillmentRecoveryService}: an atomic conditional claim so
   * a concurrent tick can never increment twice, the real work behind it, and
   * a marker left untouched when the work throws so a later tick retries.
   *
   * Returns per-tick counters so the cron wrapper and tests can observe
   * outcomes without reading logs.
   */
  public async recoverOwedBalanceRestores(): Promise<{
    readonly restored: number;
    readonly stillOwed: number;
  }> {
    const owed = await this.prismaService.transaction.findMany({
      where: {
        gatewayType: PaymentGatewayType.PARTNER_BALANCE,
        gatewayData: {
          path: [OWED_REFUND_KEY, 'state'],
          equals: OWED_REFUND_STATE_OWED,
        },
      },
      select: { id: true, userId: true, paymentId: true, currency: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_REFUND_RECOVERY_PER_TICK,
    });

    let restored = 0;
    let stillOwed = 0;
    for (const row of owed) {
      const outcome = await this.settleOwedBalanceRestore(row);
      if (outcome === 'RESTORED') restored += 1;
      else if (outcome === 'STILL_OWED') stillOwed += 1;
      // 'SKIPPED' — settled by a concurrent tick, so there is nothing to
      // count. A marker nothing can be spent against is NOT skipped: it is
      // retired and counted as owed, because the money still has not moved.
    }
    return { restored, stillOwed };
  }

  private async settleOwedBalanceRestore(row: {
    readonly id: string;
    readonly userId: string;
    readonly paymentId: string;
    readonly currency: Currency;
  }): Promise<'RESTORED' | 'STILL_OWED' | 'SKIPPED'> {
    const now = new Date().toISOString();
    let settled: OwedBalanceRestore | null = null;
    let retiredUnusable = false;
    try {
      settled = await this.prismaService.$transaction(async (tx) => {
        // Re-read inside the transaction: the candidate list is a snapshot,
        // never authoritative. Everything below is decided on this row.
        const current = await tx.transaction.findUnique({
          where: { id: row.id },
          select: { gatewayData: true },
        });
        const debt = readOwedBalanceRestore(current?.gatewayData ?? null);
        if (debt === null) {
          // Two very different nulls hide behind one `return`. A marker that is
          // gone, or already RESTORED, is a genuine no-op: the row drops out of
          // the `OWED` scan by itself and nothing is starved.
          //
          // A marker that still says OWED but carries a partner id or an amount
          // nothing may be spent against is the other one, and it never
          // improves. Left as it is, it is re-selected every five minutes
          // forever while occupying one of the 100 slots in a `createdAt asc`
          // window — a hundred of them at the head of that window and no
          // genuinely owed refund created afterwards is ever reached, with
          // `{restored: 0, stillOwed: 0}` reported as health throughout.
          //
          // So it is retired to a terminal state under the same conditional
          // claim the settle path uses. That frees the slot without touching a
          // balance, and the row keeps `paymentNeedsManualReview` plus the
          // alert raised below — the debt is not written off, it is handed to
          // the human who was always the only one who could settle it.
          if (readOwedMarkerState(current?.gatewayData ?? null) !== OWED_REFUND_STATE_OWED) {
            return null;
          }
          const retired = await tx.transaction.updateMany({
            where: {
              id: row.id,
              gatewayData: {
                path: [OWED_REFUND_KEY, 'state'],
                equals: OWED_REFUND_STATE_OWED,
              },
            },
            data: {
              gatewayData: mergeGatewayData(current?.gatewayData ?? null, {
                [OWED_REFUND_KEY]: {
                  ...(asRecord(current?.gatewayData ?? null)?.[OWED_REFUND_KEY] as
                    | Record<string, unknown>
                    | undefined),
                  state: OWED_REFUND_STATE_UNRESOLVABLE,
                  unresolvableAt: now,
                },
                paymentNeedsManualReview: true,
              }) as Prisma.InputJsonValue,
            },
          });
          retiredUnusable = retired.count > 0;
          return null;
        }

        // Conditional claim — flips OWED → RESTORED under this row's lock, so
        // a concurrent tick blocks here, re-evaluates, and finds nothing owed
        // rather than incrementing the balance a second time. The increment
        // rides in the same transaction: either both land or neither does, so
        // the marker can never say RESTORED over money that never moved.
        const claim = await tx.transaction.updateMany({
          where: {
            id: row.id,
            gatewayData: {
              path: [OWED_REFUND_KEY, 'state'],
              equals: OWED_REFUND_STATE_OWED,
            },
          },
          data: {
            gatewayData: mergeGatewayData(current?.gatewayData ?? null, {
              [OWED_REFUND_KEY]: {
                ...(asRecord(current?.gatewayData ?? null)?.[OWED_REFUND_KEY] as
                  | Record<string, unknown>
                  | undefined),
                state: OWED_REFUND_STATE_RESTORED,
                attempts: debt.attempts + 1,
                lastAttemptAt: now,
                restoredAt: now,
              },
              // The debt is settled, so the row goes back to being an ordinary
              // failed checkout the expiry sweep may cancel.
              paymentNeedsManualReview: false,
            }) as Prisma.InputJsonValue,
          },
        });
        if (claim.count === 0) return null;

        await tx.partner.update({
          where: { id: debt.partnerId },
          data: { balance: { increment: debt.amountMinor } },
        });
        await releasePaidTrialClaim(tx, row.id, debt.releaseReason);
        return debt;
      });
    } catch (error: unknown) {
      await this.noteFailedRestoreAttempt(row.id, describeFailure(error), now);
      return 'STILL_OWED';
    }
    if (settled === null) {
      if (!retiredUnusable) return 'SKIPPED';
      // Counted as owed because it is: the money never went back. It is simply
      // owed by an operator now rather than by the next tick, and the retiring
      // write is one-way, so this alert fires once instead of every five
      // minutes forever.
      this.events.error(
        EVENT_TYPES.PARTNER_BALANCE_REFUND_FAILED,
        'PARTNER',
        `Возврат на баланс партнёра по транзакции ${row.id} записан некорректно и не может ` +
          'быть выполнен автоматически — требуется ручной возврат',
        {
          userId: row.userId,
          currency: row.currency,
          paymentId: row.paymentId,
          transactionId: row.id,
          reason: 'PARTNER_BALANCE_REFUND_MARKER_UNUSABLE',
          durablyRecorded: true,
        },
      );
      this.logger.error(
        `Partner-balance refund marker on transaction ${row.id} names no spendable partner ` +
          'or amount — retired to UNRESOLVABLE and left for manual refund',
      );
      return 'STILL_OWED';
    }

    this.events.warn(
      EVENT_TYPES.PARTNER_BALANCE_ADJUSTED,
      'PARTNER',
      `Отложенный возврат ${settled.amountMinor} (мин. ед.) ${row.currency} на баланс ` +
        `партнёра ${settled.partnerId} выполнен — ручной возврат больше не нужен`,
      {
        userId: row.userId,
        partnerId: settled.partnerId,
        amountMinor: settled.amountMinor,
        currency: row.currency,
        paymentId: row.paymentId,
        transactionId: row.id,
        attempts: settled.attempts + 1,
      },
    );
    return 'RESTORED';
  }

  /**
   * Bumps the attempt counter on a restore that failed again, leaving `state`
   * at `OWED` so the next tick retries. Best-effort by construction: the debt
   * is already recorded, and losing a counter is not worth abandoning a sweep.
   */
  private async noteFailedRestoreAttempt(
    transactionId: string,
    failure: string,
    now: string,
  ): Promise<void> {
    this.logger.error(
      `Partner-balance refund retry failed for transaction ${transactionId}: ${failure}`,
    );
    try {
      const current = await this.prismaService.transaction.findUnique({
        where: { id: transactionId },
        select: { gatewayData: true },
      });
      const debt = readOwedBalanceRestore(current?.gatewayData ?? null);
      if (debt === null) return;
      await this.prismaService.transaction.updateMany({
        where: {
          id: transactionId,
          gatewayData: {
            path: [OWED_REFUND_KEY, 'state'],
            equals: OWED_REFUND_STATE_OWED,
          },
        },
        data: {
          gatewayData: mergeGatewayData(current?.gatewayData ?? null, {
            [OWED_REFUND_KEY]: {
              ...(asRecord(current?.gatewayData ?? null)?.[OWED_REFUND_KEY] as
                | Record<string, unknown>
                | undefined),
              attempts: debt.attempts + 1,
              lastAttemptAt: now,
              failure,
            },
          }) as Prisma.InputJsonValue,
        },
      });
    } catch {
      // Nothing further to do — the OWED marker and the ERROR event raised
      // when it was written are what an operator acts on.
    }
  }

  private async resolveUser(input: PartnerBalancePaymentInput): Promise<{
    readonly id: string;
    readonly partnerBalanceCurrencyOverride: Currency | null;
  }> {
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { id: true, partnerBalanceCurrencyOverride: true },
      });
      if (user === null) throw new NotFoundException('User not found');
      return user;
    }
    if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true, partnerBalanceCurrencyOverride: true },
      });
      if (user === null) throw new NotFoundException('User not found');
      return user;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }
}

/**
 * Reads an outstanding restore off `gatewayData`, or `null` when there is
 * nothing an automated retry could safely act on.
 *
 * Strict on every field it will spend money against: a partner id that is not
 * a non-empty string, or an amount that is not a positive safe integer, means
 * the marker is not trustworthy and the row is left for a human. `state` is
 * compared with `===` so a truthy leftover can never be read as a debt.
 */
function readOwedBalanceRestore(
  gatewayData: Prisma.JsonValue | null,
): OwedBalanceRestore | null {
  const marker = asRecord(asRecord(gatewayData)?.[OWED_REFUND_KEY] ?? null);
  if (marker === null || marker['state'] !== OWED_REFUND_STATE_OWED) return null;

  const partnerId = marker['partnerId'];
  const amountMinor = marker['amountMinor'];
  const releaseReason = marker['releaseReason'];
  const attempts = marker['attempts'];
  if (typeof partnerId !== 'string' || partnerId.length === 0) return null;
  if (
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0
  ) {
    return null;
  }
  return {
    partnerId,
    amountMinor,
    releaseReason:
      typeof releaseReason === 'string' && releaseReason.length > 0
        ? releaseReason
        : 'PARTNER_BALANCE_REFUND_RECOVERED',
    attempts: typeof attempts === 'number' && Number.isSafeInteger(attempts) ? attempts : 0,
  };
}

/**
 * Whether the row already carries a settled restore — i.e. the increment that
 * shares its transaction committed.
 *
 * Compared with `===` against the terminal state, so neither a missing marker
 * nor an `OWED` one can be mistaken for money that moved.
 */
function balanceRestoreIsSettled(gatewayData: Prisma.JsonValue | null): boolean {
  const marker = asRecord(asRecord(gatewayData)?.[OWED_REFUND_KEY] ?? null);
  return marker !== null && marker['state'] === OWED_REFUND_STATE_RESTORED;
}

/** The raw `partnerBalanceRefund.state`, whether or not the rest parses. */
function readOwedMarkerState(gatewayData: Prisma.JsonValue | null): unknown {
  return asRecord(asRecord(gatewayData)?.[OWED_REFUND_KEY] ?? null)?.['state'];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Same shallow merge `PaymentPendingExpiryService` uses on this column. */
function mergeGatewayData(
  currentValue: Prisma.JsonValue | null,
  nextValue: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(asRecord(currentValue) ?? {}), ...nextValue };
}

/**
 * Redacted, always-a-string description of a thrown value.
 *
 * Redacted because this text is stored on the transaction row and sent to the
 * operator's Telegram: a Prisma connection error carries the database URL,
 * credentials and all.
 */
function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactPaymentDiagnosticMessage(raw) ?? 'UNKNOWN_ERROR';
}

function toExactMinorUnits(amount: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function mapPurchaseTypeToAccessGate(purchaseType: PurchaseType): AccessModeGate {
  switch (purchaseType) {
    case PurchaseType.UPGRADE:
      return 'purchase.upgrade';
    case PurchaseType.RENEW:
      return 'purchase.renewal';
    case PurchaseType.NEW:
    case PurchaseType.ADDITIONAL:
    default:
      return 'purchase.new';
  }
}
