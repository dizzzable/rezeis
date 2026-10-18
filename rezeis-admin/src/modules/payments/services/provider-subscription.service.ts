import { createHash } from 'node:crypto';

import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
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

import { toBullMqJobId } from '../../../common/queue/bullmq-job-id';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { planNameFromSnapshot, planNamesFromTransactionSnapshot } from '../../../common/utils/plan-snapshot.util';
import {
  AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE,
  AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE,
} from '../../notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { releasePaidTrialClaim } from '../../subscriptions/services/trial-claim-ledger.util';
import { CHECKOUT_LIFETIME_MS } from '../constants/checkout-lifetime.constant';
import type { CabinetView } from '../../reiwa-peers/cabinet-capabilities';
import {
  PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  PROVIDER_SUBSCRIPTION_SYNC_JOB,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../constants/payment-reconciliation.constant';
import { PaymentWebhookEnvelopeInterface } from '../interfaces/payment-webhook-envelope.interface';
import {
  ANTILOPAY_CALL_TIMEOUT_MS,
  ANTILOPAY_NOT_FOUND,
  ANTILOPAY_RECURRENT_NOT_ACTIVE,
  classifyAntilopayPaymentStatus,
  postAntilopay,
} from '../utils/antilopay-api.util';
import { antilopayRefundEnvelope, completedAntilopayRefunds } from '../utils/antilopay-refund.util';
import {
  AURAPAY_API,
  aurapayHeaders,
  parseAurapayInvoice,
  parseAurapaySubscription,
} from '../utils/aurapay-subscription.util';
import {
  type AntilopayAutopayMethod,
  type AntilopayCharge,
  type AntilopayDelay,
  assignAntilopayChargeRoles,
  type AntilopayChargeRole,
  isAntilopayRecurrentEnded,
  isAntilopayRecurrentNotActiveYet,
  parseAntilopayRecurrent,
} from '../utils/antilopay-recurrent.util';
import { decideAntilopayDelay, settleDelayWithConsent, type ShownDelay } from '../utils/antilopay-delay-policy.util';
import {
  DELAY_GRANT_KEY,
  type DelayGrantMark,
  isDelayGrant,
  rewriteItemSnapshotForGrant,
  rewritePlanSnapshotForGrant,
} from '../utils/antilopay-delay-grant.util';
import { isLifetimeSubscription } from '../utils/lifetime-renewal.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import { DISPUTE_EVENT_KEY_MARKER } from '../utils/payment-webhook-auto-retry.util';
import {
  type AutopayRefundOutcome,
  type AutopayRow,
  describeAutopayOutcome,
  NO_AUTOPAY,
  readProviderChargeMarker,
  REFUND_CANCELLED_BY,
  refundEndsAutopay,
  UNKNOWN_AUTOPAY_GATEWAY,
} from '../utils/refund-autopay.util';
import { isTrialConversionSnapshot, isWithheldConversion } from '../utils/trial-conversion.util';
import {
  autopayNotAvailable,
  isChargeDeliveredCheckout,
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
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import { requireSetting } from './payment-provider-execution.helpers';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';

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

/**
 * How recently a refund's cancel still counts as this refund's, for its card:
 * the panel's own refund ends the autopay, and the provider's notice of that
 * same refund arrives seconds later with nothing left to cancel.
 */
const RECENT_REFUND_CANCEL_MS = 60 * 60 * 1000;

/** How many told unmatched disputes a process remembers. */
const UNMATCHED_DISPUTES_REMEMBERED = 1000;

/**
 * How long an Antilopay cancel may take in all, its calls together: less than
 * the 30 s a request gets, with room for the writes around it.
 */
const ANTILOPAY_CANCEL_BUDGET_MS = 24_000;

/** What an Antilopay callback says beside the recurrent it names: its payment and its status. */
export interface RecurrentCallbackHints {
  readonly paymentId: string | null;
  readonly status: string | null;
}

const NO_CALLBACK_HINTS: RecurrentCallbackHints = { paymentId: null, status: null };

/**
 * On the checkout of a charge-delivered SBP sign-up (`deliversOnCharge`): when
 * Antilopay first said the payment of OUR order is paid — the payer confirmed
 * the subscription in their bank. Nothing is delivered for it
 * ({@link ProviderSubscriptionService.holdSignUpStart}); it tells the payment
 * page and the failure notice that the sign-up did start.
 */
export const SIGN_UP_CONFIRMED_KEY = 'autopaySignUpConfirmedAt';

/** On the same checkout: the once-only claim of the notice that its first charge did not come. */
export const UNPAID_SIGN_UP_KEY = 'autopayFirstChargeMissed';

/** The `failureReason` of a checkout whose first SBP charge did not come (a bounded code the cabinet reads). */
export const AUTOPAY_FIRST_CHARGE_FAILED = 'AUTOPAY_FIRST_CHARGE_FAILED';

/** The second look after a confirmed SBP sign-up: past the charge made at activation and its callback. */
const SIGN_UP_SECOND_LOOK_MS = 3 * 60 * 1000;

/** `rawPayload.source` of a Platega subscription dispute in the inbox (`recordDispute`). */
export const PROVIDER_SUBSCRIPTION_DISPUTE = 'PROVIDER_SUBSCRIPTION_DISPUTE';

/** Live rows `cancelStranded` reads at a time; it reads every one of them. */
export const STRANDED_SWEEP_PAGE = 500;

/** A live row as `cancelStranded` reads it: with its customer's block. */
type StrandedCandidate = ProviderSubscription & { readonly user: { readonly isBlocked: boolean } | null };

/**
 * Who asked for a cancel. `REFUND` (`REFUND_CANCELLED_BY`): a full refund of a
 * payment of the subscription — which a charge taken afterwards honours, and
 * the sweep retries until the provider takes it.
 */
export type ProviderSubscriptionCancelledBy = 'CUSTOMER' | 'OPERATOR' | 'SYSTEM' | typeof REFUND_CANCELLED_BY;

/**
 * `cancelledBy` for a cancel an operator asked for from the user's card in the
 * panel («Отменить автосписание»). Written on the live row BEFORE the provider
 * is asked, like a refund's mark, so the sweep finishes a cancel the provider
 * did not take (`STRANDED_BY_OPERATOR`). Unlike a refund's, a charge taken
 * before the cancel lands is the customer's money for the period and renews.
 */
export const OPERATOR_CANCELLED_BY = 'OPERATOR';

/** A live autopay as the user's card in the panel shows it. */
export interface OperatorProviderSubscriptionInterface extends CustomerProviderSubscriptionInterface {
  /** A cancel asked for and still waiting for the provider: from the panel, or by a refund. */
  readonly cancelRequestedBy: typeof OPERATOR_CANCELLED_BY | typeof REFUND_CANCELLED_BY | null;
}

/** A Platega callback that disputes a subscription charge (`isRefundProviderStatus`). */
export interface ProviderSubscriptionChargeback {
  /** The provider's id of the disputed payment, when the callback names one. */
  readonly providerPaymentId: string | null;
  /** The provider's word for it: `CHARGEBACKED`, `REFUNDED`… */
  readonly providerStatus: string;
}

/** What the provider says about one subscription, read with our own keys. */
export interface ProviderSubscriptionState {
  /** Null when the provider used a word we do not know: keep what we had. */
  readonly status: ProviderSubscriptionStatus | null;
  readonly providerStatus: string | null;
  /** Successful charges so far, the first one included. Null when not reported. */
  readonly chargesSuccess: number | null;
  readonly nextChargeAt: Date | null;
  readonly lastChargeAt: Date | null;
  /**
   * The end of the provider's plan of charges, and how many charges it plans
   * in all (Antilopay). Undefined where the provider says nothing of either.
   */
  readonly endsAt?: Date | null;
  readonly plannedChargeCount?: number | null;
  /**
   * Every payment money moved for, oldest first, each keyed by the provider's
   * own payment id (Antilopay). Where this is given it IS the ledger, in place
   * of the count above: a charge is delivered under its payment's key, so a
   * list that changes shape between two looks can neither skip a charge nor
   * deliver one twice.
   */
  readonly charges?: readonly AntilopayCharge[];
  /**
   * When the first payment was paid (AuraPay): its status names no charges, so
   * the first one is known from this and every later one only from the
   * callback that names its invoice. Undefined for every other provider.
   */
  readonly activatedAt?: Date | null;
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
  /** When the provider's plan of charges ends (Antilopay); null when it names no end. */
  readonly endsAt: string | null;
  /** How many charges the provider plans in all, the first included (Antilopay). */
  readonly plannedChargeCount: number | null;
  /** CARD or SBP where the gateway offers both (Antilopay). */
  readonly method: string | null;
  /**
   * While an SBP subscription with a delayed first charge is in its delay (the
   * plan is granted, nothing was charged yet): when the delay ends and the first
   * charge comes, the provider's date when it names one. Null otherwise.
   */
  readonly delayEndsAt: string | null;
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
  /** Unmatched disputes this process has told the operator about; see {@link handleChargeback}. */
  private readonly unmatchedDisputesTold = new Set<string>();
  /** Antilopay recurrents whose paid charge nothing could place, told once; see {@link tellUnplacedRecurrentCharge}. */
  private readonly unplacedRecurrentsTold = new Set<string>();
  /** AuraPay charges that seem taken and were never delivered, told once; see {@link tellMissedAurapayCharge}. */
  private readonly missedAurapayChargesTold = new Set<string>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
    /** The operator's card for a chargeback that matches no payment. Last and optional: specs build this positionally. */
    @Optional()
    private readonly systemEvents?: SystemEventsService,
    /**
     * Switches off the user's ЮKassa saved-card autopay for a chargeback that
     * matches no payment (a matched one goes through the reversal, which does
     * it). Optional for the same reason.
     */
    @Optional()
    private readonly savedPaymentMethods?: SavedPaymentMethodService,
    /** The customer's notice that the first SBP charge did not come ({@link settleUnpaidSignUp}). Optional for the same reason. */
    @Optional()
    private readonly userNotifications?: UserNotificationsService,
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
    /** The charge a callback said was paid, where only the callback names it (AuraPay's invoice). */
    providerChargeId: string | null = null,
  ): Promise<void> {
    await runPaymentReconciliationEnqueueWithTimeout(() =>
      this.paymentReconciliationQueue.add(
        PROVIDER_SUBSCRIPTION_SYNC_JOB,
        { gatewayType, providerSubscriptionId, ...(providerChargeId === null ? {} : { providerChargeId }) },
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

  /**
   * Queues a look at the Antilopay subscription a callback names by its
   * `recurrent_id`. The callback of a charge names the recurrent and an
   * `order_id` Antilopay made up; the first callback of a sign-up names the
   * recurrent and OUR order, which is what links the two (`findAntilopayRow`).
   */
  public async enqueueRecurrentSync(
    gatewayType: PaymentGatewayType,
    providerRecurrentId: string,
    orderId: string | null = null,
    hints: RecurrentCallbackHints = NO_CALLBACK_HINTS,
  ): Promise<void> {
    await runPaymentReconciliationEnqueueWithTimeout(() =>
      this.paymentReconciliationQueue.add(
        PROVIDER_SUBSCRIPTION_SYNC_JOB,
        {
          gatewayType,
          providerRecurrentId,
          ...(orderId === null ? {} : { orderId }),
          ...(hints.paymentId === null ? {} : { paymentId: hints.paymentId }),
          ...(hints.status === null ? {} : { status: hints.status }),
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      ),
    );
  }

  public async syncByRecurrent(
    gatewayType: PaymentGatewayType,
    providerRecurrentId: string,
    orderId: string | null,
    hints: RecurrentCallbackHints = NO_CALLBACK_HINTS,
  ): Promise<void> {
    if (gatewayType !== PaymentGatewayType.ANTILOPAY) {
      throw new Error(`No recurrent lookup for ${gatewayType}`);
    }
    const row = await this.findAntilopayRow(providerRecurrentId, orderId);
    if (row === null) {
      // Not one of ours: another integration on the same Antilopay project, or
      // a sign-up whose checkout is gone. Nothing here may charge for it — but a
      // charge that was TAKEN is money nobody delivered, and the log line alone
      // never reached anyone: it is one card, once per recurrent.
      this.logger.warn(`Callback for unknown ${gatewayType} recurrent ${providerRecurrentId}; ignored`);
      if (hints.status === 'SUCCESS') this.tellUnplacedRecurrentCharge(providerRecurrentId, hints.paymentId);
      return;
    }
    await this.syncRow(row);
  }

  /**
   * One operator card for a paid Antilopay charge that names a recurrent no
   * sign-up of ours holds (`payment.autopay_attention`). Once per recurrent per
   * process: Antilopay repeats a callback for an hour, and every later charge of
   * the same subscription would only repeat the card.
   */
  private tellUnplacedRecurrentCharge(providerRecurrentId: string, providerPaymentId: string | null): void {
    if (this.unplacedRecurrentsTold.has(providerRecurrentId)) return;
    this.unplacedRecurrentsTold.add(providerRecurrentId);
    if (this.unplacedRecurrentsTold.size > UNMATCHED_DISPUTES_REMEMBERED) {
      const oldest = this.unplacedRecurrentsTold.values().next().value;
      if (oldest !== undefined) this.unplacedRecurrentsTold.delete(oldest);
    }
    this.systemEvents?.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_ATTENTION,
      'PAYMENT',
      'Списание по автоплатежу Antilopay принято, но подписка не найдена: выдачи не было',
      {
        gatewayType: PaymentGatewayType.ANTILOPAY,
        reason: 'UNPLACED_RECURRENT_CHARGE',
        providerRecurrentId,
        ...(providerPaymentId === null ? {} : { providerPaymentId }),
        needsManualReview: true,
        note:
          'Antilopay сообщила об успешном списании по подписке, которой нет в панели, и ничего не выдано. ' +
          `Найдите подписку ${providerRecurrentId}` +
          (providerPaymentId === null ? '' : ` и платёж ${providerPaymentId}`) +
          ' в личном кабинете Antilopay. Если это ваш подписчик, откройте «Пользователи» → этот клиент → ' +
          'вкладка «Подписки», продлите подписку вручную и при необходимости верните деньги в Antilopay. ' +
          'Если подписка оформлена не через панель (другая интеграция на том же проекте), карточку можно не учитывать.',
      },
    );
  }

  /**
   * The row an Antilopay recurrent belongs to.
   *
   *  1. by the recurrent's id, once a look has linked it;
   *  2. by OUR order, for the first callback of a sign-up: it names both, and
   *     the row is the one whose first payment that order is;
   *  3. by asking Antilopay about each sign-up not yet linked (`payment/check`
   *     by its first payment names its recurrent), for a callback whose order
   *     is Antilopay's own — an SBP subscription's first charge, or a first
   *     callback that was lost;
   *  4. by the orders Antilopay lists for the recurrent itself
   *     (`payment/recurrent/check` names each payment's `order_id`): one of
   *     them is OUR order when the sign-up started here, which finds it even
   *     when the first payment carries no recurrent id yet.
   *
   * Null for a recurrent that is none of ours.
   */
  private async findAntilopayRow(providerRecurrentId: string, orderId: string | null): Promise<ProviderSubscription | null> {
    const gatewayType = PaymentGatewayType.ANTILOPAY;
    const known = await this.prismaService.providerSubscription.findUnique({
      where: { gatewayType_providerRecurrentId: { gatewayType, providerRecurrentId } },
    });
    if (known !== null) return known;
    if (orderId !== null) {
      const transaction = await this.prismaService.transaction.findUnique({ where: { paymentId: orderId } });
      if (transaction !== null && transaction.gatewayType === gatewayType) {
        const linked = await this.linkAntilopayCheckout(transaction, providerRecurrentId);
        if (linked !== null) return linked;
      }
    }
    const gateway = await this.prismaService.paymentGateway.findUnique({ where: { type: gatewayType } });
    if (gateway === null) return null;
    const settings = readGatewaySettings(gateway.settings);
    const candidates = await this.prismaService.providerSubscription.findMany({
      where: {
        gatewayType,
        providerRecurrentId: null,
        status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] },
        createdAt: { gt: new Date(Date.now() - 3 * DAY_MS) },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    for (const candidate of candidates) {
      if ((await this.resolveAntilopayRecurrentId(candidate, settings)) === providerRecurrentId) {
        return (
          (await this.prismaService.providerSubscription.findUnique({ where: { id: candidate.id } })) ?? {
            ...candidate,
            providerRecurrentId,
          }
        );
      }
    }
    return this.findAntilopayRowByListedOrders(providerRecurrentId, settings);
  }

  /**
   * The sign-up whose order Antilopay lists among a recurrent's payments. The
   * last resort of {@link findAntilopayRow}: one more question to Antilopay,
   * asked only for a callback nothing else could place — which is also every
   * callback of another integration on the same project, so it stays one call.
   */
  private async findAntilopayRowByListedOrders(
    providerRecurrentId: string,
    settings: Record<string, unknown>,
  ): Promise<ProviderSubscription | null> {
    const reply = await postAntilopay(this.httpService, settings, 'payment/recurrent/check', {
      recurrent_id: providerRecurrentId,
    });
    if (reply.code === ANTILOPAY_NOT_FOUND) return null;
    if (reply.code !== 0) {
      throw new Error(`Antilopay payment/recurrent/check error ${reply.code}: ${antilopayErrorText(reply.data)}`);
    }
    const payments = Array.isArray(reply.data['payments']) ? (reply.data['payments'] as unknown[]) : [];
    const orderIds = payments
      .map((entry) => asRecord(entry)['order_id'])
      .filter((orderId): orderId is string => typeof orderId === 'string' && orderId.length > 0);
    if (orderIds.length === 0) return null;
    const transaction = await this.prismaService.transaction.findFirst({
      where: { paymentId: { in: orderIds }, gatewayType: PaymentGatewayType.ANTILOPAY },
    });
    return transaction === null ? null : this.linkAntilopayCheckout(transaction, providerRecurrentId);
  }

  /**
   * Links a checkout's sign-up to the recurrent its callback named. The row is
   * adopted from the checkout's own terms when `recordCheckout` lost its write.
   * Never over a recurrent already linked to another id: two ids for one
   * sign-up is a mix-up to look at, not to settle.
   */
  private async linkAntilopayCheckout(
    transaction: Transaction,
    providerRecurrentId: string,
  ): Promise<ProviderSubscription | null> {
    let row = await this.prismaService.providerSubscription.findUnique({
      where: { firstTransactionId: transaction.id },
    });
    if (row === null) {
      const terms = readProviderSubscriptionTerms(transaction.planSnapshot);
      const gatewayId = transaction.gatewayId;
      if (terms === null || gatewayId === null || gatewayId.length === 0 || CREATION_CLAIM_PLACEHOLDER.test(gatewayId)) {
        return null;
      }
      try {
        row = await this.createRow(transaction, gatewayId, terms);
      } catch (error: unknown) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
        row = await this.prismaService.providerSubscription.findUnique({ where: { firstTransactionId: transaction.id } });
      }
      if (row === null) return null;
    }
    if (row.providerRecurrentId === providerRecurrentId) return row;
    if (row.providerRecurrentId !== null) {
      this.logger.error(
        `Antilopay callback names recurrent ${providerRecurrentId} for order ${transaction.paymentId}, ` +
          `but its sign-up ${row.id} is linked to ${row.providerRecurrentId}; left alone`,
      );
      return null;
    }
    return this.linkAntilopayRecurrent(row, providerRecurrentId);
  }

  /** Writes `providerRecurrentId` once; the row as it is after. Null when another row holds that id. */
  private async linkAntilopayRecurrent(
    row: ProviderSubscription,
    providerRecurrentId: string,
  ): Promise<ProviderSubscription | null> {
    try {
      await this.prismaService.providerSubscription.updateMany({
        where: { id: row.id, providerRecurrentId: null },
        data: { providerRecurrentId },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.error(`Antilopay recurrent ${providerRecurrentId} is linked to another sign-up already; ${row.id} left alone`);
        return null;
      }
      throw error;
    }
    return (
      (await this.prismaService.providerSubscription.findUnique({ where: { id: row.id } })) ?? {
        ...row,
        providerRecurrentId,
      }
    );
  }

  /**
   * The Antilopay recurrent of a sign-up, asked of Antilopay when no callback
   * has told us yet: the sign-up's first payment (by our order id) names it in
   * `payment/check`. Null while it does not — the payer has not paid, or
   * Antilopay has no recurrent to name for that payment yet.
   */
  private async resolveAntilopayRecurrentId(
    row: ProviderSubscription,
    settings: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string | null> {
    if (row.providerRecurrentId !== null) return row.providerRecurrentId;
    const first = await this.prismaService.transaction.findUnique({
      where: { id: row.firstTransactionId },
      select: { paymentId: true },
    });
    if (first === null) return null;
    const reply = await postAntilopay(
      this.httpService,
      settings,
      'payment/check',
      { order_id: first.paymentId },
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    if (reply.code === ANTILOPAY_NOT_FOUND) return null;
    if (reply.code !== 0) {
      throw new Error(`Antilopay payment/check error ${reply.code}: ${antilopayErrorText(reply.data)}`);
    }
    const recurrentId = reply.data['recurrent_id'];
    if (typeof recurrentId !== 'string' || recurrentId.trim().length === 0) return null;
    const linked = await this.linkAntilopayRecurrent(row, recurrentId.trim());
    return linked === null ? null : recurrentId.trim();
  }

  public async sync(
    gatewayType: PaymentGatewayType,
    providerSubscriptionId: string,
    /** The charge a callback said was paid (AuraPay's invoice); see {@link applyAurapayCharges}. */
    providerChargeId: string | null = null,
  ): Promise<void> {
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
    await this.syncRow(row, providerChargeId);
  }

  public async syncRow(row: ProviderSubscription, providerChargeId: string | null = null): Promise<void> {
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
    let lastChargeAt = state.lastChargeAt;
    // A subscription signed up with a delay is given its plan the moment it is
    // active — before any charge, which renews what the grant created.
    if (state.charges !== undefined && (await this.grantsDelayNow(row, state))) {
      await this.ensureDelayGrant(row, state.nextChargeAt);
    }
    if (row.gatewayType === PaymentGatewayType.AURAPAY) {
      const delivered = await this.applyAurapayCharges(row, state, providerChargeId, gateway.settings);
      subscriptionId = delivered.subscriptionId;
      lastChargeAt = delivered.lastChargeAt;
    } else if (state.charges !== undefined) {
      // Antilopay: each charge is delivered under its own payment's id.
      subscriptionId = await this.applyKeyedCharges(row, state.charges, state.nextChargeAt);
    } else if (row.userId === null && state.chargesSuccess !== null && state.chargesSuccess > applied) {
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
    // Where charges were delivered one by one (Antilopay), a refunded one may
    // have cancelled this row during the look (`handleKeyedDispute`): the row is
    // read again, so that cancel is the state this look decides on, not undone.
    const current =
      state.charges === undefined
        ? row
        : ((await this.prismaService.providerSubscription.findUnique({ where: { id: row.id } })) ?? row);
    // A cancellation the panel made, or a failure the provider reported, is
    // final here: a provider still answering «Active» a moment after a cancel
    // must not bring the row back. A charge it takes anyway was still applied
    // above — money taken is always delivered.
    const status =
      current.status === ProviderSubscriptionStatus.CANCELLED || current.status === ProviderSubscriptionStatus.FAILED
        ? current.status
        : (state.status ?? current.status);
    const providerCancelled =
      status === ProviderSubscriptionStatus.CANCELLED && current.cancelledAt === null;
    await this.prismaService.providerSubscription.update({
      where: { id: row.id },
      data: {
        status,
        providerStatus: state.providerStatus,
        nextChargeAt: state.nextChargeAt,
        lastChargeAt,
        lastSyncedAt: new Date(),
        ...(state.endsAt === undefined ? {} : { endsAt: state.endsAt }),
        ...(state.plannedChargeCount === undefined ? {} : { plannedChargeCount: state.plannedChargeCount }),
        ...(subscriptionId !== null && row.subscriptionId === null ? { subscriptionId } : {}),
        ...(providerCancelled ? { cancelledAt: new Date() } : {}),
      },
    });
    if (providerCancelled) {
      // Cancelled without the panel asking — the payer used the link in the
      // provider's email — and the provider does not say who. Or a refund's
      // cancel the provider could not be reached for, which the operator then
      // finished in the provider's dashboard as the card told them to: that
      // row keeps the refund's mark (`recordCancelledBy`).
      await this.recordCancelledBy(current, 'PROVIDER');
    }
    if (state.charges !== undefined) {
      await this.settleUnpaidSignUp(
        { ...current, status, cancelledBy: providerCancelled ? (current.cancelledBy ?? 'PROVIDER') : current.cancelledBy },
        state,
      );
    }
  }

  /**
   * An Antilopay SBP sign-up delivered by its first charge (`deliversOnCharge`)
   * whose first charge did not come, and nothing was delivered for it:
   *
   *  - Antilopay reports the attempt failed (`ACTIVE_FAILED`), or ended the
   *    subscription after failed attempts (`ERROR`);
   *  - or the subscription ended at Antilopay after the payer confirmed it —
   *    cancelled in the bank, or by Antilopay. A cancel the panel made (the
   *    customer's «Отключить автосписание», the operator's, a refund's, the
   *    sweep's) is not: whoever asked for it knows.
   *
   * The owner's rules (18.10.2026): no access until the first charge, and
   * «Клиенту и оператору»: the customer is told the charge did not go through,
   * with the way to pay, and the operator gets the «Платёж не прошёл» card with
   * the customer and the plan. Once per sign-up: the claim is a key on the
   * checkout written only while it is absent (`onlyIfAbsent`), so a look every
   * few minutes, the callback repeated for an hour and the daily run tell it
   * once between them. A checkout still waiting is FAILED with it, so the
   * payment page says so; the first charge, if Antilopay still makes it, revives
   * it and delivers the plan as for any late payment.
   */
  private async settleUnpaidSignUp(
    row: ProviderSubscription,
    state: ProviderSubscriptionState,
  ): Promise<void> {
    if (row.gatewayType !== PaymentGatewayType.ANTILOPAY || row.method !== 'SBP' || row.userId === null) return;
    const ended = row.status === ProviderSubscriptionStatus.CANCELLED;
    const providerWord = (state.providerStatus ?? '').toUpperCase();
    const failed = providerWord === 'ACTIVE_FAILED' || providerWord === 'ERROR';
    const endedAtProvider = ended && (row.cancelledBy === null || row.cancelledBy === 'PROVIDER');
    if (!failed && !endedAtProvider) return;
    const first = await this.prismaService.transaction.findUnique({ where: { id: row.firstTransactionId } });
    if (first === null || !isChargeDeliveredCheckout(first)) return;
    if (first.status === TransactionStatus.COMPLETED && first.fulfilledAt !== null) return;
    if (!failed) {
      // Ended without a failed charge: only a sign-up the payer had confirmed
      // (its start listed, or Antilopay's notice of it held) is one that did
      // not get paid. One abandoned on the payment form never started.
      const startListed = (state.charges ?? []).some(
        (charge) => charge.id === row.providerSubscriptionId || charge.orderId === first.paymentId,
      );
      if (!startListed && asRecord(first.gatewayData)[SIGN_UP_CONFIRMED_KEY] === undefined) return;
    }
    const at = new Date();
    const claimed = await writeTransactionGatewayData(this.prismaService, first.id, {
      merge: {
        [UNPAID_SIGN_UP_KEY]: { providerStatus: state.providerStatus, at: at.toISOString() },
      },
      onlyIfAbsent: UNPAID_SIGN_UP_KEY,
    });
    if (claimed !== 1) return;
    if (first.status === TransactionStatus.PENDING) {
      await this.prismaService.$transaction(async (db) => {
        const written = await writeTransactionGatewayData(db, first.id, {
          status: TransactionStatus.FAILED,
          onlyIfStatus: TransactionStatus.PENDING,
          merge: { failureReason: AUTOPAY_FIRST_CHARGE_FAILED },
        });
        if (written === 1) await releasePaidTrialClaim(db, first.id, 'PROVIDER_TERMINAL_FAILED');
      });
    }
    const planName = planNameFromSnapshot(first.planSnapshot);
    const amount = row.amount.toString();
    this.logger.warn(
      `Antilopay SBP sign-up ${row.id} (${row.providerSubscriptionId}) got no first charge ` +
        `(${state.providerStatus ?? 'no status'}); checkout ${first.paymentId} not delivered, customer and operator told`,
    );
    // A sign-up that would have made the subscription offers to buy it again;
    // one for a subscription the customer has offers to renew that one.
    const createsSubscription = first.purchaseType === PurchaseType.NEW || first.purchaseType === PurchaseType.ADDITIONAL;
    const subscriptionId = row.subscriptionId ?? first.subscriptionId;
    if (this.userNotifications !== undefined) {
      try {
        await this.userNotifications.create({
          userId: row.userId,
          type: createsSubscription ? AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE : AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE,
          payload: {
            plan: planName ?? '',
            amount,
            paymentId: first.paymentId,
            ...(createsSubscription || subscriptionId === null ? {} : { subscriptionId }),
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          `Sign-up ${row.id}: the customer was not told the first charge did not come: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.systemEvents?.warn(EVENT_TYPES.PAYMENT_FAILED, 'PAYMENT', `Автосписание не прошло: ${first.purchaseType}`, {
      userId: row.userId,
      paymentId: first.paymentId,
      ...planNamesFromTransactionSnapshot(first.planSnapshot),
      gatewayType: row.gatewayType,
      amount,
      currency: row.currency,
      providerSubscriptionId: row.providerSubscriptionId,
      providerStatus: state.providerStatus,
      autopayFirstChargeFailed: true,
      note:
        'Первое списание по автоплатежу СБП (Antilopay) не прошло, и тариф клиенту не выдан. ' +
        'Клиенту отправлено уведомление с кнопкой оплаты. Если Antilopay всё же спишет позже, тариф выдастся сам.',
    });
  }

  /**
   * Delivers every charge an Antilopay recurrent lists, each under the id of
   * ITS payment: the RENEW payment made for it and the paid notice for that
   * payment are keyed by `payment_id`, never by the charge's position. The
   * count above the row's `appliedChargeCount` is not what decides what is
   * new, so a list that a look reads differently from the last — a payment
   * that was pending and succeeded, a retry after a failure — can neither skip
   * a charge nor pay one twice: a look that has nothing new finds every
   * payment's row and notice already there and settles nothing.
   *
   * WHICH charge completes the checkout the payer started is decided by what
   * each charge is (`assignAntilopayChargeRoles`): the initiating payment, or
   * the payment of our order, and for SBP the charge made at activation — never
   * by position, which gave the first scheduled charge to a checkout already
   * delivered, or two terms to one charge. Every other charge renews under its
   * own payment id. A charge given back afterwards (CHARGEBACK, REVERSED) is not
   * delivered, and its refund ends the autopay (`handleKeyedDispute`).
   *
   * Returns the subscription the charges renew, once the first has made one.
   */
  private async applyKeyedCharges(
    row: ProviderSubscription,
    charges: readonly AntilopayCharge[],
    nextChargeAt: Date | null,
  ): Promise<string | null> {
    let applied = row.appliedChargeCount;
    let subscriptionId = row.subscriptionId;
    const firstTransaction = await this.prismaService.transaction.findUnique({
      where: { id: row.firstTransactionId },
    });
    // Since 18.10.2026 an SBP sign-up is delivered by its first charge, delayed
    // or not; one drafted before keeps the rules it was made with.
    const deliversOnCharge = firstTransaction !== null && isChargeDeliveredCheckout(firstTransaction);
    const roles = assignAntilopayChargeRoles({
      charges,
      providerSubscriptionId: row.providerSubscriptionId,
      firstOrderId: firstTransaction?.paymentId ?? null,
      method: row.method,
      signedUpAt: row.createdAt,
      firstDelivered:
        firstTransaction !== null &&
        firstTransaction.status === TransactionStatus.COMPLETED &&
        firstTransaction.fulfilledAt !== null,
      // No charge is made at activation of a delayed subscription: the checkout
      // is the grant, and every charge there is renews it.
      delayed: (row.delayDays ?? 0) > 0 && !deliversOnCharge,
      deliversOnCharge,
    });
    // The number a charge carries on its renewal and its notice is informational
    // (the keys are payment ids): the start of an SBP subscription takes none.
    let chargeNumber = 0;
    for (const charge of charges) {
      const role = roles.get(charge.id) ?? 'RENEW';
      if (role === 'START' && !charge.disputed) continue;
      if (role !== 'START') chargeNumber += 1;
      if (charge.disputed && role === 'START' && deliversOnCharge) {
        // The start of such a sign-up delivered nothing and holds no money, so
        // nothing is given back for it; a start undone still ends the autopay.
        await this.cancelLive({ ids: [row.id] }, REFUND_CANCELLED_BY);
        continue;
      }
      if (charge.disputed) {
        await this.handleKeyedDispute(row, charge, role);
        continue;
      }
      if (row.userId === null) {
        // Charged after the account was deleted: there is nobody to deliver to,
        // and only an operator can return the money. The sweep cancels the row.
        if (chargeNumber > applied) {
          this.logger.error(
            `Subscription ${row.id} (${row.gatewayType} ${row.providerSubscriptionId}) was charged after its ` +
              `account was deleted (payment ${charge.id}); refund at the provider`,
          );
        }
        continue;
      }
      if (charge.amount !== null && !new Prisma.Decimal(charge.amount).equals(row.amount)) {
        this.logger.warn(
          `Antilopay charge ${charge.id} of ${row.id} was made for ${charge.amount}, not the ${row.amount.toString()} ` +
            'the payer agreed to; delivered as a renewal all the same, the money is taken',
        );
      }
      const transaction =
        role === 'FIRST'
          ? firstTransaction
          : await this.findOrCreateChargeTransaction(
              { ...row, subscriptionId: (subscriptionId ??= await this.resolveSubscriptionId(row)) },
              chargeNumber,
              nextChargeAt,
              charge.id,
            );
      if (transaction === null && role === 'FIRST') {
        // The checkout this charge belongs to is gone: nothing to deliver, and
        // nothing that another look would change.
        this.logger.warn(`Charge ${charge.id} of subscription ${row.id} has no checkout to complete`);
        continue;
      }
      if (transaction === null) {
        // A later charge renews the subscription the first one created; until
        // that first delivery lands there is nothing to renew.
        this.logger.warn(`Charge ${charge.id} of subscription ${row.id} is waiting for its first delivery`);
        await this.enqueueSync(row.gatewayType, row.providerSubscriptionId, 60_000);
        break;
      }
      await this.enqueueSettlement(row, chargeNumber, transaction, charge.id);
      if (chargeNumber > applied) {
        await this.prismaService.providerSubscription.updateMany({
          where: { id: row.id, appliedChargeCount: { lt: chargeNumber } },
          data: { appliedChargeCount: chargeNumber },
        });
        applied = chargeNumber;
      }
      // A refund made at Antilopay after the day of the charge is listed beside
      // it (a scheduled charge's is in the recurrent's `payments[]`, and the
      // payment check cannot ask about an order id Antilopay made up). Settled
      // only against a charge that is delivered: before that it would cancel a
      // payment about to be fulfilled, which the fulfilment then revives.
      if (transaction.status === TransactionStatus.COMPLETED && transaction.fulfilledAt !== null) {
        for (const refund of completedAntilopayRefunds(charge.refunds)) {
          await this.enqueueNotice(
            antilopayRefundEnvelope({
              paymentId: transaction.paymentId,
              providerPaymentId: charge.id,
              refund,
              currency: row.currency,
            }),
          );
        }
      }
    }
    return subscriptionId;
  }

  /**
   * Delivers what AuraPay was paid for a subscription. Its status lists no
   * charges, so:
   *
   *  - the FIRST payment is known from the status: `activated_at` is set once
   *    it is paid (`ACTIVATED`), and it completes the checkout the payer
   *    started — under the same key as the first charge of every other
   *    provider, so its own invoice callback down the ordinary pipeline and
   *    this look settle it once between them;
   *  - every LATER charge only from the callback that names its invoice
   *    (`providerChargeId`, the event's documented key): the invoice is read
   *    back, must be PAID, and becomes one RENEW payment keyed by the invoice,
   *    so a repeated callback, the event and the invoice callback of one charge,
   *    or a crash half-way, deliver it once.
   *
   * A charge whose callback never arrived is not in anything AuraPay lists;
   * {@link tellMissedAurapayCharge} tells the operator instead.
   */
  private async applyAurapayCharges(
    row: ProviderSubscription,
    state: ProviderSubscriptionState,
    providerChargeId: string | null,
    settingsJson: Prisma.JsonValue,
  ): Promise<{ readonly subscriptionId: string | null; readonly lastChargeAt: Date | null }> {
    let applied = row.appliedChargeCount;
    let subscriptionId = row.subscriptionId;
    let lastChargeAt = row.lastChargeAt;
    const firstTransaction = await this.prismaService.transaction.findUnique({
      where: { id: row.firstTransactionId },
    });
    const settleFirst = async (paidAt: Date | null): Promise<void> => {
      if (applied >= 1) return;
      if (row.userId === null) {
        this.logger.error(
          `Subscription ${row.id} (AURAPAY ${row.providerSubscriptionId}) was paid after its account was deleted; ` +
            'refund at the provider',
        );
        return;
      }
      if (firstTransaction === null) {
        this.logger.warn(`The first payment of subscription ${row.id} has no checkout to complete`);
        return;
      }
      await this.enqueueSettlement(row, 1, firstTransaction);
      await this.prismaService.providerSubscription.updateMany({
        where: { id: row.id, appliedChargeCount: { lt: 1 } },
        data: { appliedChargeCount: 1 },
      });
      applied = 1;
      lastChargeAt = paidAt ?? new Date();
    };

    if (state.activatedAt !== undefined && state.activatedAt !== null) {
      await settleFirst(state.activatedAt);
    }

    if (providerChargeId !== null) {
      const invoice = await this.readAurapayInvoice(providerChargeId, readGatewaySettings(settingsJson));
      if (invoice === null) {
        this.logger.warn(`AuraPay has no invoice ${providerChargeId} (subscription ${row.id}); nothing delivered`);
      } else if (invoice.status !== 'PAID') {
        this.logger.warn(
          `AuraPay invoice ${providerChargeId} of subscription ${row.id} is ${invoice.status ?? 'unreadable'}, ` +
            'not PAID; nothing delivered',
        );
      } else if (firstTransaction !== null && invoice.orderId === firstTransaction.paymentId) {
        // The first payment's own invoice, named before the status says active.
        await settleFirst(null);
      } else if (row.userId === null) {
        this.logger.error(
          `Subscription ${row.id} (AURAPAY ${row.providerSubscriptionId}) was charged after its account was ` +
            `deleted (invoice ${providerChargeId}); refund at the provider`,
        );
      } else {
        if (invoice.amount !== null && !new Prisma.Decimal(invoice.amount).equals(row.amount)) {
          this.logger.warn(
            `AuraPay charge ${providerChargeId} of ${row.id} was made for ${invoice.amount}, not the ` +
              `${row.amount.toString()} the payer agreed to; delivered as a renewal all the same, the money is taken`,
          );
        }
        const transaction = await this.findOrCreateChargeTransaction(
          { ...row, subscriptionId: (subscriptionId ??= await this.resolveSubscriptionId(row)) },
          applied + 1,
          state.nextChargeAt,
          providerChargeId,
        );
        if (transaction === null) {
          // A later charge renews the subscription the first one created; until
          // that first delivery lands there is nothing to renew. The callback
          // will not come again, so this look books its own, with the invoice.
          this.logger.warn(`Charge ${providerChargeId} of subscription ${row.id} is waiting for its first delivery`);
          await this.enqueueSync(row.gatewayType, row.providerSubscriptionId, 60_000, providerChargeId);
        } else {
          // The number a charge carries is the one its payment was made with: a
          // second look at the same invoice, after the count moved on, must not
          // queue its notice under another body.
          const chargeNumber = readChargeNumber(transaction.gatewayData) ?? applied + 1;
          await this.enqueueSettlement(row, chargeNumber, transaction, providerChargeId);
          if (chargeNumber > applied) {
            await this.prismaService.providerSubscription.updateMany({
              where: { id: row.id, appliedChargeCount: { lt: chargeNumber } },
              data: { appliedChargeCount: chargeNumber },
            });
            applied = chargeNumber;
          }
          lastChargeAt = new Date();
        }
      }
    }

    await this.tellMissedAurapayCharge(row, state, subscriptionId ?? (await this.resolveSubscriptionId(row)), lastChargeAt);
    return { subscriptionId, lastChargeAt };
  }

  /** `POST /invoice/status` by AuraPay's invoice id; null when AuraPay has none. */
  private async readAurapayInvoice(
    invoiceId: string,
    settings: Record<string, unknown>,
  ): Promise<ReturnType<typeof parseAurapayInvoice>> {
    const response = await firstValueFrom(
      this.httpService.post(
        `${AURAPAY_API}/invoice/status`,
        { id: invoiceId },
        { headers: aurapayHeaders(settings), validateStatus: (status: number) => status === 200 || status === 404 },
      ),
    );
    return response.status === 404 ? null : parseAurapayInvoice(response.data);
  }

  /**
   * One operator card for an AuraPay charge that seems taken and was never
   * delivered: the subscription is active, its access ends within half a day,
   * and AuraPay's next charge is more than half a period after that end. Each
   * charge moves `next_pay_at` a period on and its delivery moves the access
   * the same, so the two only drift apart this far when a charge was taken
   * whose callback never reached the panel (AuraPay tries five times) — or when
   * an operator cut the subscription short. Nothing is delivered on a guess:
   * there is no invoice to key it by, and a callback arriving after would
   * deliver it again. Once per charge date per process.
   */
  private async tellMissedAurapayCharge(
    row: ProviderSubscription,
    state: ProviderSubscriptionState,
    subscriptionId: string | null,
    lastChargeAt: Date | null,
  ): Promise<void> {
    if (state.status !== ProviderSubscriptionStatus.ACTIVE || state.nextChargeAt === null || subscriptionId === null) {
      return;
    }
    const halfPeriodMs = (row.durationDays * DAY_MS) / 2;
    const now = Date.now();
    // A charge delivered lately is still being fulfilled: its access has not moved yet.
    if (lastChargeAt !== null && now - lastChargeAt.getTime() < halfPeriodMs) return;
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { expiresAt: true },
    });
    const expiresAt = subscription?.expiresAt ?? null;
    if (expiresAt === null || expiresAt.getTime() > now + DAY_MS / 2) return;
    if (state.nextChargeAt.getTime() - expiresAt.getTime() <= halfPeriodMs) return;
    const key = `${row.id}:${state.nextChargeAt.toISOString()}`;
    if (this.missedAurapayChargesTold.has(key)) return;
    this.missedAurapayChargesTold.add(key);
    if (this.missedAurapayChargesTold.size > UNMATCHED_DISPUTES_REMEMBERED) {
      const oldest = this.missedAurapayChargesTold.values().next().value;
      if (oldest !== undefined) this.missedAurapayChargesTold.delete(oldest);
    }
    this.logger.error(
      `AuraPay subscription ${row.providerSubscriptionId} (${row.id}) charges next at ${state.nextChargeAt.toISOString()}, ` +
        `but its access ends at ${expiresAt.toISOString()}: a charge seems taken and undelivered`,
    );
    this.systemEvents?.warn(
      EVENT_TYPES.PAYMENT_AUTOPAY_ATTENTION,
      'PAYMENT',
      'AuraPay, похоже, списала по автоплатежу, а уведомление не дошло: подписка не продлена',
      {
        gatewayType: PaymentGatewayType.AURAPAY,
        reason: 'AURAPAY_CHARGE_NOT_DELIVERED',
        providerSubscriptionId: row.providerSubscriptionId,
        subscriptionId,
        ...(row.userId === null ? {} : { userId: row.userId }),
        needsManualReview: true,
        note:
          `Подписка AuraPay ${row.providerSubscriptionId} активна, следующее списание — ` +
          `${state.nextChargeAt.toISOString().slice(0, 10)}, а доступ клиента заканчивается ` +
          `${expiresAt.toISOString().slice(0, 10)}. Так бывает, когда AuraPay списала деньги, а уведомление о списании ` +
          'до панели не дошло. Найдите в личном кабинете AuraPay оплаченные счета этой подписки. Если списание есть, ' +
          'откройте «Пользователи» → этот клиент → вкладка «Подписки» и продлите подписку вручную на срок тарифа. ' +
          'Если оператор сам сокращал подписку, карточку можно не учитывать.',
      },
    );
  }

  /**
   * A charge Antilopay reports as given back (CHARGEBACK, REVERSED): the refund
   * of one of the recurrent's payments. A payment delivered goes through the
   * refund reversal every other refund takes — a notice in the inbox for its
   * own payment, which also ends the autopay (`refundEndsAutopay`). One that was
   * never delivered has nothing to reverse, but its refund ends the autopay all
   * the same, so the row is cancelled with a refund's mark.
   */
  private async handleKeyedDispute(
    row: ProviderSubscription,
    charge: AntilopayCharge,
    role: AntilopayChargeRole,
  ): Promise<void> {
    // The start of a subscription is the first transaction's payment too.
    const transaction =
      role !== 'RENEW'
        ? await this.prismaService.transaction.findUnique({ where: { id: row.firstTransactionId } })
        : row.userId === null
          ? null
          : await this.prismaService.transaction.findUnique({
              where: { userId_idempotencyKey: { userId: row.userId, idempotencyKey: keyedChargeKey(row.id, charge.id) } },
            });
    // The checkout of a delayed subscription is a free grant, not a payment: there
    // is nothing in it to give back, and reversing it would take the payer's days
    // away. Their start being disputed still ends the autopay, like any refund.
    if (transaction !== null && isDelayGrant(transaction.gatewayData)) {
      await this.cancelLive({ ids: [row.id] }, REFUND_CANCELLED_BY);
      return;
    }
    if (transaction !== null && transaction.status === TransactionStatus.COMPLETED && transaction.fulfilledAt !== null) {
      await this.enqueueRefundNotice(row, transaction, {
        providerPaymentId: charge.id,
        providerStatus: charge.providerStatus,
      });
      return;
    }
    await this.cancelLive({ ids: [row.id] }, REFUND_CANCELLED_BY);
  }

  /**
   * Says who cancelled a row — never over a refund's mark (`REFUND_CANCELLED_BY`).
   *
   * A refund marks its rows before it asks the provider, and the mark outlives
   * whoever finishes the cancel: the provider reporting one the operator made
   * in its dashboard, the customer's «Отключить автосписание», a plan change,
   * the sweep. The mark is what withholds a charge the provider took before
   * that cancel (`autopayEndedByRefund`). Written over, the charge renewed the
   * refunded subscription and paid its commission, and nobody was told.
   * Conditional in the statement as well, so a mark written after the row was
   * read is kept too.
   *
   * Best effort: the cancel itself is written by then, and a customer told
   * their autopay failed to stop, when it stopped, would be told wrong.
   */
  private async recordCancelledBy(
    row: Pick<ProviderSubscription, 'id' | 'cancelledBy'>,
    by: string,
  ): Promise<void> {
    if (row.cancelledBy === REFUND_CANCELLED_BY) return;
    try {
      await this.prismaService.providerSubscription.updateMany({
        where: {
          id: row.id,
          OR: [{ cancelledBy: null }, { cancelledBy: { not: REFUND_CANCELLED_BY } }],
        },
        data: { cancelledBy: by },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Provider subscription ${row.id} is cancelled, but who cancelled it (${by}) could not be recorded: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      endsAt: row.endsAt?.toISOString() ?? null,
      plannedChargeCount: row.plannedChargeCount,
      method: row.method,
      delayEndsAt: delayEndsAtOf(row)?.toISOString() ?? null,
    }));
  }

  /**
   * Refuses a second live provider subscription for one VPN subscription: both
   * would charge every period for the same access. A failed one (PAST_DUE) does
   * not block signing up again.
   *
   * `pendingOtherThan` — the checkout asking, when it changes the plan (or
   * converts a trial) — also refuses while another sign-up for the same
   * subscription is still waiting to be confirmed. A plan changes once per
   * payment: two sign-ups confirmed together both moved it, and both kept
   * renewing it. Only a sign-up inside its checkout's lifetime counts, so one
   * the payer walked away from stops blocking when its checkout expires; the
   * asking checkout's own row (a re-tap of the same link) never does.
   *
   * `planChangeTo` — the plan a plan change moves to — lets through a live one
   * on ANOTHER plan: the sweep stops it once the change lands («moved to
   * another plan»), so the two never renew the same plan together. One on the
   * very plan being bought still refuses.
   */
  public async assertNoLiveSubscriptionFor(
    subscriptionId: string | null,
    options: { readonly pendingOtherThan?: string; readonly planChangeTo?: string } = {},
  ): Promise<void> {
    if (subscriptionId === null) return;
    const live = await this.prismaService.providerSubscription.findFirst({
      where: {
        subscriptionId,
        status: ProviderSubscriptionStatus.ACTIVE,
        ...(options.planChangeTo === undefined ? {} : { planId: options.planChangeTo }),
      },
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

  /**
   * Whether this look is the moment to give a delayed subscription its plan: the
   * subscription is active at Antilopay, or money has been taken on it (which
   * only an active one can have), and nobody is left to give it to or has asked
   * for it back. The checkout's expiry, cancel or failure play no part: it is the
   * RECURRENT that says the payer subscribed, and the checkout is revived by the
   * grant if it had lapsed.
   */
  private async grantsDelayNow(row: ProviderSubscription, state: ProviderSubscriptionState): Promise<boolean> {
    if ((row.delayDays ?? 0) <= 0 || row.userId === null) return false;
    // A refund asked for this autopay to end: nothing is given on its way out.
    if (row.cancelledBy === REFUND_CANCELLED_BY) return false;
    const active = state.status === ProviderSubscriptionStatus.ACTIVE || state.status === ProviderSubscriptionStatus.PAST_DUE;
    if (!active && !(state.charges ?? []).some((charge) => !charge.disputed)) return false;
    // «Без доступа на время отсрочки» (the owner, 18.10.2026): a sign-up drafted
    // since then is given nothing before its first charge. A claim already taken
    // is a grant made before, which the look still mends (`ensureDelayGrant`).
    if (row.delayGrantedAt === null) {
      const first = await this.prismaService.transaction.findUnique({
        where: { id: row.firstTransactionId },
        select: { gatewayType: true, planSnapshot: true },
      });
      if (first !== null && isChargeDeliveredCheckout(first)) return false;
    }
    return true;
  }

  /**
   * Gives a delayed subscription its plan, exactly once however often it is seen
   * active (the callback is repeated every three minutes for an hour, the sweep
   * and the payer's return look too): the checkout is rewritten into a free grant
   * in ONE database transaction with the claim on the row
   * (`delay_granted_at`), and its settlement is queued under a key of its own,
   * so a second look finds the claim taken and the settlement already in the
   * inbox. A crash between the two is mended by the next look, which queues the
   * settlement again under the same key.
   */
  private async ensureDelayGrant(row: ProviderSubscription, nextChargeAt: Date | null): Promise<void> {
    // Only a sign-up whose claim is not taken yet opens a transaction for it: the
    // claim, once taken, stays for the life of the row, and every look at a
    // subscription long past its delay would otherwise ask for it again.
    const outcome = row.delayGrantedAt === null ? await this.convertCheckoutToDelayGrant(row, nextChargeAt) : 'ALREADY';
    const first = await this.prismaService.transaction.findUnique({ where: { id: row.firstTransactionId } });
    if (first === null) return;
    if (isDelayGrant(first.gatewayData)) {
      if (!(first.status === TransactionStatus.COMPLETED && first.fulfilledAt !== null)) {
        await this.enqueueDelayGrantSettlement(row, first);
      }
      return;
    }
    if (outcome === 'FULFILLED' && row.delayGrantedAt === null) {
      // The checkout was fulfilled in full before it could be rewritten. The payer
      // has been given their days; the row is marked so that nothing grants again.
      await this.prismaService.providerSubscription.updateMany({
        where: { id: row.id, delayGrantedAt: null },
        data: { delayGrantedAt: new Date() },
      });
    }
  }

  /**
   * Rewrites the checkout of a delayed sign-up into the grant: its sum 0, its
   * term the delay's days (stretched like a renewal's, to reach the provider's
   * first charge), marked `delayGrant`. The claim on the row and every write of
   * the rewrite are one database transaction, so there is never a claim without
   * a grant, nor a grant a second look could write again.
   *
   * 'ALREADY': the claim was taken by an earlier look; 'FULFILLED': the checkout
   * had been fulfilled before the rewrite (nothing is changed, claim included).
   */
  private async convertCheckoutToDelayGrant(
    row: ProviderSubscription,
    nextChargeAt: Date | null,
  ): Promise<'GRANTED' | 'ALREADY' | 'FULFILLED'> {
    const delayDays = row.delayDays ?? 0;
    if (delayDays <= 0) return 'ALREADY';
    const subscription =
      row.subscriptionId === null
        ? null
        : await this.prismaService.subscription.findUnique({
            where: { id: row.subscriptionId },
            select: { expiresAt: true },
          });
    const now = new Date();
    const days = chargeCoverDays({
      durationDays: delayDays,
      expiresAt: subscription?.expiresAt ?? null,
      nextChargeAt,
      now,
    });
    try {
      return await this.prismaService.$transaction(async (db) => {
        const claim = await db.providerSubscription.updateMany({
          where: { id: row.id, delayGrantedAt: null },
          data: { delayGrantedAt: now },
        });
        if (claim.count !== 1) return 'ALREADY' as const;
        const first = await db.transaction.findUnique({ where: { id: row.firstTransactionId } });
        if (first === null) throw new DelayGrantUndone('the checkout of the sign-up is gone');
        if (first.fulfilledAt !== null) {
          throw new DelayGrantUndone(`checkout ${first.paymentId} was fulfilled in full before it could be made the grant`);
        }
        // Read before the sum is rewritten: it is what every later charge will be.
        const originalAmount = first.amount.toString();
        const items = await db.transactionItem.findMany({ where: { transactionId: first.id } });
        if (items.some((item) => item.appliedAt !== null)) {
          throw new DelayGrantUndone(`a line of checkout ${first.paymentId} was applied before it could be made the grant`);
        }
        for (const item of items) {
          await db.transactionItem.update({
            where: { id: item.id },
            data: {
              durationDays: days,
              amount: new Prisma.Decimal(0),
              planSnapshot: rewriteItemSnapshotForGrant(item.planSnapshot, days),
            },
          });
        }
        await db.transaction.update({
          where: { id: first.id },
          data: { amount: new Prisma.Decimal(0), planSnapshot: rewritePlanSnapshotForGrant(first.planSnapshot, days) },
        });
        const mark: DelayGrantMark = {
          providerSubscriptionId: row.providerSubscriptionId,
          delayDays,
          days,
          originalAmount,
          at: now.toISOString(),
        };
        await writeTransactionGatewayData(db, first.id, { merge: { [DELAY_GRANT_KEY]: mark } });
        return 'GRANTED' as const;
      });
    } catch (error: unknown) {
      if (error instanceof DelayGrantUndone) {
        this.logger.error(`Delayed sign-up ${row.id} (${row.providerSubscriptionId}) was not made a grant: ${error.message}`);
        return 'FULFILLED';
      }
      throw error;
    }
  }

  /**
   * The ordinary pipeline is about to fulfil the checkout of a delayed sign-up —
   * Antilopay told the panel the payment of OUR order is paid (a callback, the
   * status sweep): whatever that notice means for money, this checkout is the
   * grant, never the full term. It is rewritten first, by the same claim as a
   * look at the recurrent makes, so whichever arrives first grants and the other
   * finds it done. A row that cannot be found or made holds the fulfilment back
   * (the notice fails and is retried), because the alternative is a full term
   * delivered for a payment that moved no money.
   */
  public async prepareDelayedCheckout(transaction: Transaction): Promise<void> {
    if (transaction.gatewayType !== PaymentGatewayType.ANTILOPAY) return;
    const terms = readProviderSubscriptionTerms(transaction.planSnapshot);
    if (terms === null || terms.delay === undefined) return;
    if (isDelayGrant(transaction.gatewayData)) return;
    let row = await this.prismaService.providerSubscription.findUnique({ where: { firstTransactionId: transaction.id } });
    if (row === null) {
      const gatewayId = transaction.gatewayId;
      if (gatewayId === null || gatewayId.length === 0 || CREATION_CLAIM_PLACEHOLDER.test(gatewayId)) {
        throw new Error(`Delayed checkout ${transaction.paymentId} has no sign-up to grant for yet; retried`);
      }
      try {
        row = await this.createRow(transaction, gatewayId, terms);
      } catch (error: unknown) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
        row = await this.prismaService.providerSubscription.findUnique({ where: { firstTransactionId: transaction.id } });
      }
      if (row === null) throw new Error(`Delayed checkout ${transaction.paymentId} has no sign-up to grant for`);
    }
    if (row.userId === null) return;
    await this.convertCheckoutToDelayGrant(row, row.nextChargeAt);
  }

  /**
   * Antilopay said the payment of OUR order of a charge-delivered SBP sign-up
   * (`deliversOnCharge`) is paid — a callback, or the status sweep's check. That
   * is the payer confirming the subscription in their bank, and no money moved
   * with it: nothing is fulfilled. The notice is acknowledged, the checkout keeps
   * the moment (`SIGN_UP_CONFIRMED_KEY`, for the payment page and the failure
   * notice), and the subscription is looked at — now, and again in a few
   * minutes, for the charge made at activation, which is what delivers the
   * plan (`assignAntilopayChargeRoles`). With a delay, that charge comes after
   * it, and the daily look finds it if its own callback is lost.
   */
  public async holdSignUpStart(transaction: Pick<Transaction, 'id' | 'paymentId' | 'gatewayId'>): Promise<void> {
    await writeTransactionGatewayData(this.prismaService, transaction.id, {
      merge: { [SIGN_UP_CONFIRMED_KEY]: new Date().toISOString() },
      onlyIfAbsent: SIGN_UP_CONFIRMED_KEY,
    });
    const gatewayId = transaction.gatewayId;
    if (gatewayId === null || gatewayId.length === 0 || CREATION_CLAIM_PLACEHOLDER.test(gatewayId)) {
      // No sign-up to look at yet: the callback that said so queued its own look
      // by the recurrent it names, and the sweep finds a sign-up not yet linked.
      this.logger.log(`Antilopay sign-up ${transaction.paymentId} is confirmed; its first charge delivers it`);
      return;
    }
    this.logger.log(`Antilopay sign-up ${transaction.paymentId} is confirmed; waiting for its first charge`);
    await this.enqueueSync(PaymentGatewayType.ANTILOPAY, gatewayId);
    await this.enqueueSync(PaymentGatewayType.ANTILOPAY, gatewayId, SIGN_UP_SECOND_LOOK_MS);
  }

  /**
   * How an Antilopay SBP sign-up stands for the payer on the payment page,
   * while its checkout is not delivered: the subscription is confirmed and its
   * first charge is awaited (at activation, or on the date after the delay), or
   * that charge did not come. Null for every other payment, and for a sign-up
   * the payer has not confirmed yet.
   */
  public async describeSignUpForPayer(
    transaction: Pick<Transaction, 'id' | 'gatewayType' | 'planSnapshot' | 'gatewayData' | 'status' | 'fulfilledAt'>,
  ): Promise<{ readonly state: 'AWAITING_FIRST_CHARGE' | 'FIRST_CHARGE_FAILED'; readonly firstChargeAt: string | null } | null> {
    if (!isChargeDeliveredCheckout(transaction)) return null;
    if (transaction.status === TransactionStatus.COMPLETED && transaction.fulfilledAt !== null) return null;
    const data = asRecord(transaction.gatewayData);
    const row = await this.prismaService.providerSubscription.findUnique({
      where: { firstTransactionId: transaction.id },
      select: { status: true, nextChargeAt: true },
    });
    if (data[UNPAID_SIGN_UP_KEY] !== undefined) {
      return { state: 'FIRST_CHARGE_FAILED', firstChargeAt: null };
    }
    const live = row !== null && (row.status === ProviderSubscriptionStatus.ACTIVE || row.status === ProviderSubscriptionStatus.PAST_DUE);
    if (data[SIGN_UP_CONFIRMED_KEY] === undefined && !live) return null;
    if (row !== null && row.status === ProviderSubscriptionStatus.CANCELLED) return null;
    return { state: 'AWAITING_FIRST_CHARGE', firstChargeAt: row?.nextChargeAt?.toISOString() ?? null };
  }

  /**
   * Queues a look at the sign-up of a checkout the payer is waiting on: one with
   * a delayed first charge, or any SBP sign-up delivered by its first charge.
   * The payer returns from the bank to a page that asks how the payment stands,
   * and the ask is what starts the look (with a delay nothing is paid for
   * Antilopay to call back about; without one, the look finds the charge made at
   * activation even when its callback is late). At most one look every 30
   * seconds per checkout: the job's id carries the half-minute, and BullMQ adds
   * a job id once (built with `toBullMqJobId`, which keeps the colon out of it).
   */
  public async pokeDelayedSignUp(transaction: Pick<Transaction, 'id' | 'gatewayId' | 'planSnapshot'>, now: Date = new Date()): Promise<void> {
    const terms = readProviderSubscriptionTerms(transaction.planSnapshot);
    const gatewayId = transaction.gatewayId;
    if (terms === null || (terms.delay === undefined && terms.deliversOnCharge !== true)) return;
    if (gatewayId === null || gatewayId.length === 0 || CREATION_CLAIM_PLACEHOLDER.test(gatewayId)) return;
    await runPaymentReconciliationEnqueueWithTimeout(() =>
      this.paymentReconciliationQueue.add(
        PROVIDER_SUBSCRIPTION_SYNC_JOB,
        { gatewayType: PaymentGatewayType.ANTILOPAY, providerSubscriptionId: gatewayId },
        {
          jobId: toBullMqJobId('delay-poke', `${transaction.id}:${Math.floor(now.getTime() / 30_000)}`),
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      ),
    );
  }

  /**
   * The grant's settlement, as the ordinary pipeline takes it: a paid notice for
   * the checkout, keyed by the subscription and nothing else, with a payload that
   * never changes between looks, so every look after the first is recognised as
   * the same notice and settles nothing twice.
   */
  private async enqueueDelayGrantSettlement(row: ProviderSubscription, transaction: Transaction): Promise<void> {
    const rawPayload = {
      source: 'PROVIDER_SUBSCRIPTION',
      status: 'CONFIRMED',
      subscriptionId: row.providerSubscriptionId,
      delayGrant: true,
      paymentId: transaction.paymentId,
    };
    await this.enqueueNotice({
      gatewayType: row.gatewayType,
      paymentId: transaction.paymentId,
      providerEventId: `subscription:${row.providerSubscriptionId}:delay-grant`,
      eventStatus: 'CONFIRMED',
      receivedAt: new Date().toISOString(),
      payloadHash: createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex'),
      rawPayload,
    });
  }

  /**
   * Whether this customer has used «Отсрочка первого списания по СБП», or holds
   * one that is being granted: the delay is given once per customer, whatever
   * became of the subscription (cancelled, ended, refunded) — a customer who
   * cancelled during their delay keeps the days and does not get another delay.
   *
   * A sign-up still waiting for its payer does not count: nothing was given, and
   * counting it would refuse the delay to a customer who taps the same link
   * twice. The window this leaves is two links opened and paid together, each
   * granted on its own — a few days of access, which the owner accepted.
   */
  public async hasUsedDelay(userId: string): Promise<boolean> {
    const used = await this.prismaService.providerSubscription.findFirst({
      where: {
        userId,
        gatewayType: PaymentGatewayType.ANTILOPAY,
        delayDays: { gt: 0 },
        OR: [{ delayGrantedAt: { not: null } }, { status: { in: [...LIVE_STATUSES] } }],
      },
      select: { id: true },
    });
    return used !== null;
  }

  /**
   * Whether this customer has paid the panel anything before: a payment with a
   * sum that was completed, or delivered and given back since (a refund leaves
   * the delivery stamp). A free one — a trial, a 100 % discount, a delay's
   * grant — is not paying, and nor is a checkout still open.
   */
  public async hasPaidBefore(userId: string): Promise<boolean> {
    const paid = await this.prismaService.transaction.findFirst({
      where: {
        userId,
        amount: { gt: 0 },
        OR: [{ status: TransactionStatus.COMPLETED }, { fulfilledAt: { not: null } }],
      },
      select: { id: true },
    });
    return paid !== null;
  }

  /**
   * Whether «Отсрочка первого списания по СБП» is no longer for this customer.
   * It is for a NEW customer only (the operator's question, 18.10.2026: «делей
   * только для новых пользователей, а кто уже оплачивал — деньги сразу»), and
   * once: one who has paid before, or has used the delay, signs up and is
   * charged at once, and is not told about a delay.
   */
  public async mayNotTakeDelay(userId: string): Promise<boolean> {
    return (await this.hasUsedDelay(userId)) || (await this.hasPaidBefore(userId));
  }

  /**
   * The delay an Antilopay SBP sign-up is made with: what the panel decides now
   * (`decideAntilopayDelay`) put beside what the payer was shown
   * (`settleDelayWithConsent`). Null when none was shown — the payer was told the
   * charge is made now, and no query is made for it. Refused with
   * `DELAY_CHANGED` when the payer was shown a delay the panel would not give
   * now, so nobody is charged at once after being told they would not be.
   */
  public async settleAntilopayDelay(input: {
    readonly userId: string;
    readonly settings: Record<string, unknown>;
    readonly method: AntilopayAutopayMethod | undefined;
    readonly audience: CabinetView | undefined;
    readonly shown: ShownDelay;
  }): Promise<AntilopayDelay | null> {
    if (input.shown.kind === 'NONE') return null;
    const decided = decideAntilopayDelay({
      settings: input.settings,
      method: input.method,
      audience: input.audience,
      alreadyUsed: await this.mayNotTakeDelay(input.userId),
    });
    const verdict = settleDelayWithConsent(input.shown, decided);
    if (verdict.kind === 'REFUSE') throw autopayNotAvailable('DELAY_CHANGED');
    return verdict.delay;
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
   * The customer's live autopays, for the user's card in the panel: what
   * «Способы оплаты» shows the customer, and whether a cancel was asked for
   * and still waits for the provider — the operator's, or a refund's.
   */
  public async listForOperator(userId: string): Promise<readonly OperatorProviderSubscriptionInterface[]> {
    const live = await this.listForUser(userId);
    if (live.length === 0) return [];
    const marks = await this.prismaService.providerSubscription.findMany({
      where: { id: { in: live.map((row) => row.id) } },
      select: { id: true, cancelledBy: true },
    });
    const byId = new Map(marks.map((row) => [row.id, row.cancelledBy]));
    return live.map((row) => {
      const mark = byId.get(row.id) ?? null;
      return {
        ...row,
        cancelRequestedBy: mark === REFUND_CANCELLED_BY || mark === OPERATOR_CANCELLED_BY ? mark : null,
      };
    });
  }

  /**
   * «Отменить автосписание» on the user's card in the panel, the part before
   * the operator's answer: the row is marked (`OPERATOR_CANCELLED_BY`) and the
   * provider is not asked yet. From here the sweep cancels it whatever becomes
   * of the rest (`STRANDED_BY_OPERATOR`). Never over a refund's mark, which says
   * more: a charge taken on that row is withheld.
   *
   * `ENDED` — not live any more; `REFUND_ENDING` — a refund's cancel of it is
   * already under way.
   */
  public async markForOperatorCancel(
    id: string,
  ): Promise<
    | { readonly state: 'MARKED'; readonly row: ProviderSubscription }
    | { readonly state: 'NOT_FOUND' | 'ENDED' | 'REFUND_ENDING' }
  > {
    const row = await this.prismaService.providerSubscription.findUnique({ where: { id } });
    if (row === null) return { state: 'NOT_FOUND' };
    if (!(LIVE_STATUSES as readonly ProviderSubscriptionStatus[]).includes(row.status)) return { state: 'ENDED' };
    // The write decides, not the read above: a refund can mark the row between
    // the two, and its mark is never written over.
    const marked = await this.prismaService.providerSubscription.updateMany({
      where: {
        id,
        status: { in: [...LIVE_STATUSES] },
        OR: [{ cancelledBy: null }, { cancelledBy: { not: REFUND_CANCELLED_BY } }],
      },
      data: { cancelledBy: OPERATOR_CANCELLED_BY },
    });
    if (marked.count === 0) {
      // Marked by a refund (before the read or since), or not live any more.
      const now = await this.prismaService.providerSubscription.findUnique({ where: { id }, select: { cancelledBy: true } });
      return { state: now?.cancelledBy === REFUND_CANCELLED_BY ? 'REFUND_ENDING' : 'ENDED' };
    }
    return { state: 'MARKED', row: { ...row, cancelledBy: OPERATOR_CANCELLED_BY } };
  }

  /**
   * The rest of «Отменить автосписание», after the operator's answer: the
   * provider is asked to cancel the row {@link markForOperatorCancel} marked.
   * Never throws: a provider that refuses or cannot be reached is reported,
   * and the sweep keeps trying the marked row every 10 minutes.
   */
  public async cancelForOperator(id: string): Promise<AutopayRefundOutcome> {
    try {
      return await this.cancelLive({ ids: [id] }, OPERATOR_CANCELLED_BY);
    } catch (error: unknown) {
      this.logger.error(
        `Could not cancel provider subscription ${id} for an operator: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { cancelled: [], failed: [{ gatewayType: UNKNOWN_AUTOPAY_GATEWAY, providerSubscriptionId: '' }] };
    }
  }

  /**
   * Stops every live charge for these subscriptions or this user, so a plan
   * change, a deletion or a ban never leaves the provider charging for access
   * the panel no longer gives. Each cancel is tried separately, and a failure
   * is reported, not thrown: the caller's own change must not depend on a
   * provider being reachable.
   */
  public async cancelLive(
    where:
      | { readonly userId: string }
      | { readonly subscriptionId: string }
      | { readonly ids: readonly string[] },
    by: ProviderSubscriptionCancelledBy,
  ): Promise<AutopayRefundOutcome> {
    const selector = 'ids' in where ? { id: { in: [...where.ids] } } : where;
    if ('ids' in where && where.ids.length === 0) return NO_AUTOPAY;
    const rows = await this.prismaService.providerSubscription.findMany({
      where: {
        ...selector,
        status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] },
      },
    });
    if (rows.length === 0) return NO_AUTOPAY;
    if (by === REFUND_CANCELLED_BY) {
      // Said on the rows BEFORE the provider is asked, and left there if it
      // cannot be reached: a charge landing while the cancel is under way, or
      // after one that failed, then renews nothing, and the sweep retries.
      await this.prismaService.providerSubscription.updateMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] },
        },
        data: { cancelledBy: REFUND_CANCELLED_BY },
      });
    }
    const cancelled: AutopayRow[] = [];
    const failed: AutopayRow[] = [];
    for (const row of rows) {
      const named = { gatewayType: row.gatewayType, providerSubscriptionId: row.providerSubscriptionId };
      try {
        await this.cancel(row, by);
        cancelled.push(named);
      } catch (error: unknown) {
        failed.push(named);
        this.logger.error(
          `Could not cancel provider subscription ${row.id} (${row.gatewayType} ${row.providerSubscriptionId}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { cancelled, failed };
  }

  /**
   * Ends the autopay a fully refunded payment belongs to (`refundEndsAutopay`),
   * whichever door the refund came through: the panel's ЮKassa refund, a
   * provider's refund notice or chargeback, «Отметить возврат».
   *
   * Every live provider subscription of every subscription the payment paid
   * for — the one it created or renewed, the lines of a combined renewal or an
   * autopay charge, an add-on's target — and the sign-up the payment itself
   * started, which a new purchase has not bound to its subscription yet.
   *
   * A WITHHELD payment paid for nothing: the subscription it names is the one
   * another payment converted, and that payment's autopay stands. Only its
   * own sign-up ends.
   *
   * Never throws. A cancel the provider refuses, or one it cannot be asked,
   * is reported in the outcome and left for the sweep: the refund must not
   * depend on the provider being reachable.
   */
  public async cancelForRefund(
    transaction: Pick<Transaction, 'id' | 'subscriptionId' | 'gatewayType' | 'gatewayData' | 'planSnapshot'>,
  ): Promise<AutopayRefundOutcome> {
    try {
      const selection = await this.refundRowsWhere(transaction);
      const live = await this.prismaService.providerSubscription.findMany({
        where: { OR: selection, status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] } },
        select: { id: true },
      });
      // ONE request per row, however many ways the payment reaches it — its
      // own sign-up is usually also bound to the subscription it paid for. Two
      // passes asked a provider that was not answering twice, doubled the wait
      // and counted one autopay twice on the card.
      const outcome = await this.cancelLive({ ids: [...new Set(live.map((row) => row.id))] }, REFUND_CANCELLED_BY);
      // Ended moments ago by another door into the same refund — the panel's
      // own refund, whose provider notice comes after — is ended all the same,
      // and the card of the door that comes second says so.
      const recent = await this.prismaService.providerSubscription.findMany({
        where: {
          OR: selection,
          status: ProviderSubscriptionStatus.CANCELLED,
          cancelledBy: REFUND_CANCELLED_BY,
          cancelledAt: { gte: new Date(Date.now() - RECENT_REFUND_CANCEL_MS) },
        },
        select: { gatewayType: true, providerSubscriptionId: true },
      });
      const cancelled = new Map<string, AutopayRow>();
      for (const row of [...outcome.cancelled, ...recent]) {
        cancelled.set(`${row.gatewayType}:${row.providerSubscriptionId}`, {
          gatewayType: row.gatewayType,
          providerSubscriptionId: row.providerSubscriptionId,
        });
      }
      // A row the other door cancelled while this one's request failed is
      // cancelled all the same: the card says so, and not both.
      const failed = outcome.failed.filter(
        (row) => !cancelled.has(`${row.gatewayType}:${row.providerSubscriptionId}`),
      );
      return { cancelled: [...cancelled.values()], failed };
    } catch (error: unknown) {
      this.logger.error(
        `Could not end the autopay of refunded transaction ${transaction.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { cancelled: [], failed: [{ gatewayType: UNKNOWN_AUTOPAY_GATEWAY, providerSubscriptionId: '' }] };
    }
  }

  /**
   * Marks, without asking the provider, every live autopay a refunded
   * payment's refund ends (`REFUND_CANCELLED_BY`) — the part of
   * {@link cancelForRefund} a request must not wait past: from here the sweep
   * cancels them even if nothing else does, and a charge taken on them renews
   * nothing. The provider is asked afterwards, by {@link cancelForRefund},
   * after the operator's answer. Returns the rows marked.
   */
  public async markForRefund(
    transaction: Pick<Transaction, 'id' | 'subscriptionId' | 'gatewayType' | 'gatewayData' | 'planSnapshot'>,
  ): Promise<readonly string[]> {
    const live = await this.prismaService.providerSubscription.findMany({
      where: {
        OR: await this.refundRowsWhere(transaction),
        status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] },
      },
      select: { id: true },
    });
    const ids = [...new Set(live.map((row) => row.id))];
    if (ids.length > 0) {
      await this.prismaService.providerSubscription.updateMany({
        where: { id: { in: ids }, status: { in: [ProviderSubscriptionStatus.PENDING, ...LIVE_STATUSES] } },
        data: { cancelledBy: REFUND_CANCELLED_BY },
      });
    }
    return ids;
  }

  /**
   * The rows a refunded payment's refund ends: its own sign-up, the row whose
   * charge it is, and — unless it was withheld — every row of every
   * subscription it paid for.
   */
  private async refundRowsWhere(
    transaction: Pick<Transaction, 'id' | 'subscriptionId' | 'gatewayType' | 'gatewayData' | 'planSnapshot'>,
  ): Promise<Prisma.ProviderSubscriptionWhereInput[]> {
    const marker = readProviderChargeMarker(transaction);
    const subscriptionIds = isWithheldConversion(transaction.gatewayData)
      ? []
      : await this.subscriptionsPaidBy(transaction);
    return [
      { firstTransactionId: transaction.id },
      ...(marker === null
        ? []
        : [{ gatewayType: transaction.gatewayType, providerSubscriptionId: marker.providerSubscriptionId }]),
      ...(subscriptionIds.length === 0 ? [] : [{ subscriptionId: { in: [...subscriptionIds] } }]),
    ];
  }

  /** The subscriptions a payment paid for: its own, its lines', an add-on's target. */
  private async subscriptionsPaidBy(
    transaction: Pick<Transaction, 'id' | 'subscriptionId' | 'planSnapshot'>,
  ): Promise<readonly string[]> {
    const items = await this.prismaService.transactionItem.findMany({
      where: { transactionId: transaction.id },
      select: { subscriptionId: true },
    });
    const target = asRecord(transaction.planSnapshot)['targetSubscriptionId'];
    return [
      ...new Set([
        ...(transaction.subscriptionId === null ? [] : [transaction.subscriptionId]),
        ...items.map((item) => item.subscriptionId),
        ...(typeof target === 'string' && target.length > 0 ? [target] : []),
      ]),
    ];
  }

  /**
   * Records a Platega callback that disputes a subscription charge in the
   * payment inbox, and queues its reconciliation, which hands it to
   * {@link handleChargeback}.
   *
   * In the inbox FIRST, before the provider is asked anything: the look at
   * the subscription that matching starts with is a call to Platega, and a
   * queue job that lost it for good during an outage dropped the chargeback —
   * nothing reversed, the autopay not ended, nobody told. As an inbox event it
   * is FAILED rather than gone: retried automatically, counted on the
   * dashboard, and replayable from «Платежи» → «Вебхуки». Keyed by the
   * dispute, so Platega repeating the callback is one event, one card.
   */
  public async recordDispute(
    gatewayType: PaymentGatewayType,
    providerSubscriptionId: string,
    chargeback: ProviderSubscriptionChargeback,
    body: unknown,
  ): Promise<{ readonly duplicate: boolean }> {
    const rawPayload = {
      source: PROVIDER_SUBSCRIPTION_DISPUTE,
      providerSubscriptionId,
      providerPaymentId: chargeback.providerPaymentId,
      status: chargeback.providerStatus,
      body,
    };
    const payloadHash = createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');
    const duplicate = await this.enqueueNotice({
      gatewayType,
      // The dispute names no payment of ours yet — which one it is, is what
      // its handling finds out — so the event is filed under the subscription.
      paymentId: providerSubscriptionId,
      // The marker is what gives a dispute its longer retry ladder
      // (`DISPUTE_RETRY_LADDER`): Platega being down fails its handling.
      providerEventId: `subscription:${providerSubscriptionId}${DISPUTE_EVENT_KEY_MARKER}${disputedChargeId(providerSubscriptionId, chargeback) ?? payloadHash}`,
      eventStatus: chargeback.providerStatus,
      receivedAt: new Date().toISOString(),
      payloadHash,
      rawPayload,
    });
    return { duplicate };
  }

  /**
   * A chargeback (or a refund) the provider reports on a subscription charge.
   * Platega posts it like a charge callback — `Id`, `SubscriptionId`, a status —
   * so it used to reach only `sync`, which counts charges and never reverses
   * one: the commission and the cashback stood, and the autopay went on
   * charging. (There was no «Мой налог» receipt to stand: the panel files those
   * for ЮKassa payments only.)
   *
   * The charges the provider reports are applied first, then the disputed one
   * is found and goes through the refund reversal every other refund takes —
   * a notice in the inbox for its own payment, reconciled like any — which
   * also ends the autopay (`refundEndsAutopay`).
   *
   * Found when the callback names one of our payments by its provider id, or
   * when the subscription has been charged once. A subscription charged
   * several times gives no way to tell which charge is disputed — every
   * charge is the same sum, and Platega's callback names none of ours — so
   * nothing is guessed: the autopay ends and the operator is told
   * (`payment.chargeback_unmatched`) what was not reversed, and how to reverse
   * it: «Отметить возврат» on the charge they find ({@link unmatchedChargebackNote}).
   */
  public async handleChargeback(
    gatewayType: PaymentGatewayType,
    providerSubscriptionId: string,
    chargeback: ProviderSubscriptionChargeback,
  ): Promise<void> {
    const found =
      (await this.prismaService.providerSubscription.findUnique({
        where: { gatewayType_providerSubscriptionId: { gatewayType, providerSubscriptionId } },
      })) ?? (await this.adoptFromCheckout(gatewayType, providerSubscriptionId));
    if (found === null) {
      this.logger.warn(`Chargeback for unknown ${gatewayType} subscription ${providerSubscriptionId}; ignored`);
      return;
    }
    // The provider's count is the ledger: apply what it charged before asking
    // which charge is disputed.
    await this.syncRow(found);
    const row = (await this.prismaService.providerSubscription.findUnique({ where: { id: found.id } })) ?? found;
    const chargeId = disputedChargeId(providerSubscriptionId, chargeback);
    const payment = await this.findDisputedCharge(row, chargeId);
    if (payment !== null) {
      await this.enqueueRefundNotice(row, payment, chargeback);
      return;
    }
    // One card per dispute. The inbox keys a repeated callback away
    // (`recordDispute`); this keys away a second run of the same one — a
    // retry after the card went out — whose card would contradict the first
    // («Живых автосписаний у подписки не было»). A dispute that names no charge
    // of the provider's cannot be told from the next one, so it is not keyed.
    const disputeKey = chargeId === null ? null : `${gatewayType}:${providerSubscriptionId}:${chargeId}`;
    if (disputeKey !== null) {
      if (this.unmatchedDisputesTold.has(disputeKey)) {
        this.logger.log(`Chargeback ${disputeKey} was told already; not told again`);
        return;
      }
      this.unmatchedDisputesTold.add(disputeKey);
      if (this.unmatchedDisputesTold.size > UNMATCHED_DISPUTES_REMEMBERED) {
        const oldest = this.unmatchedDisputesTold.values().next().value;
        if (oldest !== undefined) this.unmatchedDisputesTold.delete(oldest);
      }
    }
    let outcome: AutopayRefundOutcome;
    try {
      outcome = await this.cancelLive(
        row.subscriptionId === null ? { ids: [row.id] } : { subscriptionId: row.subscriptionId },
        REFUND_CANCELLED_BY,
      );
    } catch (error: unknown) {
      // Nothing told: the run fails, and the run that retries it tells.
      if (disputeKey !== null) this.unmatchedDisputesTold.delete(disputeKey);
      throw error;
    }
    // A chargeback is the payer taking the money back: a refund, which ends
    // the saved-card autopay too (the owner's decision of 23.09.2026).
    const savedCard = await this.switchOffSavedCardForDispute(row);
    this.logger.error(
      `Chargeback on ${gatewayType} subscription ${row.id} (${providerSubscriptionId}) matches none of its ` +
        `${row.appliedChargeCount} charge(s); not reversed, autopay ended`,
    );
    this.systemEvents?.warn(
      EVENT_TYPES.PAYMENT_CHARGEBACK_UNMATCHED,
      'PAYMENT',
      'Оспорено списание по автоплатежу: не понять, какое',
      {
        userId: row.userId,
        gatewayType,
        providerSubscriptionId,
        providerPaymentId: chargeback.providerPaymentId,
        providerStatus: chargeback.providerStatus,
        amount: row.amount.toString(),
        currency: row.currency,
        chargeCount: row.appliedChargeCount,
        ...(row.subscriptionId === null ? {} : { subscriptionId: row.subscriptionId }),
        needsManualReview: true,
        note: unmatchedChargebackNote(gatewayType, row.appliedChargeCount, { ...outcome, ...savedCard }),
        ...savedCard,
      },
    );
  }

  /**
   * The user's ЮKassa saved-card autopay, switched off for a chargeback that
   * matches no payment, by the rule every refund follows (`refundEndsAutopay`).
   * Never throws: what it did goes on the card.
   */
  private async switchOffSavedCardForDispute(
    row: ProviderSubscription,
  ): Promise<Pick<AutopayRefundOutcome, 'savedCardAutopayOff' | 'savedCardAutopayFailed'>> {
    if (row.userId === null || this.savedPaymentMethods === undefined || !refundEndsAutopay({ full: true })) {
      return {};
    }
    try {
      const result = await this.savedPaymentMethods.disableAutopayForRefund({
        userId: row.userId,
        providerSubscriptionId: row.providerSubscriptionId,
      });
      return result.switched > 0 ? { savedCardAutopayOff: true } : {};
    } catch (error: unknown) {
      this.logger.error(
        `Could not switch off the saved-card autopay of the user whose ${row.gatewayType} charge was disputed ` +
          `(${row.providerSubscriptionId}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return { savedCardAutopayFailed: true };
    }
  }

  /**
   * The payment a chargeback disputes, when it can be told; see {@link handleChargeback}.
   * `chargeId` is {@link disputedChargeId}: never the subscription's own id.
   */
  private async findDisputedCharge(row: ProviderSubscription, chargeId: string | null): Promise<Transaction | null> {
    if (chargeId !== null) {
      const named = await this.prismaService.transaction.findFirst({
        where: { gatewayType: row.gatewayType, gatewayId: chargeId },
      });
      if (named !== null) return named;
    }
    if (row.appliedChargeCount !== 1) return null;
    const first = await this.prismaService.transaction.findUnique({ where: { id: row.firstTransactionId } });
    return first !== null && first.status === TransactionStatus.COMPLETED && first.fulfilledAt !== null ? first : null;
  }

  /**
   * Hands a disputed charge to the reconciliation worker as the provider's
   * refund notice for its payment, keyed by the dispute so a repeated callback
   * is one notice.
   */
  private async enqueueRefundNotice(
    row: ProviderSubscription,
    transaction: Transaction,
    chargeback: ProviderSubscriptionChargeback,
  ): Promise<void> {
    const rawPayload = {
      source: 'PROVIDER_SUBSCRIPTION',
      status: chargeback.providerStatus,
      subscriptionId: row.providerSubscriptionId,
      providerPaymentId: chargeback.providerPaymentId,
      paymentId: transaction.paymentId,
    };
    const envelope: PaymentWebhookEnvelopeInterface = {
      gatewayType: row.gatewayType,
      paymentId: transaction.paymentId,
      providerEventId: `subscription:${row.providerSubscriptionId}:dispute:${disputedChargeId(row.providerSubscriptionId, chargeback) ?? transaction.paymentId}`,
      eventStatus: chargeback.providerStatus,
      receivedAt: new Date().toISOString(),
      payloadHash: createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex'),
      rawPayload,
    };
    await this.enqueueNotice(envelope);
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
   * operator, a plan deletion, or the customer's own plan change), or it has
   * no end date left to renew.
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
            select: { id: true, status: true, planSnapshot: true, isTrial: true, expiresAt: true },
          });
    const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    // Read AFTER the subscriptions, and the order is what makes `LOST` safe: a
    // conversion this row's own charge made has its payment COMPLETED before
    // fulfilment converts anything, so a subscription seen converted is never
    // paired with that payment still unpaid.
    const conversions = await this.readUpgradeCheckouts(rows);
    const now = new Date();
    let cancelled = 0;
    for (const row of rows) {
      const subscription = row.subscriptionId === null ? undefined : byId.get(row.subscriptionId);
      const reason = strandedReason({
        refundRequested: row.cancelledBy === REFUND_CANCELLED_BY,
        operatorRequested: row.cancelledBy === OPERATOR_CANCELLED_BY,
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
                  lifetime: isLifetimeSubscription(subscription),
                  ...trialConversionOf(conversions.get(row.firstTransactionId), row.subscriptionId, subscription.isTrial),
                  ...planChangeOf(conversions.get(row.firstTransactionId), row.subscriptionId, subscription.isTrial, now),
                },
        planId: row.planId,
      });
      if (reason === null) continue;
      try {
        await this.cancel(
          row,
          reason === STRANDED_BY_REFUND
            ? REFUND_CANCELLED_BY
            : reason === STRANDED_BY_OPERATOR
              ? OPERATOR_CANCELLED_BY
              : 'SYSTEM',
        );
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
   * The checkouts of the rows whose first charge changes a plan (an UPGRADE:
   * «Сменить тариф», or a trial's conversion), by id. Every other row's first
   * charge creates or renews a subscription and is left out, so this reads only
   * what `trialConversionOf` and `planChangeOf` need.
   */
  private async readUpgradeCheckouts(
    rows: readonly Pick<ProviderSubscription, 'subscriptionId' | 'firstTransactionId'>[],
  ): Promise<Map<string, UpgradeCheckout>> {
    const ids = rows.flatMap((row) => (row.subscriptionId === null ? [] : [row.firstTransactionId]));
    if (ids.length === 0) return new Map();
    const checkouts = await this.prismaService.transaction.findMany({
      where: { id: { in: ids }, purchaseType: PurchaseType.UPGRADE },
      select: {
        id: true,
        subscriptionId: true,
        status: true,
        fulfilledAt: true,
        gatewayData: true,
        createdAt: true,
        planSnapshot: true,
      },
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
    await this.cancelAtProvider(row, gateway.settings);
    await this.prismaService.providerSubscription.update({
      where: { id: row.id },
      data: {
        status: ProviderSubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        ...(by === REFUND_CANCELLED_BY ? { cancelledBy: by } : {}),
      },
    });
    if (by !== REFUND_CANCELLED_BY) {
      await this.recordCancelledBy(row, by);
    }
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
        method: terms.method ?? null,
        delayDays: terms.delay?.days ?? null,
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
    /** The provider's payment id, where the charge is keyed by it rather than by its number (Antilopay). */
    providerChargeId?: string,
  ): Promise<Transaction | null> {
    const userId = row.userId;
    if (userId === null) return null;
    const idempotencyKey =
      providerChargeId === undefined
        ? `provider-subscription:${row.id}:charge:${chargeNumber}`
        : keyedChargeKey(row.id, providerChargeId);
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
      ...(providerChargeId === undefined ? {} : { providerChargeId }),
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
              ...(providerChargeId === undefined ? {} : { providerChargeId }),
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
    /** The provider's payment id, where the charge is keyed by it rather than by its number (Antilopay). */
    providerChargeId?: string,
  ): Promise<void> {
    const rawPayload = {
      source: 'PROVIDER_SUBSCRIPTION',
      status: 'CONFIRMED',
      subscriptionId: row.providerSubscriptionId,
      chargeNumber,
      paymentId: transaction.paymentId,
      ...(providerChargeId === undefined ? {} : { providerChargeId }),
    };
    const envelope: PaymentWebhookEnvelopeInterface = {
      gatewayType: row.gatewayType,
      paymentId: transaction.paymentId,
      providerEventId:
        providerChargeId === undefined
          ? `subscription:${row.providerSubscriptionId}:charge:${chargeNumber}`
          : `subscription:${row.providerSubscriptionId}:payment:${providerChargeId}`,
      eventStatus: 'CONFIRMED',
      receivedAt: new Date().toISOString(),
      payloadHash: createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex'),
      rawPayload,
    };
    await this.enqueueNotice(envelope);
  }

  /**
   * Records a notice in the inbox and queues its reconciliation, once per key.
   * True when the inbox already held it.
   */
  private async enqueueNotice(envelope: PaymentWebhookEnvelopeInterface): Promise<boolean> {
    const received = await this.paymentWebhookInboxService.recordReceived({ envelope });
    if (received.duplicate) {
      // Settled, settling, or FAILED to enqueue earlier — the auto-retry owns that one.
      return true;
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
    return false;
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
      case PaymentGatewayType.ANTILOPAY:
        return this.fetchAntilopayState(row, settings);
      case PaymentGatewayType.AURAPAY:
        return this.fetchAurapayState(row, settings);
      default:
        throw new Error(`No provider subscription API for ${row.gatewayType}`);
    }
  }

  /**
   * AuraPay's `GET /subscription/status` by our `subscription_id`. A sign-up
   * AuraPay does not know (404) is read as nothing, never as a cancellation.
   * `lastChargeAt` is the row's own: AuraPay names no charge here, and
   * {@link applyAurapayCharges} moves it when it delivers one.
   */
  private async fetchAurapayState(
    row: ProviderSubscription,
    settings: Record<string, unknown>,
  ): Promise<ProviderSubscriptionState> {
    const response = await firstValueFrom(
      this.httpService.get(`${AURAPAY_API}/subscription/status`, {
        params: { subscription_id: row.providerSubscriptionId },
        headers: aurapayHeaders(settings),
        validateStatus: (status: number) => status === 200 || status === 404,
      }),
    );
    if (response.status === 404) {
      this.logger.warn(`AuraPay has no subscription ${row.providerSubscriptionId} (${row.id})`);
      return {
        status: null,
        providerStatus: null,
        chargesSuccess: null,
        nextChargeAt: row.nextChargeAt,
        lastChargeAt: row.lastChargeAt,
        activatedAt: null,
      };
    }
    const parsed = parseAurapaySubscription(response.data);
    if (parsed.status === null) {
      this.logger.warn(
        `AuraPay subscription ${row.providerSubscriptionId} has a status this build does not know: ` +
          `${parsed.providerStatus ?? 'none'}`,
      );
    }
    return {
      status: parsed.status,
      providerStatus: parsed.providerStatus,
      chargesSuccess: null,
      nextChargeAt: parsed.nextChargeAt,
      lastChargeAt: row.lastChargeAt,
      activatedAt: parsed.activatedAt,
    };
  }

  /**
   * Antilopay's `payment/recurrent/check`, read with our own keys. The
   * recurrent's id is found first when no callback has named it yet. An
   * unlinked sign-up (its payer has not paid) has nothing to read: no status,
   * no charges, so the row is left as it is.
   */
  private async fetchAntilopayState(
    row: ProviderSubscription,
    settings: Record<string, unknown>,
  ): Promise<ProviderSubscriptionState> {
    const nothingYet: ProviderSubscriptionState = {
      status: null,
      providerStatus: null,
      chargesSuccess: null,
      nextChargeAt: null,
      lastChargeAt: null,
      charges: [],
    };
    const recurrentId = await this.resolveAntilopayRecurrentId(row, settings);
    if (recurrentId === null) return nothingYet;
    const reply = await postAntilopay(this.httpService, settings, 'payment/recurrent/check', {
      recurrent_id: recurrentId,
    });
    if (reply.code === ANTILOPAY_NOT_FOUND) {
      this.logger.warn(`Antilopay has no recurrent ${recurrentId} (subscription ${row.id})`);
      return nothingYet;
    }
    if (reply.code !== 0) {
      throw new Error(`Antilopay payment/recurrent/check error ${reply.code}: ${antilopayErrorText(reply.data)}`);
    }
    const parsed = parseAntilopayRecurrent(reply.data);
    if (parsed.status === null) {
      // An unknown word is logged and read as nothing: never as a cancellation.
      this.logger.warn(
        `Antilopay recurrent ${recurrentId} has a status this build does not know: ${parsed.providerStatus ?? 'none'}`,
      );
    }
    const delivered = parsed.charges.filter((charge) => !charge.disputed);
    return {
      status: parsed.status,
      providerStatus: parsed.providerStatus,
      chargesSuccess: delivered.length,
      nextChargeAt: parsed.nextChargeAt,
      lastChargeAt: delivered[delivered.length - 1]?.at ?? null,
      endsAt: parsed.endsAt,
      plannedChargeCount: parsed.plannedChargeCount,
      charges: parsed.charges,
    };
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
    row: Pick<
      ProviderSubscription,
      'gatewayType' | 'providerSubscriptionId' | 'providerRecurrentId' | 'firstTransactionId' | 'createdAt'
    >,
    settingsJson: Prisma.JsonValue,
  ): Promise<void> {
    const { gatewayType, providerSubscriptionId } = row;
    const settings = readGatewaySettings(settingsJson);
    if (gatewayType === PaymentGatewayType.ANTILOPAY) {
      await this.cancelAntilopayAtProvider(row, settings);
      return;
    }
    if (gatewayType === PaymentGatewayType.AURAPAY) {
      await this.cancelAurapayAtProvider(row, settings);
      return;
    }
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

  /**
   * `POST /subscription/cancel`, and only then a cancelled row: the status read
   * after it is the proof. «Отключение доступно для подписок в статусах active и
   * waiting_payment» — a sign-up whose first invoice is unpaid (`new`) answers
   * 409 and cannot be cancelled; once that invoice has outlived the checkout
   * (30 minutes, `CHECKOUT_LIFETIME_MS`) it can never be paid, and nothing will
   * be charged. Until then the cancel fails and the sweep tries again.
   */
  private async cancelAurapayAtProvider(
    row: Pick<ProviderSubscription, 'providerSubscriptionId' | 'createdAt'>,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const headers = aurapayHeaders(settings);
    const cancelled = await firstValueFrom(
      this.httpService.post(
        `${AURAPAY_API}/subscription/cancel`,
        { subscription_id: row.providerSubscriptionId },
        { headers, validateStatus: () => true },
      ),
    );
    // 409: not active nor waiting — deactivated already, stopped on errors, or
    // not paid yet; 404: AuraPay never made it. The status below decides.
    if (cancelled.status !== 200 && cancelled.status !== 404 && cancelled.status !== 409) {
      throw new Error(`AuraPay subscription/cancel answered HTTP ${cancelled.status} for ${row.providerSubscriptionId}`);
    }
    const after = await firstValueFrom(
      this.httpService.get(`${AURAPAY_API}/subscription/status`, {
        params: { subscription_id: row.providerSubscriptionId },
        headers,
        validateStatus: (status: number) => status === 200 || status === 404,
      }),
    );
    if (after.status === 404) return;
    const status = parseAurapaySubscription(after.data).status;
    if (status === ProviderSubscriptionStatus.CANCELLED || status === ProviderSubscriptionStatus.FAILED) return;
    if (
      status === ProviderSubscriptionStatus.PENDING &&
      parseAurapaySubscription(after.data).activatedAt === null &&
      Date.now() - row.createdAt.getTime() > CHECKOUT_LIFETIME_MS + 5 * 60 * 1000
    ) {
      return;
    }
    throw new Error(`AuraPay did not stop subscription ${row.providerSubscriptionId}`);
  }

  /**
   * `payment/recurrent/cancel`, and only then a cancelled row: «перечитайте» —
   * the recurrent's own status after the call is the proof, not the answer to
   * it. A recurrent that is not active yet (its payer has not paid) answers 28
   * and cannot be cancelled while its first payment can still be paid, so that
   * is settled by asking about the payment: dead, and nothing can be charged;
   * open, and the cancel fails and the sweep tries again.
   */
  private async cancelAntilopayAtProvider(
    row: Pick<ProviderSubscription, 'providerSubscriptionId' | 'providerRecurrentId' | 'firstTransactionId'>,
    settings: Record<string, unknown>,
  ): Promise<void> {
    // «Отключить автосписание» waits for this inside the 30 s the panel gives a
    // request, and the cancel is up to four calls (the recurrent's id, the
    // cancel, its re-read, the first payment). Each waits at most 8 s, and all
    // together at most this budget: past it the cancel fails and the sweep,
    // which retries every marked row, finishes it.
    const deadline = Date.now() + ANTILOPAY_CANCEL_BUDGET_MS;
    const timeout = (): number => {
      const remaining = deadline - Date.now();
      if (remaining < 1_000) throw new Error('Antilopay cancel ran out of time; the sweep tries again');
      return Math.min(ANTILOPAY_CALL_TIMEOUT_MS, remaining);
    };
    const recurrentId =
      row.providerRecurrentId ??
      (await this.resolveAntilopayRecurrentId(row as ProviderSubscription, settings, timeout()));
    const reply = await postAntilopay(
      this.httpService,
      settings,
      'payment/recurrent/cancel',
      // The initiating payment's id is a handle Antilopay takes for a recurrent
      // whose own id is not known here yet.
      recurrentId === null ? { transaction_id: row.providerSubscriptionId } : { recurrent_id: recurrentId },
      { timeoutMs: timeout() },
    );
    if (reply.code !== 0 && reply.code !== ANTILOPAY_RECURRENT_NOT_ACTIVE) {
      throw new Error(`Antilopay payment/recurrent/cancel error ${reply.code}: ${antilopayErrorText(reply.data)}`);
    }
    if (recurrentId === null) {
      if (await this.isAntilopaySignUpDead(row, settings, timeout())) return;
      throw new Error(`Antilopay sign-up ${row.providerSubscriptionId} is not readable yet and its payer may still pay`);
    }
    const after = await postAntilopay(
      this.httpService,
      settings,
      'payment/recurrent/check',
      { recurrent_id: recurrentId },
      { timeoutMs: timeout() },
    );
    if (after.code !== 0) {
      throw new Error(`Antilopay payment/recurrent/check error ${after.code}: ${antilopayErrorText(after.data)}`);
    }
    const status = typeof after.data['status'] === 'string' ? after.data['status'] : null;
    if (isAntilopayRecurrentEnded(status)) return;
    if (isAntilopayRecurrentNotActiveYet(status) && (await this.isAntilopaySignUpDead(row, settings, timeout()))) return;
    throw new Error(`Antilopay did not cancel recurrent ${recurrentId} (status ${status ?? 'unreadable'})`);
  }

  /** Whether a sign-up's first payment can never be paid any more (FAIL, CANCEL, EXPIRED). */
  private async isAntilopaySignUpDead(
    row: Pick<ProviderSubscription, 'firstTransactionId'>,
    settings: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<boolean> {
    const first = await this.prismaService.transaction.findUnique({
      where: { id: row.firstTransactionId },
      select: { paymentId: true },
    });
    if (first === null) return false;
    const reply = await postAntilopay(
      this.httpService,
      settings,
      'payment/check',
      { order_id: first.paymentId },
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    if (reply.code === ANTILOPAY_NOT_FOUND) return true;
    return reply.code === 0 && classifyAntilopayPaymentStatus(String(reply.data['status'] ?? '')) === 'DEAD';
  }
}

/**
 * A rewrite of the checkout into the grant that must not stand: thrown inside
 * its database transaction so the claim on the row is undone with it.
 */
class DelayGrantUndone extends Error {}

/**
 * When the delay of a subscription still in it ends: the date Antilopay names for
 * the first charge, or the end of the days that were granted. Null for a
 * subscription without a delay, one whose access was not granted yet, and one
 * whose first charge has come — it is past its delay then, and the charge shows
 * on the card as any other.
 */
export function delayEndsAtOf(
  row: Pick<ProviderSubscription, 'delayDays' | 'delayGrantedAt' | 'appliedChargeCount' | 'nextChargeAt'>,
): Date | null {
  if (row.delayDays === null || row.delayDays <= 0 || row.delayGrantedAt === null) return null;
  // Counted by charges delivered, not by `lastChargeAt`: the start of the
  // subscription may be listed as a payment and is no charge.
  if (row.appliedChargeCount > 0) return null;
  return row.nextChargeAt ?? new Date(row.delayGrantedAt.getTime() + row.delayDays * DAY_MS);
}

/** A `gatewayId` that is a placeholder held while a provider checkout is being created, not a provider handle. */
const CREATION_CLAIM_PLACEHOLDER = /^(?:__CHECKOUT_PROVIDER_CREATE__:|__RENEWAL_PROVIDER_CREATE__:|claim:)/;

/** `Transaction.idempotencyKey` of the RENEW payment made for one Antilopay charge. */
/** The charge number a provider charge's RENEW payment was made with (`findOrCreateChargeTransaction`). */
function readChargeNumber(gatewayData: Prisma.JsonValue | null): number | null {
  const value = asRecord(gatewayData)['chargeNumber'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function keyedChargeKey(rowId: string, providerChargeId: string): string {
  return `provider-subscription:${rowId}:payment:${providerChargeId}`;
}

function antilopayErrorText(data: Record<string, unknown>): string {
  return redactPaymentDiagnosticMessage(String(data['error'] ?? 'unknown'), 120) ?? 'unknown';
}

/**
 * The dispute an inbox event recorded by {@link ProviderSubscriptionService.recordDispute}
 * holds, or null for every other event. Throws for one that says it is a
 * dispute and does not hold one: it is kept FAILED rather than read as a
 * payment of ours.
 */
export function readProviderSubscriptionDispute(rawPayload: unknown): {
  readonly providerSubscriptionId: string;
  readonly chargeback: ProviderSubscriptionChargeback;
} | null {
  const payload = asRecord(rawPayload);
  if (payload['source'] !== PROVIDER_SUBSCRIPTION_DISPUTE) return null;
  const providerSubscriptionId = payload['providerSubscriptionId'];
  const providerStatus = payload['status'];
  const providerPaymentId = payload['providerPaymentId'];
  if (
    typeof providerSubscriptionId !== 'string' ||
    providerSubscriptionId.length === 0 ||
    typeof providerStatus !== 'string' ||
    providerStatus.length === 0
  ) {
    throw new Error('Provider subscription dispute event is malformed');
  }
  return {
    providerSubscriptionId,
    chargeback: {
      providerPaymentId: typeof providerPaymentId === 'string' && providerPaymentId.length > 0 ? providerPaymentId : null,
      providerStatus,
    },
  };
}

/**
 * The provider's id of the charge a dispute names, or null when it names none —
 * or names the subscription itself. Platega puts the subscription's id in `Id`
 * of its status callbacks, and a sign-up's checkout carries it as its provider
 * id: taken for a charge's id, it matched the first payment whichever charge
 * was disputed, and it keyed two disputes of one subscription as one.
 */
export function disputedChargeId(
  providerSubscriptionId: string,
  chargeback: ProviderSubscriptionChargeback,
): string | null {
  return chargeback.providerPaymentId !== null && chargeback.providerPaymentId !== providerSubscriptionId
    ? chargeback.providerPaymentId
    : null;
}

/**
 * The «📝 Заметка» of `payment.chargeback_unmatched`: what the panel could not
 * reverse, and how the operator reverses it — find the disputed charge at the
 * provider by the ids on the card, then «Отметить возврат» on that payment in
 * the panel, which takes back its commission and cashback as a provider's
 * refund notice would, and sends the provider nothing. The place is named in
 * the words the panel shows: `adminNav.items.users`,
 * `userDetailPanel.tabs.operations`, `providerRefund.action` and
 * `providerRefund.confirm`.
 *
 * NO «МОЙ НАЛОГ» RECEIPT IS CLAIMED. The panel files receipts for
 * ЮKassa payments only (`enqueueMoyNalogIncomeBestEffort`), and these cards
 * are for Platega and RollyPay: it filed none for the disputed charge, and
 * saying it would cancel one left an operator who had declared the income by
 * hand thinking it was done. The note says where that receipt is cancelled.
 */
export function unmatchedChargebackNote(
  gatewayType: PaymentGatewayType,
  chargeCount: number,
  autopay: AutopayRefundOutcome,
): string {
  const provider =
    gatewayType === PaymentGatewayType.PLATEGA
      ? 'Platega'
      : gatewayType === PaymentGatewayType.ROLLYPAY
        ? 'RollyPay'
        : gatewayType === PaymentGatewayType.ANTILOPAY
          ? 'Antilopay'
          : String(gatewayType);
  return (
    `Провайдер сообщил об оспаривании одного из ${chargeCount} списаний по автоплатежу, но не сказал, какого: ` +
    'оно пока не отменено в панели (комиссия и кешбэк остались). ' +
    `Найдите оспоренное списание в личном кабинете ${provider} по ID из карточки и посмотрите его дату и сумму. ` +
    'Затем в панели откройте «Пользователи» → этот клиент → вкладка «Операции», найдите платёж с той же датой ' +
    'и суммой и нажмите у него «Отметить возврат» → «Да, деньги возвращены»: панель отменит его комиссию и кешбэк, ' +
    'а провайдеру ничего не отправит. ' +
    `Чеки «Мой налог» по платежам ${provider} панель не отправляет: если вы сами добавили этот доход в «Мой налог», ` +
    'аннулируйте чек там. ' +
    (describeAutopayOutcome(autopay) ?? 'Живых автосписаний у подписки не было.')
  );
}

/** {@link strandedReason} for a row a refund asked to cancel, whose cancel has not landed yet. */
export const STRANDED_BY_REFUND = 'refunded: the autopay ends with the refund';

/** {@link strandedReason} for a row an operator asked to cancel from the panel, whose cancel has not landed yet. */
export const STRANDED_BY_OPERATOR = 'cancelled by an operator in the panel';

/**
 * Why a provider subscription must stop charging, or null while it may go on.
 * A plan is compared by the id in the subscription's snapshot, which is where
 * a subscription keeps its plan.
 */
export function strandedReason(input: {
  /**
   * A refund asked for this cancel (`REFUND_CANCELLED_BY`) and the provider
   * could not be reached: every pass tries again until it lands.
   */
  readonly refundRequested?: boolean;
  /**
   * An operator asked for this cancel from the user's card
   * (`OPERATOR_CANCELLED_BY`) and it has not landed: every pass tries again.
   */
  readonly operatorRequested?: boolean;
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
        /**
         * Only for a row whose first charge changes the plan of this subscription
         * when it is not a trial («Сменить тариф», see `planChangeOf`). PENDING:
         * that charge has not landed, so the subscription is still on the plan
         * it is leaving, and that is not a move. LOST: it never landed, so the
         * later charges would renew a plan the subscription is not on.
         */
        readonly planChange?: 'PENDING' | 'LOST';
        /**
         * The subscription has no end date. It is never renewed
         * (`lifetime-renewal.util.ts`), so every charge would be money taken
         * for nothing, to be handed back by hand. Absent reads as dated.
         */
        readonly lifetime?: boolean;
      };
  readonly planId: string;
}): string | null {
  if (input.refundRequested === true) return STRANDED_BY_REFUND;
  if (input.operatorRequested === true) return STRANDED_BY_OPERATOR;
  if (input.userDeleted) return 'account deleted';
  if (input.userBlocked) return 'account blocked';
  if (input.subscription === 'NOT_YET') return null;
  if (input.subscription === 'MISSING') return 'subscription deleted';
  if (input.subscription.status === SubscriptionStatus.DELETED) return 'subscription deleted';
  if (input.subscription.trialConversion === 'LOST') return 'trial converted without its first charge';
  if (input.subscription.trialConversion === 'PENDING') return null;
  if (input.subscription.lifetime === true) return 'subscription has no end date: nothing to renew';
  if (input.subscription.planChange === 'LOST') return 'plan change without its first charge';
  if (input.subscription.planChange === 'PENDING') return null;
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

/** The checkout of a row whose first charge is an UPGRADE, as the sweep reads it. */
interface UpgradeCheckout extends TrialConversionCheckout {
  readonly createdAt: Date;
  /** Carries the trial-conversion mark (`isTrialConversionSnapshot`) when the UPGRADE converts a trial. */
  readonly planSnapshot: unknown;
}

/**
 * How long a plan change's sign-up may wait for its first charge to land before
 * the sweep stops it. The payer confirms within the checkout's lifetime (half an
 * hour), the provider charges at confirmation, and fulfilment takes seconds — a
 * day is a wide margin, and a sign-up still waiting after it will not land.
 */
export const PLAN_CHANGE_SIGN_UP_HOLD_MS = DAY_MS;

/**
 * Where the plan change a row's first charge pays for stands, for
 * `strandedReason`: «Сменить тариф» with «для автоматического списания», on a
 * subscription that is not a trial (a trial's conversion is
 * `trialConversionOf`'s). Nothing for a row whose first charge creates or
 * renews a subscription.
 *
 * Until that charge is applied the subscription is on the plan it is leaving,
 * while the row is on the plan it moves to — which the sweep would otherwise
 * read as "moved to another plan" and cancel within ten minutes, before the
 * payer even confirmed. Applied (fulfilled), the row is read like any other: a
 * later move stops it. Not applied within {@link PLAN_CHANGE_SIGN_UP_HOLD_MS},
 * it is LOST, and its later charges must not renew the old plan.
 */
export function planChangeOf(
  checkout: UpgradeCheckout | undefined,
  subscriptionId: string | null,
  subscriptionIsTrial: boolean,
  now: Date,
): { readonly planChange?: 'PENDING' | 'LOST' } {
  if (checkout === undefined || subscriptionId === null || checkout.subscriptionId !== subscriptionId) {
    return {};
  }
  if (subscriptionIsTrial || isTrialConversionSnapshot(checkout.planSnapshot)) return {};
  if (checkout.status === TransactionStatus.COMPLETED && checkout.fulfilledAt !== null) return {};
  return now.getTime() - checkout.createdAt.getTime() < PLAN_CHANGE_SIGN_UP_HOLD_MS
    ? { planChange: 'PENDING' }
    : { planChange: 'LOST' };
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
