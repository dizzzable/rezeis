import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentGatewayType, Prisma, TransactionStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import {
  claimForImmediateFulfillment,
  releaseFulfillmentClaim,
} from './payment-fulfillment-claim.util';
import { requireSetting, requireYookassaSecretKey } from './payment-provider-execution.helpers';
import { releasePaidTrialClaim } from '../../subscriptions/services/trial-claim-ledger.util';
import { CHECKOUT_LIFETIME_MS } from '../constants/checkout-lifetime.constant';
import { isProviderCreationClaim } from './payments-checkout.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';

/**
 * Time a checkout may sit in `PENDING` before it is auto-cancelled.
 *
 * This used to claim that "provider checkout links expire well within this
 * window". They did not: Wata defaulted to three days and Overpay to a day, and
 * we asked for no expiry at all on most gateways — so a row we cancelled here
 * could stay payable long afterwards. That gap is why releasing a paid-trial
 * reservation on cancel was unsafe.
 *
 * It is now *enforced* rather than assumed: `createCheckout` asks every gateway
 * that supports it for exactly this lifetime, so by the time this sweep fires
 * the invoice has already expired at the provider. Both clocks derive from one
 * constant — see `checkout-lifetime.constant.ts`.
 *
 * Hardcoded by product decision — not env-configurable.
 */
const PENDING_TTL_MS = CHECKOUT_LIFETIME_MS;

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
    private readonly httpService: HttpService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly paymentReconciliationService: PaymentReconciliationService,
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
        gatewayId: true,
        gatewayData: true,
        amount: true,
        currency: true,
      },
      take: MAX_PER_TICK,
    });
    if (stale.length === 0) return;

    let cancelled = 0;
    let heldForReview = 0;
    for (const tx of stale) {
      // Already on an operator's desk. `paymentNeedsManualReview` is stamped by
      // reconciliation when a provider reports that money ARRIVED but not in
      // the amount invoiced — Cryptomus/Heleket `wrong_amount`, Pally
      // `UNDERPAID` — or that it is frozen (`locked`). Cancelling such a row
      // here would empty the review queue behind the operator's back and file a
      // paid invoice as an abandoned cart: the INFO event below is explicitly
      // routine noise, so the alert raised for the mismatch would be the only
      // trace, contradicted by a CANCELED row.
      //
      // Trade-off, taken deliberately: skipping the sweep holds the row PENDING
      // indefinitely, so its paid-trial reservation stays RESERVED and the
      // buyer's quota is not returned — the exact harm this service's own
      // comments document. It is acceptable ONLY because reconciliation raised
      // `EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH` at the moment it set the flag, so
      // a human resolves the row instead of it rotting. That alert is the
      // load-bearing half of the pair; this exemption without it would be a
      // regression.
      if (needsManualReview(tx.gatewayData)) {
        heldForReview += 1;
        continue;
      }
      const providerVerified = await this.isProviderTerminal(tx);
      if (providerVerified === 'keep') continue;
      // Race guard: only cancel if still PENDING — a webhook that completed it
      // between the read and now must not be overwritten. The trial claim is
      // released in the SAME transaction: cancelling the row while leaving its
      // reservation RESERVED burned the user's trial quota permanently, for
      // every abandoned checkout — the quota counter treats RESERVED as spent
      // and nothing else ever released it.
      const result = await this.prismaService.$transaction(async (dbTx) => {
        const updated = await dbTx.transaction.updateMany({
          where: { id: tx.id, status: TransactionStatus.PENDING },
          data: { status: TransactionStatus.CANCELED },
        });
        if (updated.count === 0) return updated;
        await releasePaidTrialClaim(
          dbTx,
          tx.id,
          providerVerified === 'provider-terminal'
            ? 'PROVIDER_TERMINAL_EXPIRED'
            : 'LOCAL_TTL_EXPIRED',
        );
        return updated;
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
    if (heldForReview > 0) {
      // One line per tick, not per row: a rising count is the signal that
      // flagged payments are piling up unresolved and the alerts are being
      // ignored — the failure mode the exemption above depends on not happening.
      this.logger.warn(
        `Payment expiry: skipped ${heldForReview} stale PENDING transaction(s) awaiting manual review`,
      );
    }
  }

  /**
   * Decides whether a stale row may be cancelled, and on whose authority.
   *
   * - `keep`              — leave PENDING (still open at the provider, already
   *                         paid, or the check itself failed).
   * - `provider-terminal` — the provider was polled and reports the payment
   *                         dead. Releasing its trial reservation is the
   *                         sanctioned provider-terminal release.
   * - `local-ttl`         — no provider verdict available (non-YooKassa, or no
   *                         provider id yet). The cancel rests on our own TTL.
   *
   * The distinction is recorded in the release reason rather than used to skip
   * the release: leaving a reservation held forever is a certain harm (the
   * user's trial is gone for good), while a late payment on a locally-expired
   * row still fulfils — reconciliation revives the transaction and
   * `consumePaidTrialClaim` revives the released claim with it.
   */
  private async isProviderTerminal(tx: {
    readonly id: string; readonly paymentId: string; readonly gatewayType: PaymentGatewayType;
    readonly gatewayId: string | null; readonly gatewayData: Prisma.JsonValue | null;
  }): Promise<'keep' | 'provider-terminal' | 'local-ttl'> {
    if (tx.gatewayType !== PaymentGatewayType.YOOKASSA || tx.gatewayId === null) {
      return 'local-ttl';
    }
    // Local claim placeholders (renewal provider-create locks) are NOT real
    // YooKassa payment ids, but they may sit on a row whose create request
    // already charged off-session (timeout / network drop). Never auto-cancel
    // them — keep PENDING so webhook (metadata.paymentId) or ops can resolve.
    if (isProviderCreationClaim(tx.gatewayId)) {
      this.logger.warn(
        `Keeping YooKassa payment ${tx.paymentId} pending: provider-create claim placeholder (not auto-expiring)`,
      );
      return 'keep';
    }
    try {
      const gateway = await this.prismaService.paymentGateway.findUnique({ where: { type: PaymentGatewayType.YOOKASSA }, select: { settings: true } });
      if (gateway === null) throw new Error('YooKassa gateway is not configured');
      const settings = readGatewaySettings(gateway.settings);
      const response = await firstValueFrom(this.httpService.get(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(tx.gatewayId)}`, {
        auth: { username: requireSetting(settings, 'shopId'), password: requireYookassaSecretKey(settings) }, validateStatus: () => true,
      }));
      if (response.status < 200 || response.status >= 300) throw new Error(`YooKassa GET payment returned HTTP ${response.status}`);
      const data = asRecord(response.data);
      const providerStatus = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
      // Still open at the provider — leave local PENDING for webhook/3DS, but
      // stamp the poll so ops can see we re-checked.
      if (providerStatus === 'pending' || providerStatus === 'waiting_for_capture') {
        await this.prismaService.transaction.updateMany({
          where: { id: tx.id, status: TransactionStatus.PENDING },
          data: {
            gatewayData: mergeGatewayData(tx.gatewayData, {
              providerStatus,
              polledAt: new Date().toISOString(),
            }) as Prisma.InputJsonValue,
          },
        });
        this.logger.warn(
          `Keeping YooKassa payment ${tx.paymentId} pending after provider status ${providerStatus}`,
        );
        return 'keep';
      }
      // Paid at the provider but webhook was lost: stamp poll metadata, claim
      // fulfillment, and provision so the user is not left paid-but-undelivered.
      if (providerStatus === 'succeeded') {
        await this.prismaService.transaction.updateMany({
          where: { id: tx.id, status: TransactionStatus.PENDING },
          data: {
            gatewayData: mergeGatewayData(tx.gatewayData, {
              providerStatus,
              polledAt: new Date().toISOString(),
              polledSucceededWithoutWebhook: true,
            }) as Prisma.InputJsonValue,
          },
        });
        const claimedAt = await claimForImmediateFulfillment(this.prismaService, tx.id);
        if (claimedAt !== null) {
          const completed = await this.prismaService.transaction.findUnique({
            where: { id: tx.id },
          });
          if (completed !== null) {
            try {
              let syncJobs;
              try {
                ({ syncJobs } =
                  await this.paymentSubscriptionMutationService.applyCompletedTransaction(
                    completed,
                  ));
              } catch (provisionError: unknown) {
                await releaseFulfillmentClaim(this.prismaService, tx.id, claimedAt).catch(
                  () => undefined,
                );
                throw provisionError;
              }
              for (const syncJob of syncJobs) {
                await this.profileSyncQueueService.enqueue(syncJob.id);
              }
              // Same post-completion hooks as webhook reconciliation (referrals,
              // partner, МойНалог, ads) + persist reusable method from poll body.
              // Best-effort: never reopen fulfillment if hooks fail.
              await this.paymentReconciliationService.runPostFulfillmentHooks(
                completed,
                data,
              );
              this.logger.warn(
                `YooKassa payment ${tx.paymentId} polled succeeded and fulfilled without webhook`,
              );
            } catch (error: unknown) {
              this.logger.error(
                `Polled succeed fulfill failed for ${tx.paymentId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
        return 'keep';
      }
      // canceled / failed / unknown → the provider itself calls it dead.
      return 'provider-terminal';
    } catch (error: unknown) {
      this.logger.warn(`Skipping expiry for YooKassa payment ${tx.paymentId}: ${error instanceof Error ? error.message : String(error)}`);
      return 'keep';
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Has reconciliation handed this row to an operator? Written as
 * `paymentNeedsManualReview` on `gatewayData` when a provider reported money
 * received against the wrong amount — see
 * `PaymentReconciliationService.flagAmountMismatchForReview`. Strict `=== true`
 * so a truthy leftover string can never suppress an ordinary expiry.
 */
function needsManualReview(gatewayData: Prisma.JsonValue | null): boolean {
  return asRecord(gatewayData)?.['paymentNeedsManualReview'] === true;
}

function mergeGatewayData(currentValue: Prisma.JsonValue | null, nextValue: Record<string, unknown>): Record<string, unknown> {
  return { ...(asRecord(currentValue) ?? {}), ...nextValue };
}