import { createHash } from 'node:crypto';

import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  PaymentGatewayType,
  Prisma,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  Transaction,
  TransactionStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { CHECKOUT_LIFETIME_MS } from '../constants/checkout-lifetime.constant';
import {
  PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  PROVIDER_SUBSCRIPTION_SYNC_JOB,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../constants/payment-reconciliation.constant';
import { PaymentWebhookEnvelopeInterface } from '../interfaces/payment-webhook-envelope.interface';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { isWithheldConversion } from '../utils/trial-conversion.util';
import {
  autopayNotAvailable,
  PROVIDER_SUBSCRIPTION_CONSENT_VERSION,
  ProviderSubscriptionTerms,
  readProviderSubscriptionTerms,
} from '../utils/provider-subscription-terms.util';
import {
  isRollypayStopTaken,
  mapRollypaySubscriptionStatus,
  parseRollypayCharges,
  ROLLYPAY_API,
  ROLLYPAY_CHARGES_PAGE,
  ROLLYPAY_TAKEN_PAYMENT_STATUSES,
  rollypayHeaders,
  rollypayPaidCycles,
} from '../utils/rollypay-subscription.util';
import { requireSetting } from './payment-provider-execution.helpers';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';

const PLATEGA_API = 'https://app.platega.io';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far past the provider's next charge a delivered renewal reaches. The
 * charge lands at `nextChargeAt`, its callback a little after, the renewal a
 * little after that; without this margin every period would end with the VPN
 * switched off for those minutes. Platega's own example also shows a «month»
 * of 31 days against the 30 it documents, so the margin absorbs that too.
 */
export const CHARGE_GRACE_MS = DAY_MS;
/** A provider date further out than this is not a reason to give more days. */
const MAX_EXTRA_DAYS = 3;

const LIVE_STATUSES: readonly ProviderSubscriptionStatus[] = [
  ProviderSubscriptionStatus.ACTIVE,
  ProviderSubscriptionStatus.PAST_DUE,
];

/** Live rows `cancelStranded` reads at a time; it reads every one of them. */
export const STRANDED_SWEEP_PAGE = 500;

/** A live row as `cancelStranded` reads it: with its customer's block. */
type StrandedCandidate = ProviderSubscription & { readonly user: { readonly isBlocked: boolean } | null };

export type ProviderSubscriptionCancelledBy = 'CUSTOMER' | 'OPERATOR' | 'SYSTEM';

/** What the provider says about one subscription, read with our own keys. */
export interface ProviderSubscriptionState {
  /** Null when the provider used a word we do not know: keep what we had. */
  readonly status: ProviderSubscriptionStatus | null;
  readonly providerStatus: string | null;
  /** Successful charges so far, the first one included. Null when not reported. */
  readonly chargesSuccess: number | null;
  readonly nextChargeAt: Date | null;
  readonly lastChargeAt: Date | null;
}

export interface CustomerProviderSubscriptionInterface {
  readonly id: string;
  readonly gatewayType: PaymentGatewayType;
  readonly status: ProviderSubscriptionStatus;
  readonly amount: string;
  readonly currency: string;
  readonly intervalUnit: string;
  readonly intervalCount: number;
  readonly durationDays: number;
  readonly planName: string | null;
  readonly subscriptionId: string | null;
  readonly nextChargeAt: string | null;
  readonly lastChargeAt: string | null;
}

/**
 * Subscriptions the PROVIDER runs (Platega, RollyPay): the payer confirms a
 * fixed sum and period once, and the provider charges on its own schedule.
 *
 * The provider's callbacks are only a reason to look. Platega's are
 * authenticated by two static headers and nothing else, their status words
 * differ from the ones the API returns; RollyPay's name no subscription at all
 * and it sends none when one stops; and a lost one must not lose a renewal. So
 * every look reads the subscription with our own keys, and its count of
 * successful charges (Platega's `chargesSuccess`, RollyPay's paid cycles, each
 * confirmed by its payment) is the ledger: each charge above `appliedChargeCount` becomes
 * one delivered renewal, keyed by subscription and charge number, so a repeated
 * callback, a callback and the sweep at once, or a crash half-way all deliver
 * each charge exactly once.
 *
 * A charge is delivered through the same pipeline as any paid webhook — an
 * inbox event the reconciliation worker settles — so receipts, cashback,
 * referral rewards and notifications happen as for every other payment. The
 * first charge completes the checkout the payer started; every later one is a
 * RENEW payment created here for the subscription's own fixed sum.
 */
@Injectable()
export class ProviderSubscriptionService {
  private readonly logger = new Logger(ProviderSubscriptionService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
  ) {}

  /**
   * Records the subscription a checkout just created at the provider. Best
   * effort: when this write is lost, the first callback finds the checkout by
   * its provider id and records it then (`adoptFromCheckout`).
   */
  public async recordCheckout(transaction: Transaction): Promise<void> {
    const terms = readProviderSubscriptionTerms(transaction.planSnapshot);
    if (terms === null || transaction.gatewayId === null || transaction.gatewayId.length === 0) {
      return;
    }
    try {
      await this.createRow(transaction, transaction.gatewayId, terms);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      this.logger.error(
        `Could not record provider subscription ${transaction.gatewayId} for transaction ${transaction.id}; ` +
          `its first callback will: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Queues a look at one subscription. Called from its callbacks and the sweep. */
  public async enqueueSync(
    gatewayType: PaymentGatewayType,
    providerSubscriptionId: string,
    delayMs = 0,
  ): Promise<void> {
    await runPaymentReconciliationEnqueueWithTimeout(() =>
      this.paymentReconciliationQueue.add(
        PROVIDER_SUBSCRIPTION_SYNC_JOB,
        { gatewayType, providerSubscriptionId },
        {
          ...(delayMs > 0 ? { delay: delayMs } : {}),
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      ),
    );
  }

  /**
   * Queues a look at whatever subscription a provider payment belongs to.
   * RollyPay's callback for a subscription's charge is an ordinary
   * `payment.paid` that names neither the subscription nor a payment of ours;
   * only the payment object does.
   */
  public async enqueuePaymentLookup(gatewayType: PaymentGatewayType, providerPaymentId: string): Promise<void> {
    await runPaymentReconciliationEnqueueWithTimeout(() =>
      this.paymentReconciliationQueue.add(
        PROVIDER_SUBSCRIPTION_SYNC_JOB,
        { gatewayType, providerPaymentId },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      ),
    );
  }

  public async syncByPayment(gatewayType: PaymentGatewayType, providerPaymentId: string): Promise<void> {
    if (gatewayType !== PaymentGatewayType.ROLLYPAY) {
      throw new Error(`No payment lookup for ${gatewayType}`);
    }
    const gateway = await this.prismaService.paymentGateway.findUnique({ where: { type: gatewayType } });
    if (gateway === null) {
      this.logger.warn(`Gateway ${gatewayType} is gone; payment ${providerPaymentId} cannot be read`);
      return;
    }
    const settings = readGatewaySettings(gateway.settings);
    const response = await firstValueFrom(
      this.httpService.get(`${ROLLYPAY_API}/payments/${encodeURIComponent(providerPaymentId)}`, {
        headers: rollypayHeaders(requireSetting(settings, 'apiKey')),
      }),
    );
    const subscriptionId = asRecord(response.data)['subscription_id'];
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
      // A one-off payment we did not create: another integration on the same kassa.
      this.logger.warn(`${gatewayType} payment ${providerPaymentId} is not ours and not a subscription's; ignored`);
      return;
    }
    await this.sync(gatewayType, subscriptionId);
  }

  public async sync(gatewayType: PaymentGatewayType, providerSubscriptionId: string): Promise<void> {
    const row =
      (await this.prismaService.providerSubscription.findUnique({
        where: { gatewayType_providerSubscriptionId: { gatewayType, providerSubscriptionId } },
      })) ?? (await this.adoptFromCheckout(gatewayType, providerSubscriptionId));
    if (row === null) {
      // Not one of ours: another integration on the same merchant account, or
      // a checkout whose transaction is gone. Nothing here may charge for it.
      this.logger.warn(`Callback for unknown ${gatewayType} subscription ${providerSubscriptionId}; ignored`);
      return;
    }
    await this.syncRow(row);
  }

  public async syncRow(row: ProviderSubscription): Promise<void> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: row.gatewayType },
    });
    if (gateway === null) {
      this.logger.warn(`Gateway ${row.gatewayType} is gone; subscription ${row.id} cannot be read`);
      return;
    }
    const state = await this.fetchState(row, gateway.settings);

    let applied = row.appliedChargeCount;
    let subscriptionId = row.subscriptionId;
    if (row.userId === null && state.chargesSuccess !== null && state.chargesSuccess > applied) {
      // Charged after the account was deleted: there is nobody to deliver to,
      // and only an operator can return the money. The sweep cancels the row.
      this.logger.error(
        `Subscription ${row.id} (${row.gatewayType} ${row.providerSubscriptionId}) was charged ` +
          `${state.chargesSuccess - applied} time(s) after its account was deleted; refund at the provider`,
      );
    } else if (state.chargesSuccess !== null) {
      while (applied < state.chargesSuccess) {
        const chargeNumber = applied + 1;
        const transaction =
          chargeNumber === 1
            ? await this.prismaService.transaction.findUnique({ where: { id: row.firstTransactionId } })
            : await this.findOrCreateChargeTransaction(
                { ...row, subscriptionId: (subscriptionId ??= await this.resolveSubscriptionId(row)) },
                chargeNumber,
                state.nextChargeAt,
              );
        if (transaction === null) {
          // A later charge renews the subscription the first one created; until
          // that first delivery lands there is nothing to renew. Nothing else
          // would look again soon (the next callback is a period away), so this
          // look books its own.
          this.logger.warn(
            `Charge ${chargeNumber} of subscription ${row.id} is waiting for its first delivery`,
          );
          await this.enqueueSync(row.gatewayType, row.providerSubscriptionId, 60_000);
          break;
        }
        await this.enqueueSettlement(row, chargeNumber, transaction);
        const bumped = await this.prismaService.providerSubscription.updateMany({
          where: { id: row.id, appliedChargeCount: applied },
          data: { appliedChargeCount: chargeNumber },
        });
        if (bumped.count !== 1) {
          // Another worker got here first and owns the rest of the count; what
          // this one queued is the same event under the same key.
          break;
        }
        applied = chargeNumber;
      }
    }

    subscriptionId ??= await this.resolveSubscriptionId(row);
    // A cancellation the panel made, or a failure the provider reported, is
    // final here: a provider still answering «Active» a moment after a cancel
    // must not bring the row back. A charge it takes anyway was still applied
    // above — money taken is always delivered.
    const status =
      row.status === ProviderSubscriptionStatus.CANCELLED || row.status === ProviderSubscriptionStatus.FAILED
        ? row.status
        : (state.status ?? row.status);
    const providerCancelled =
      status === ProviderSubscriptionStatus.CANCELLED && row.cancelledAt === null;
    await this.prismaService.providerSubscription.update({
      where: { id: row.id },
      data: {
        status,
        providerStatus: state.providerStatus,
        nextChargeAt: state.nextChargeAt,
        lastChargeAt: state.lastChargeAt,
        lastSyncedAt: new Date(),
        ...(subscriptionId !== null && row.subscriptionId === null ? { subscriptionId } : {}),
        // Cancelled without the panel asking: the payer used the link in the
        // provider's email. The provider does not say who cancelled.
        ...(providerCancelled ? { cancelledAt: new Date(), cancelledBy: 'PROVIDER' } : {}),
      },
    });
  }

  /** The customer's live subscriptions, for «Способы оплаты». */
  public async listForUser(userId: string): Promise<readonly CustomerProviderSubscriptionInterface[]> {
    const rows = await this.prismaService.providerSubscription.findMany({
      where: { userId, status: { in: [...LIVE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const plans = await this.prismaService.plan.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.planId))] } },
      select: { id: true, name: true },
    });
    const planNames = new Map(plans.map((plan) => [plan.id, plan.name]));
    return rows.map((row) => ({
      id: row.id,
      gatewayType: row.gatewayType,
      status: row.status,
      amount: row.amount.toString(),
      currency: row.currency,
      intervalUnit: row.intervalUnit,
      intervalCount: row.intervalCount,
      durationDays: row.durationDays,
      planName: planNames.get(row.planId) ?? null,
      subscriptionId: row.subscriptionId,
      nextChargeAt: row.nextChargeAt?.toISOString() ?? null,
      lastChargeAt: row.lastChargeAt?.toISOString() ?? null,
    }));
  }

  /**
   * Refuses a second live provider subscription for one VPN subscription: both
   * would charge every period for the same access. A failed one (PAST_DUE) does
   * not block signing up again.
   *
   * `pendingOtherThan` — the checkout asking, when it converts a trial — also
   * refuses while another sign-up for the same subscription is still waiting to
   * be confirmed. A trial converts once: two sign-ups confirmed together both
   * converted it, and both kept renewing it. Only a sign-up inside its
   * checkout's lifetime counts, so one the payer walked away from stops
   * blocking when its checkout expires; the asking checkout's own row (a
   * re-tap of the same link) never does.
   */
  public async assertNoLiveSubscriptionFor(
    subscriptionId: string | null,
    options: { readonly pendingOtherThan?: string } = {},
  ): Promise<void> {
    if (subscriptionId === null) return;
    const live = await this.prismaService.providerSubscription.findFirst({
      where: { subscriptionId, status: ProviderSubscriptionStatus.ACTIVE },
      select: { id: true },
    });
    if (live !== null) {
      throw autopayNotAvailable('ALREADY_ACTIVE');
    }
    if (options.pendingOtherThan === undefined) return;
    const pending = await this.prismaService.providerSubscription.findFirst({
      where: {
        subscriptionId,
        status: ProviderSubscriptionStatus.PENDING,
        firstTransactionId: { not: options.pendingOtherThan },
        createdAt: { gt: new Date(Date.now() - CHECKOUT_LIFETIME_MS) },
      },
      select: { id: true },
    });
    if (pending !== null) {
      throw autopayNotAvailable('PENDING_SIGN_UP');
    }
  }

  /** «Отключить автосписание» in the cabinet. */
  public async cancelForCustomer(userId: string, id: string): Promise<void> {
    const row = await this.prismaService.providerSubscription.findFirst({ where: { id, userId } });
    if (row === null) {
      throw new NotFoundException('Provider subscription not found');
    }
    await this.cancel(row, 'CUSTOMER');
  }

  /**
   * Stops every live charge for these subscriptions or this user, so a plan
   * change, a deletion or a ban never leaves the provider charging for access
   * the panel no longer gives. Each cancel is tried separately, and a failure
   * is reported, not thrown: the caller's own change must not depend on a
   * provider being reachable.
   */
  public async cancelLive(
    where: { readonly userId: string } | { readonly subscriptionId: string },
    by: ProviderSubscriptionCancelledBy,
  ): Promise<number> {
    const rows = await this.prismaService.providerSubscription.findMany({
      where: {
        ...where,
        status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] },
      },
    });
    let cancelled = 0;
    for (const row of rows) {
      try {
        await this.cancel(row, by);
        cancelled += 1;
      } catch (error: unknown) {
        this.logger.error(
          `Could not cancel provider subscription ${row.id} (${row.gatewayType} ${row.providerSubscriptionId}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return cancelled;
  }

  /**
   * Looks again at the subscriptions a lost callback would leave wrong: a
   * checkout not yet confirmed, a charge that is due and not yet seen, and
   * every live one once a day for a cancellation made from the payer's email.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'provider-subscription-sweep' })
  public async sweep(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const now = Date.now();
    const rows = await this.prismaService.providerSubscription.findMany({
      where: {
        OR: [
          {
            status: ProviderSubscriptionStatus.PENDING,
            createdAt: { gt: new Date(now - DAY_MS), lt: new Date(now - 2 * 60 * 1000) },
          },
          {
            status: { in: [...LIVE_STATUSES] },
            OR: [
              { lastSyncedAt: null },
              { lastSyncedAt: { lt: new Date(now - DAY_MS) } },
              {
                nextChargeAt: { lt: new Date(now - 15 * 60 * 1000) },
                lastSyncedAt: { lt: new Date(now - 60 * 60 * 1000) },
              },
            ],
          },
        ],
      },
      select: { gatewayType: true, providerSubscriptionId: true },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    for (const row of rows) {
      try {
        await this.enqueueSync(row.gatewayType, row.providerSubscriptionId);
      } catch (error: unknown) {
        this.logger.warn(
          `Sweep could not queue ${row.providerSubscriptionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.cancelStranded();
  }

  /**
   * Cancels at the provider every subscription that would charge for access
   * the panel no longer gives: the account was deleted or blocked, the VPN
   * subscription was deleted, or it was moved to another plan (by the
   * operator, a plan deletion, or the customer's own plan change).
   *
   * One pass here rather than a call in every place that bans, deletes or
   * moves: those are spread over a dozen modules (anti-fraud, automations,
   * account merge, plan deletion, the admin screens), and the one that was
   * missed would keep charging a customer forever. The cost is up to one sweep
   * interval, ten minutes, against a period of at least a day.
   *
   * EVERY live row, a page at a time. It read the oldest 500 once, and the
   * oldest are exactly the rows that stay: the healthy ones, which the sweep
   * leaves alone, and the stranded ones the provider will not cancel. Once 500
   * of those piled up, no row behind them was ever looked at again, and a
   * blocked customer's autopay went on charging. The pages walk
   * (`createdAt`, `id`) forward, so a row the pass cancels, or one that stays,
   * is read once and never holds up the next.
   */
  public async cancelStranded(): Promise<number> {
    let cancelled = 0;
    let after: { readonly createdAt: Date; readonly id: string } | null = null;
    for (;;) {
      const rows: StrandedCandidate[] = await this.prismaService.providerSubscription.findMany({
        where: {
          status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] },
          ...(after === null
            ? {}
            : {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              }),
        },
        include: { user: { select: { isBlocked: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: STRANDED_SWEEP_PAGE,
      });
      cancelled += await this.cancelStrandedPage(rows);
      const last = rows[rows.length - 1];
      if (rows.length < STRANDED_SWEEP_PAGE || last === undefined) return cancelled;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  /** {@link cancelStranded} for one page of live rows. */
  private async cancelStrandedPage(rows: readonly StrandedCandidate[]): Promise<number> {
    if (rows.length === 0) return 0;
    const subscriptionIds = [
      ...new Set(rows.flatMap((row) => (row.subscriptionId === null ? [] : [row.subscriptionId]))),
    ];
    const subscriptions =
      subscriptionIds.length === 0
        ? []
        : await this.prismaService.subscription.findMany({
            where: { id: { in: subscriptionIds } },
            select: { id: true, status: true, planSnapshot: true, isTrial: true },
          });
    const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    // Read AFTER the subscriptions, and the order is what makes `LOST` safe: a
    // conversion this row's own charge made has its payment COMPLETED before
    // fulfilment converts anything, so a subscription seen converted is never
    // paired with that payment still unpaid.
    const conversions = await this.readTrialConversions(rows);
    let cancelled = 0;
    for (const row of rows) {
      const subscription = row.subscriptionId === null ? undefined : byId.get(row.subscriptionId);
      const reason = strandedReason({
        userDeleted: row.userId === null,
        userBlocked: row.user?.isBlocked === true,
        subscription:
          row.subscriptionId === null
            ? 'NOT_YET'
            : subscription === undefined
              ? 'MISSING'
              : {
                  status: subscription.status,
                  planId: readSnapshotPlanId(subscription.planSnapshot),
                  ...trialConversionOf(conversions.get(row.firstTransactionId), row.subscriptionId, subscription.isTrial),
                },
        planId: row.planId,
      });
      if (reason === null) continue;
      try {
        await this.cancel(row, 'SYSTEM');
        cancelled += 1;
        this.logger.log(`Cancelled provider subscription ${row.id} at ${row.gatewayType}: ${reason}`);
      } catch (error: unknown) {
        this.logger.error(
          `Could not cancel stranded provider subscription ${row.id} (${reason}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return cancelled;
  }

  /**
   * The checkouts of the rows whose first charge converts a trial (an
   * UPGRADE), by id. Every other row's first charge creates or renews a
   * subscription and is left out, so this reads only what `trialConversionOf`
   * needs.
   */
  private async readTrialConversions(
    rows: readonly Pick<ProviderSubscription, 'subscriptionId' | 'firstTransactionId'>[],
  ): Promise<Map<string, TrialConversionCheckout>> {
    const ids = rows.flatMap((row) => (row.subscriptionId === null ? [] : [row.firstTransactionId]));
    if (ids.length === 0) return new Map();
    const checkouts = await this.prismaService.transaction.findMany({
      where: { id: { in: ids }, purchaseType: PurchaseType.UPGRADE },
      select: { id: true, subscriptionId: true, status: true, fulfilledAt: true, gatewayData: true },
    });
    return new Map(checkouts.map((checkout) => [checkout.id, checkout]));
  }

  private async cancel(row: ProviderSubscription, by: ProviderSubscriptionCancelledBy): Promise<void> {
    if (
      row.status === ProviderSubscriptionStatus.CANCELLED ||
      row.status === ProviderSubscriptionStatus.FAILED
    ) {
      return;
    }
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: row.gatewayType },
    });
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    await this.cancelAtProvider(row.gatewayType, gateway.settings, row.providerSubscriptionId);
    await this.prismaService.providerSubscription.update({
      where: { id: row.id },
      data: {
        status: ProviderSubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: by,
      },
    });
  }

  /**
   * Live subscriptions per gateway, and how many of them still pay a list
   * price the operator has changed since: a price change applies to new
   * sign-ups only, and this is where the operator sees who kept the old one.
   */
  public async summary(): Promise<readonly ProviderSubscriptionSummaryInterface[]> {
    const rows = await this.prismaService.providerSubscription.findMany({
      where: { status: { in: [...LIVE_STATUSES] } },
      select: {
        gatewayType: true,
        status: true,
        planId: true,
        durationDays: true,
        currency: true,
        listAmount: true,
      },
    });
    const listPrices = await this.currentListPrices(rows);
    const byGateway = new Map<PaymentGatewayType, { active: number; pastDue: number; onOldPrice: number }>();
    for (const row of rows) {
      const counts = byGateway.get(row.gatewayType) ?? { active: 0, pastDue: 0, onOldPrice: 0 };
      if (row.status === ProviderSubscriptionStatus.PAST_DUE) counts.pastDue += 1;
      else counts.active += 1;
      // «из них по прежней цене»: of the active ones, which the line counts first.
      // A past-due one is not charging, whatever price it was signed up at.
      if (row.status !== ProviderSubscriptionStatus.PAST_DUE && row.listAmount !== null) {
        const current = listPrices.get(listPriceKey(row.planId, row.durationDays, row.currency));
        // A term no longer sold counts too: nobody can sign up at that price now.
        if (current === undefined || !current.equals(row.listAmount)) counts.onOldPrice += 1;
      }
      byGateway.set(row.gatewayType, counts);
    }
    return [...byGateway.entries()].map(([gatewayType, counts]) => ({ gatewayType, ...counts }));
  }

  private async currentListPrices(
    rows: readonly { readonly planId: string; readonly durationDays: number; readonly currency: string }[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const planIds = [...new Set(rows.map((row) => row.planId))];
    const prices = new Map<string, Prisma.Decimal>();
    if (planIds.length === 0) return prices;
    const durations = await this.prismaService.planDuration.findMany({
      where: { planId: { in: planIds }, isActive: true },
      select: { planId: true, days: true, prices: { select: { currency: true, price: true } } },
    });
    for (const duration of durations) {
      for (const price of duration.prices) {
        prices.set(listPriceKey(duration.planId, duration.days, price.currency), price.price);
      }
    }
    return prices;
  }

  private async createRow(
    transaction: Transaction,
    providerSubscriptionId: string,
    terms: ProviderSubscriptionTerms,
  ): Promise<ProviderSubscription> {
    const listAmount =
      (await this.currentListPrices([
        { planId: terms.planId, durationDays: terms.durationDays, currency: transaction.currency },
      ])).get(listPriceKey(terms.planId, terms.durationDays, transaction.currency)) ?? null;
    return this.prismaService.providerSubscription.create({
      data: {
        userId: transaction.userId,
        gatewayType: transaction.gatewayType,
        providerSubscriptionId,
        status: ProviderSubscriptionStatus.PENDING,
        // Only the subscription the terms name: the one a RENEW renews, or the
        // trial an UPGRADE converts. A new purchase names none — its charges
        // renew the subscription the first one creates, which
        // `resolveSubscriptionId` reads once fulfilment has made it. The
        // checkout's own `subscriptionId` is not a fallback: older drafts
        // carried the buyer's LATEST subscription there, and a row bound to it
        // renewed that one while the new one lapsed, or was cancelled as moved.
        subscriptionId: terms.subscriptionId,
        planId: terms.planId,
        durationDays: terms.durationDays,
        amount: new Prisma.Decimal(terms.amount),
        listAmount,
        currency: transaction.currency,
        intervalUnit: terms.unit,
        intervalCount: terms.count,
        firstTransactionId: transaction.id,
        consentVersion: PROVIDER_SUBSCRIPTION_CONSENT_VERSION,
      },
    });
  }

  private async adoptFromCheckout(
    gatewayType: PaymentGatewayType,
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    const transaction = await this.prismaService.transaction.findFirst({
      where: { gatewayType, gatewayId: providerSubscriptionId },
    });
    const terms = transaction === null ? null : readProviderSubscriptionTerms(transaction.planSnapshot);
    if (transaction === null || terms === null) return null;
    try {
      return await this.createRow(transaction, providerSubscriptionId, terms);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prismaService.providerSubscription.findUnique({
          where: { gatewayType_providerSubscriptionId: { gatewayType, providerSubscriptionId } },
        });
      }
      throw error;
    }
  }

  /** The subscription the first charge delivered: a new purchase has none until then. */
  private async resolveSubscriptionId(row: ProviderSubscription): Promise<string | null> {
    if (row.subscriptionId !== null) return row.subscriptionId;
    const first = await this.prismaService.transaction.findUnique({
      where: { id: row.firstTransactionId },
      select: { subscriptionId: true, status: true, fulfilledAt: true },
    });
    return first !== null && first.status === TransactionStatus.COMPLETED && first.fulfilledAt !== null
      ? first.subscriptionId
      : null;
  }

  /**
   * The RENEW payment for charge `chargeNumber` (2 and up), created once: the
   * key is the subscription and the charge number, and a second look finds the
   * same row. The sum is the subscription's own, fixed when the payer agreed
   * to it: a price the operator changed since applies to new sign-ups only.
   *
   * The line carries no plan snapshot on purpose, so fulfilment renews on the
   * plan as it is now. The money is already taken; refusing the renewal
   * because the catalogue moved would keep it and deliver nothing.
   */
  private async findOrCreateChargeTransaction(
    row: ProviderSubscription,
    chargeNumber: number,
    nextChargeAt: Date | null,
  ): Promise<Transaction | null> {
    const userId = row.userId;
    if (userId === null) return null;
    const idempotencyKey = `provider-subscription:${row.id}:charge:${chargeNumber}`;
    const existing = await this.prismaService.transaction.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    if (existing !== null) return existing;
    if (row.subscriptionId === null) return null;
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: row.subscriptionId },
      select: { expiresAt: true },
    });
    const durationDays = chargeCoverDays({
      durationDays: row.durationDays,
      expiresAt: subscription?.expiresAt ?? null,
      nextChargeAt,
      now: new Date(),
    });
    const marker = {
      snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE',
      providerSubscriptionId: row.providerSubscriptionId,
      chargeNumber,
    };
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const created = await tx.transaction.create({
          data: {
            userId,
            subscriptionId: null,
            status: TransactionStatus.PENDING,
            purchaseType: PurchaseType.RENEW,
            channel: PurchaseChannel.WEB,
            gatewayType: row.gatewayType,
            currency: row.currency,
            amount: row.amount,
            planSnapshot: {
              combinedRenewal: true,
              snapshotVersion: 1,
              itemCount: 1,
              ...marker,
            } as Prisma.InputJsonValue,
            gatewayData: {
              provider: row.gatewayType,
              snapshotSource: marker.snapshotSource,
              providerSubscriptionId: marker.providerSubscriptionId,
              chargeNumber: marker.chargeNumber,
            } as Prisma.InputJsonValue,
            deviceTypes: [],
            idempotencyKey,
          },
        });
        await tx.transactionItem.create({
          data: {
            transactionId: created.id,
            subscriptionId: row.subscriptionId as string,
            planId: row.planId,
            planSnapshot: marker as Prisma.InputJsonValue,
            durationDays,
            amount: row.amount,
            currency: row.currency,
            discountPercent: 0,
            addOnLines: Prisma.JsonNull,
          },
        });
        return created;
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prismaService.transaction.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
      }
      throw error;
    }
  }

  /**
   * Hands one charge to the reconciliation worker as a paid notification for
   * its payment. The event key is the subscription and the charge number, and
   * the payload holds nothing that changes between looks, so a second look is
   * recognised as the same notification and settles nothing twice.
   */
  private async enqueueSettlement(
    row: ProviderSubscription,
    chargeNumber: number,
    transaction: Transaction,
  ): Promise<void> {
    const rawPayload = {
      source: 'PROVIDER_SUBSCRIPTION',
      status: 'CONFIRMED',
      subscriptionId: row.providerSubscriptionId,
      chargeNumber,
      paymentId: transaction.paymentId,
    };
    const envelope: PaymentWebhookEnvelopeInterface = {
      gatewayType: row.gatewayType,
      paymentId: transaction.paymentId,
      providerEventId: `subscription:${row.providerSubscriptionId}:charge:${chargeNumber}`,
      eventStatus: 'CONFIRMED',
      receivedAt: new Date().toISOString(),
      payloadHash: createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex'),
      rawPayload,
    };
    const received = await this.paymentWebhookInboxService.recordReceived({ envelope });
    if (received.duplicate) {
      // Settled, settling, or FAILED to enqueue earlier — the auto-retry owns that one.
      return;
    }
    await this.paymentWebhookInboxService.markEnqueued(received.event.id);
    try {
      await runPaymentReconciliationEnqueueWithTimeout(() =>
        this.paymentReconciliationQueue.add(
          PAYMENT_RECONCILIATION_JOB,
          {
            eventId: received.event.id,
            paymentId: received.event.paymentId,
            gatewayType: received.event.gatewayType,
          },
          { removeOnComplete: 100, removeOnFail: 100 },
        ),
      );
    } catch (error: unknown) {
      await this.paymentWebhookInboxService.markFailed(
        received.event.id,
        PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
      );
      throw error;
    }
  }

  private async fetchState(
    row: ProviderSubscription,
    settingsJson: Prisma.JsonValue,
  ): Promise<ProviderSubscriptionState> {
    const settings = readGatewaySettings(settingsJson);
    switch (row.gatewayType) {
      case PaymentGatewayType.PLATEGA: {
        const response = await firstValueFrom(
          this.httpService.get(
            `${PLATEGA_API}/subscription/${encodeURIComponent(row.providerSubscriptionId)}`,
            { headers: plategaHeaders(settings) },
          ),
        );
        return parsePlategaSubscription(response.data);
      }
      case PaymentGatewayType.ROLLYPAY:
        return this.fetchRollypayState(row, requireSetting(settings, 'apiKey'));
      default:
        throw new Error(`No provider subscription API for ${row.gatewayType}`);
    }
  }

  /**
   * RollyPay keeps no count of paid charges one could trust alone: a charge
   * marked `payed` may still be under review, and «Выдавайте оплаченный доступ
   * только по подтверждённому платежу paid». So the count is the paid cycles
   * in the charge history, each new one confirmed by its payment, in order:
   * the first that is not confirmed yet stops the count until the next look.
   */
  private async fetchRollypayState(row: ProviderSubscription, apiKey: string): Promise<ProviderSubscriptionState> {
    const base = `${ROLLYPAY_API}/subscriptions/${encodeURIComponent(row.providerSubscriptionId)}`;
    const subscription = asRecord(
      (await firstValueFrom(this.httpService.get(base, { headers: rollypayHeaders(apiKey) }))).data,
    );
    const charges = parseRollypayCharges(
      (await firstValueFrom(this.httpService.get(`${base}/charges`, { headers: rollypayHeaders(apiKey) }))).data,
    );
    const paid = rollypayPaidCycles(charges);
    // A full page may have pushed the oldest paid cycles out of sight; they
    // were delivered long ago, and `successful_cycles` says how many there are.
    const reported = readCount(subscription['successful_cycles']);
    const hidden =
      charges.length >= ROLLYPAY_CHARGES_PAGE && reported !== null && reported > paid.length
        ? reported - paid.length
        : 0;
    let confirmed = Math.min(row.appliedChargeCount, hidden + paid.length);
    for (let chargeNumber = confirmed + 1; chargeNumber <= hidden + paid.length; chargeNumber += 1) {
      const charge = paid[chargeNumber - 1 - hidden];
      if (charge !== undefined && !(await this.isRollypayChargeTaken(row, charge.cycle, charge.paymentId, apiKey))) {
        break;
      }
      confirmed = chargeNumber;
    }
    const last = charges[charges.length - 1];
    const state = typeof subscription['state'] === 'string' ? subscription['state'] : null;
    const billingStatus = typeof subscription['billing_status'] === 'string' ? subscription['billing_status'] : null;
    return {
      status: mapRollypaySubscriptionStatus({
        state,
        billingStatus,
        lastAttemptFailed: last !== undefined && last.status === 'fail',
      }),
      providerStatus: state === null && billingStatus === null ? null : `${state ?? '?'}/${billingStatus ?? '?'}`,
      chargesSuccess: Math.max(confirmed, row.appliedChargeCount),
      nextChargeAt: readDate(subscription['next_charge_at']),
      lastChargeAt: paid[paid.length - 1]?.at ?? null,
    };
  }

  private async isRollypayChargeTaken(
    row: ProviderSubscription,
    cycle: number,
    paymentId: string | null,
    apiKey: string,
  ): Promise<boolean> {
    if (paymentId === null) return false;
    const response = await firstValueFrom(
      this.httpService.get(`${ROLLYPAY_API}/payments/${encodeURIComponent(paymentId)}`, {
        headers: rollypayHeaders(apiKey),
      }),
    );
    const payment = asRecord(response.data);
    const owner = payment['subscription_id'];
    if (typeof owner === 'string' && owner.length > 0 && owner !== row.providerSubscriptionId) {
      this.logger.error(
        `RollyPay cycle ${cycle} of ${row.providerSubscriptionId} names payment ${paymentId}, ` +
          `which belongs to subscription ${owner}; not delivered`,
      );
      return false;
    }
    const status = typeof payment['status'] === 'string' ? payment['status'].toLowerCase() : '';
    if (ROLLYPAY_TAKEN_PAYMENT_STATUSES.has(status)) return true;
    if (status !== 'created' && status !== 'processing') {
      this.logger.error(
        `RollyPay cycle ${cycle} of ${row.providerSubscriptionId} is «payed» but its payment ${paymentId} ` +
          `is ${status || 'unreadable'}; later cycles wait for it`,
      );
    }
    return false;
  }

  private async cancelAtProvider(
    gatewayType: PaymentGatewayType,
    settingsJson: Prisma.JsonValue,
    providerSubscriptionId: string,
  ): Promise<void> {
    const settings = readGatewaySettings(settingsJson);
    if (gatewayType === PaymentGatewayType.PLATEGA) {
      // Idempotent at Platega: cancelling a cancelled subscription answers the same.
      await firstValueFrom(
        this.httpService.post(
          `${PLATEGA_API}/subscription/${encodeURIComponent(providerSubscriptionId)}/cancel`,
          {},
          { headers: plategaHeaders(settings) },
        ),
      );
      return;
    }
    if (gatewayType === PaymentGatewayType.ROLLYPAY) {
      // «Перечитайте подписку и убедитесь»: RollyPay's `ok` is not the stop
      // itself, and a customer must not be told it stopped when it did not.
      // Stopping a stopped one is allowed.
      const apiKey = requireSetting(settings, 'apiKey');
      const base = `${ROLLYPAY_API}/subscriptions/${encodeURIComponent(providerSubscriptionId)}`;
      await firstValueFrom(this.httpService.post(`${base}/stop`, {}, { headers: rollypayHeaders(apiKey) }));
      const after = await firstValueFrom(this.httpService.get(base, { headers: rollypayHeaders(apiKey) }));
      if (!isRollypayStopTaken(after.data)) {
        throw new Error(`RollyPay did not stop subscription ${providerSubscriptionId}`);
      }
      return;
    }
    throw new Error(`No provider subscription API for ${gatewayType}`);
  }
}

/**
 * Why a provider subscription must stop charging, or null while it may go on.
 * A plan is compared by the id in the subscription's snapshot, which is where
 * a subscription keeps its plan.
 */
export function strandedReason(input: {
  readonly userDeleted: boolean;
  readonly userBlocked: boolean;
  readonly subscription:
    | 'NOT_YET'
    | 'MISSING'
    | {
        readonly status: SubscriptionStatus;
        readonly planId: string | null;
        /**
         * Only for a row whose first charge converts this subscription's trial
         * (see `trialConversionOf`). PENDING: it is still the trial, on the
         * trial's plan until that charge lands, and that is not a move. LOST:
         * it was converted while that charge did not stand — unpaid, refunded,
         * or paid and refused because another payment converted it first — so
         * there is nothing left for this sign-up to convert, and its later
         * charges would renew a subscription it never bought.
         */
        readonly trialConversion?: 'PENDING' | 'LOST';
      };
  readonly planId: string;
}): string | null {
  if (input.userDeleted) return 'account deleted';
  if (input.userBlocked) return 'account blocked';
  if (input.subscription === 'NOT_YET') return null;
  if (input.subscription === 'MISSING') return 'subscription deleted';
  if (input.subscription.status === SubscriptionStatus.DELETED) return 'subscription deleted';
  if (input.subscription.trialConversion === 'LOST') return 'trial converted without its first charge';
  if (input.subscription.trialConversion === 'PENDING') return null;
  if (input.subscription.planId !== null && input.subscription.planId !== input.planId) {
    return 'subscription moved to another plan';
  }
  return null;
}

/** The checkout of a row whose first charge is a trial's UPGRADE, as the sweep reads it. */
interface TrialConversionCheckout {
  readonly subscriptionId: string | null;
  readonly status: TransactionStatus;
  readonly fulfilledAt: Date | null;
  /** Carries the withheld mark (`isWithheldConversion`) when the conversion was received and not applied. */
  readonly gatewayData?: unknown;
}

/**
 * Where the trial conversion a row's first charge pays for stands, for
 * `strandedReason`; nothing for a row whose first charge creates or renews a
 * subscription. The checkout (`firstTransactionId`) says whether that charge
 * converts THIS subscription and whether it stands; `isTrial` says whether
 * the conversion has landed — fulfilment clears the flag in the same write
 * that moves the plan, so "still a trial" also covers a fulfilment in flight
 * or one that failed and waits for its retry.
 *
 * Once the trial is converted, this sign-up's conversion stands only if its
 * checkout was paid AND applied. Unpaid, refunded, or paid and withheld
 * because another payment converted the trial first (fulfilled, but carrying
 * the withheld mark — `isWithheldConversion`), or paid and not yet fulfilled —
 * all are LOST. Fulfilment claims `fulfilledAt` before it clears the flag, so a
 * trial this sign-up converted itself is never read as converted with the
 * stamp still empty.
 */
export function trialConversionOf(
  checkout: TrialConversionCheckout | undefined,
  subscriptionId: string | null,
  subscriptionIsTrial: boolean,
): { readonly trialConversion?: 'PENDING' | 'LOST' } {
  if (checkout === undefined || subscriptionId === null || checkout.subscriptionId !== subscriptionId) {
    return {};
  }
  if (subscriptionIsTrial) return { trialConversion: 'PENDING' };
  return checkout.status === TransactionStatus.COMPLETED &&
    checkout.fulfilledAt !== null &&
    !isWithheldConversion(checkout.gatewayData)
    ? {}
    : { trialConversion: 'LOST' };
}

function readSnapshotPlanId(snapshot: Prisma.JsonValue): string | null {
  const id =
    typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)['id']
      : null;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export interface ProviderSubscriptionSummaryInterface {
  readonly gatewayType: PaymentGatewayType;
  readonly active: number;
  readonly pastDue: number;
  /** Live subscriptions whose list price at sign-up is not today's. */
  readonly onOldPrice: number;
}

function listPriceKey(planId: string, days: number, currency: string): string {
  return `${planId}|${days}|${currency}`;
}

function plategaHeaders(settings: Record<string, unknown>): Record<string, string> {
  return {
    'X-MerchantId': requireSetting(settings, 'merchantId'),
    'X-Secret': requireSetting(settings, 'secret'),
  };
}

/**
 * Days one charge buys: the plan's term, stretched when that would end before
 * the provider's next charge plus {@link CHARGE_GRACE_MS}, so paid access runs
 * without a gap from one charge to the next. Stretched by at most
 * {@link MAX_EXTRA_DAYS}.
 */
export function chargeCoverDays(input: {
  readonly durationDays: number;
  readonly expiresAt: Date | null;
  readonly nextChargeAt: Date | null;
  readonly now: Date;
}): number {
  if (input.nextChargeAt === null) return input.durationDays;
  const base = Math.max(input.now.getTime(), input.expiresAt?.getTime() ?? 0);
  const reaches = base + input.durationDays * DAY_MS;
  const wanted = input.nextChargeAt.getTime() + CHARGE_GRACE_MS;
  if (reaches >= wanted) return input.durationDays;
  return input.durationDays + Math.min(Math.ceil((wanted - reaches) / DAY_MS), MAX_EXTRA_DAYS);
}

/**
 * Platega's `GET /subscription/{id}`. The status is a word here (`Active`), a
 * number in the list and `SUBSCRIPTION_*` in callbacks; none of those lists is
 * published in full, so an unknown word maps to null and is never read as a
 * cancellation.
 */
export function parsePlategaSubscription(data: unknown): ProviderSubscriptionState {
  const outer = asRecord(data);
  const root =
    outer['status'] === undefined && outer['chargeMetrics'] === undefined ? asRecord(outer['data']) : outer;
  const metrics = asRecord(root['chargeMetrics']);
  const rawStatus = root['status'];
  const providerStatus =
    typeof rawStatus === 'string' && rawStatus.length > 0
      ? rawStatus
      : typeof rawStatus === 'number'
        ? String(rawStatus)
        : null;
  return {
    status: mapPlategaSubscriptionStatus(providerStatus),
    providerStatus,
    chargesSuccess: readCount(metrics['chargesSuccess']),
    nextChargeAt: readDate(root['nextChargeAt']) ?? readDate(metrics['nextChargeAt']),
    lastChargeAt: readDate(root['lastChargeAt']) ?? readDate(metrics['lastChargeAt']),
  };
}

export function mapPlategaSubscriptionStatus(value: string | null): ProviderSubscriptionStatus | null {
  const word = (value ?? '')
    .replace(/[^a-z]/gi, '')
    .toUpperCase()
    .replace(/^SUBSCRIPTION/, '');
  switch (word) {
    case 'ACTIVE':
    case 'ACTIVATED':
      return ProviderSubscriptionStatus.ACTIVE;
    case 'PASTDUE':
      return ProviderSubscriptionStatus.PAST_DUE;
    case 'CANCELLED':
    case 'CANCELED':
      return ProviderSubscriptionStatus.CANCELLED;
    case 'FAILED':
      return ProviderSubscriptionStatus.FAILED;
    case 'PENDING':
    case 'CREATED':
    case 'NEW':
      return ProviderSubscriptionStatus.PENDING;
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCount(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
