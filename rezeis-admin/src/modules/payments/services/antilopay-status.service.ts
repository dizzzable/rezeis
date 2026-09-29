import { setTimeout as sleep } from 'node:timers/promises';

import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentGatewayType, Prisma, ProviderSubscriptionStatus, TransactionStatus } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { CHECKOUT_LIFETIME_MS } from '../constants/checkout-lifetime.constant';
import {
  PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../constants/payment-reconciliation.constant';
import {
  ANTILOPAY_NOT_FOUND,
  type AntilopayPaymentVerdict,
  classifyAntilopayPaymentStatus,
  postAntilopay,
} from '../utils/antilopay-api.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import { readOptionalString } from './payment-provider-execution.helpers';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { PaymentWebhookNormalizerService } from './payment-webhook-normalizer.service';
import { ProviderSubscriptionService } from './provider-subscription.service';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * A payment is asked about only once it is older than this: its callback, when
 * there is one, comes within seconds of the payment, and Antilopay repeats a
 * failed one every three minutes. A shorter wait would only race the callback.
 */
export const ANTILOPAY_FIRST_CHECK_AFTER_MS = 3 * MINUTE_MS;

/** How soon the same open payment is asked about again. */
export const ANTILOPAY_RECHECK_EVERY_MS = 5 * MINUTE_MS;

/**
 * Payments older than the checkout's lifetime plus this are no longer asked
 * about by the periodic sweep. The expiry sweep asks once more, itself, at the
 * moment it cancels a row; a row it keeps on hold (`paymentNeedsManualReview`)
 * would otherwise be asked about every five minutes for ever.
 */
const ANTILOPAY_SWEEP_WINDOW_MS = CHECKOUT_LIFETIME_MS + 60 * MINUTE_MS;

/**
 * When Antilopay cannot be asked (a timeout, a 5xx, a rejected key or address)
 * the expiry sweep waits for it — but not for ever: a row older than this is
 * cancelled on our own clock, as every other gateway's is, and a callback that
 * arrives later revives it.
 */
export const ANTILOPAY_GIVE_UP_AFTER_MS = CHECKOUT_LIFETIME_MS + 30 * MINUTE_MS;

/**
 * How far back a COMPLETED payment is asked about, once a day. A REVERSED
 * payment («отменен Мерчантом в день оплаты») is cancelled within a day; a
 * CHARGEBACK is a claim through the payer's bank and arrives weeks later, so
 * the month is a window, not a promise.
 */
export const ANTILOPAY_COMPLETED_WINDOW_MS = 30 * DAY_MS;

/** Rows read at a time by the daily sweep, and the pause between two questions to Antilopay. */
const COMPLETED_PAGE = 100;
const COMPLETED_THROTTLE_MS = 250;
/** Most questions one daily run asks; the rest wait for tomorrow. */
const COMPLETED_MAX_PER_RUN = 3000;
/** Most rows one periodic sweep looks at. */
const PENDING_MAX_PER_SWEEP = 200;
/** A sweep stops after this many failed questions in a row: Antilopay is not answering. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Ended subscriptions the daily run reads again at most. */
const ENDED_MAX_PER_RUN = 500;

/** `rawPayload.source` of a notice this service made from a status check. */
export const ANTILOPAY_PAYMENT_CHECK_SOURCE = 'ANTILOPAY_PAYMENT_CHECK';

/** What `payment/check` answered for one payment. */
export type AntilopayPaymentCheck =
  | {
      readonly kind: 'FOUND';
      /** Antilopay's own word: PENDING, SUCCESS, FAIL, CANCEL, EXPIRED, CHARGEBACK, REVERSED. */
      readonly status: string;
      readonly verdict: AntilopayPaymentVerdict;
      /** The answer, without `code`: what a callback would have carried. */
      readonly payload: Record<string, unknown>;
    }
  | { readonly kind: 'NOT_FOUND' };

/** A payment row as this service reads it. */
export interface AntilopayCheckedRow {
  readonly id: string;
  readonly paymentId: string;
  readonly createdAt: Date;
  readonly gatewayData: Prisma.JsonValue | null;
}

/** What the expiry sweep does with a row after the check: see `PaymentPendingExpiryService`. */
export type AntilopayExpiryVerdict = 'keep' | 'provider-terminal' | 'local-ttl';

/**
 * Asks Antilopay what became of a payment (`payment/check`), because its
 * callback is not a complete account of one.
 *
 *  1. A callback that never arrived leaves a paid invoice PENDING until the
 *     expiry sweep cancels it: the money is ours and the customer holds
 *     nothing. Antilopay repeats a callback for an hour; a panel that was down
 *     for longer loses it. So every open Antilopay payment is asked about from
 *     three minutes on, and once more at the moment it would be cancelled.
 *  2. The callback carries SUCCESS or FAIL only. A payment REVERSED by the
 *     merchant on its day, and a CHARGEBACK by the payer's bank, are told to
 *     nobody: the panel would go on treating the money as ours. So every
 *     COMPLETED payment of the last thirty days is asked about once a day.
 *
 * The answer is not applied here. It is written into the payment inbox as the
 * notice a callback would have been and settled by the reconciliation worker,
 * so the status map, the amount check, a refund's reversal (partner accruals,
 * referral rewards, cashback, tax income, the autopay it belongs to) and the
 * operator's cards are the ones every other payment gets — and a callback that
 * arrives afterwards finds the work done.
 */
@Injectable()
export class AntilopayStatusService {
  private readonly logger = new Logger(AntilopayStatusService.name);
  private pendingSweepRunning = false;
  private completedSweepRunning = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly paymentWebhookNormalizerService: PaymentWebhookNormalizerService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
    /**
     * Reads a subscription's charges again (`syncRow`), for the ended ones the
     * daily run looks after. Last and optional: specs build this positionally.
     */
    @Optional()
    private readonly providerSubscriptionService?: ProviderSubscriptionService,
  ) {}

  /**
   * Antilopay's account of one payment, by our id (`order_id`). NOT_FOUND is
   * code 8: the invoice was never created there. Every other refusal, and a
   * transport failure, throws.
   */
  public async checkPayment(settingsJson: Prisma.JsonValue, orderId: string): Promise<AntilopayPaymentCheck> {
    const settings = readGatewaySettings(settingsJson);
    const reply = await postAntilopay(this.httpService, settings, 'payment/check', { order_id: orderId });
    if (reply.code === ANTILOPAY_NOT_FOUND) {
      return { kind: 'NOT_FOUND' };
    }
    if (reply.code !== 0) {
      const detail = redactPaymentDiagnosticMessage(String(reply.data['error'] ?? 'unknown'), 120) ?? 'unknown';
      throw new Error(`Antilopay payment/check error ${reply.code}: ${detail}`);
    }
    // The answer must be about the payment asked for. It was asked by
    // `order_id`, so a different one is a mix-up on their side, and a status
    // read off it would be applied to the wrong row.
    const answered = readOptionalString(reply.data, ['order_id']);
    if (answered !== null && answered !== orderId) {
      throw new Error(`Antilopay payment/check for ${orderId} answered for order ${answered}`);
    }
    const status = readOptionalString(reply.data, ['status']);
    if (status === null) {
      throw new Error(`Antilopay payment/check for ${orderId} carries no status`);
    }
    const payload = Object.fromEntries(
      Object.entries(reply.data).filter(([key]) => key !== 'code' && key !== 'error'),
    );
    return {
      kind: 'FOUND',
      status: status.toUpperCase(),
      verdict: classifyAntilopayPaymentStatus(status),
      payload,
    };
  }

  /**
   * Every five minutes, at an offset from the expiry sweep's ticks: asks about
   * the open Antilopay payments that are old enough and not asked about lately.
   */
  @Cron('1-56/5 * * * *', { name: 'antilopay-pending-check' })
  public async sweepPending(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.pendingSweepRunning) return;
    this.pendingSweepRunning = true;
    try {
      await this.checkOpenPayments(new Date());
    } catch (error: unknown) {
      this.logger.error(`Antilopay pending check failed: ${errorText(error)}`);
    } finally {
      this.pendingSweepRunning = false;
    }
  }

  /** One pass of {@link sweepPending}; public for the specs. Returns how many payments it asked about. */
  public async checkOpenPayments(now: Date): Promise<number> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.ANTILOPAY },
      select: { settings: true },
    });
    if (gateway === null) return 0;
    const rows = await this.prismaService.transaction.findMany({
      where: {
        gatewayType: PaymentGatewayType.ANTILOPAY,
        status: TransactionStatus.PENDING,
        createdAt: {
          lt: new Date(now.getTime() - ANTILOPAY_FIRST_CHECK_AFTER_MS),
          gte: new Date(now.getTime() - ANTILOPAY_SWEEP_WINDOW_MS),
        },
      },
      select: { id: true, paymentId: true, createdAt: true, gatewayData: true },
      orderBy: { createdAt: 'asc' },
      take: PENDING_MAX_PER_SWEEP,
    });
    let asked = 0;
    let failures = 0;
    for (const row of rows) {
      if (wasCheckedWithin(row.gatewayData, ANTILOPAY_RECHECK_EVERY_MS, now)) continue;
      try {
        await this.settleOpenPayment(row, gateway.settings, now);
        asked += 1;
        failures = 0;
      } catch (error: unknown) {
        failures += 1;
        this.logger.warn(`Antilopay payment ${row.paymentId} could not be checked: ${errorText(error)}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn('Antilopay is not answering; the rest wait for the next sweep');
          break;
        }
      }
    }
    return asked;
  }

  /**
   * The expiry sweep's question, asked at the moment it would cancel an open
   * Antilopay payment on our own clock: whatever Antilopay says decides first.
   *
   *  - `keep`              paid (or reversed): the notice is queued and the
   *                        reconciliation settles the row — do not cancel it.
   *                        Also a check that failed while the row is younger
   *                        than {@link ANTILOPAY_GIVE_UP_AFTER_MS}.
   *  - `provider-terminal` Antilopay itself calls it dead.
   *  - `local-ttl`         still open there, never created there, or a check
   *                        that has kept failing: cancel on our own clock.
   */
  public async verdictBeforeExpiry(row: AntilopayCheckedRow, now: Date = new Date()): Promise<AntilopayExpiryVerdict> {
    try {
      const gateway = await this.prismaService.paymentGateway.findUnique({
        where: { type: PaymentGatewayType.ANTILOPAY },
        select: { settings: true },
      });
      if (gateway === null) throw new Error('the Antilopay gateway is not configured');
      const verdict = await this.settleOpenPayment(row, gateway.settings, now);
      switch (verdict) {
        case 'PAID':
        case 'REVERSED':
          return 'keep';
        case 'DEAD':
          return 'provider-terminal';
        default:
          return 'local-ttl';
      }
    } catch (error: unknown) {
      const age = now.getTime() - row.createdAt.getTime();
      if (age >= ANTILOPAY_GIVE_UP_AFTER_MS) {
        this.logger.warn(
          `Antilopay payment ${row.paymentId} could not be checked for ${Math.round(age / MINUTE_MS)} minutes ` +
            `(${errorText(error)}); cancelled on our own clock`,
        );
        return 'local-ttl';
      }
      this.logger.warn(`Keeping Antilopay payment ${row.paymentId} pending; it could not be checked: ${errorText(error)}`);
      return 'keep';
    }
  }

  /**
   * Asks about one open payment, stamps the answer on the row and, for a
   * status that changes what the panel does, hands the notice to the
   * reconciliation. Returns the verdict; `NOT_FOUND` and `OPEN` change nothing.
   * Throws when Antilopay could not be asked.
   */
  private async settleOpenPayment(
    row: AntilopayCheckedRow,
    settingsJson: Prisma.JsonValue,
    now: Date,
  ): Promise<AntilopayPaymentVerdict | 'NOT_FOUND'> {
    const check = await this.checkPayment(settingsJson, row.paymentId);
    if (check.kind === 'NOT_FOUND') {
      await this.stamp(row.id, 'NOT_FOUND', now, TransactionStatus.PENDING);
      return 'NOT_FOUND';
    }
    await this.stamp(row.id, check.status, now, TransactionStatus.PENDING);
    if (check.verdict === 'UNKNOWN') {
      this.logger.warn(`Antilopay payment ${row.paymentId} has a status this build does not know: ${check.status}`);
      return 'UNKNOWN';
    }
    if (check.verdict !== 'OPEN') {
      await this.handToReconciliation(row, settingsJson, check);
    }
    return check.verdict;
  }

  /** Once a day: asks about the COMPLETED Antilopay payments of the last thirty days. */
  @Cron('17 4 * * *', { name: 'antilopay-completed-recheck' })
  public async sweepCompleted(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.completedSweepRunning) return;
    this.completedSweepRunning = true;
    try {
      await this.recheckCompletedPayments(new Date());
    } catch (error: unknown) {
      this.logger.error(`Antilopay daily re-check failed: ${errorText(error)}`);
    }
    try {
      await this.recheckEndedSubscriptions(new Date());
    } catch (error: unknown) {
      this.logger.error(`Antilopay daily re-check of ended subscriptions failed: ${errorText(error)}`);
    } finally {
      this.completedSweepRunning = false;
    }
  }

  /**
   * Reads again the Antilopay subscriptions that ended, or were charged, within
   * the month: a chargeback or a refund of one of their charges comes weeks
   * after it, and a row that is no longer live is nobody's sweep. The charges
   * of a live one are read by the subscription sweep (once a day), and a
   * scheduled charge is a payment under an order id Antilopay made up, so the
   * payment check above cannot ask about it; only its recurrent lists it, with
   * its status, and `syncRow` reads that — delivering what is new, sending a
   * given-back charge through the refund reversal, ending the autopay by it.
   * The row that was read longest ago goes first, so a month with more rows
   * than one run reads them all over a few days. Returns how many it read.
   */
  public async recheckEndedSubscriptions(now: Date, options: { readonly throttleMs?: number } = {}): Promise<number> {
    if (this.providerSubscriptionService === undefined) return 0;
    const throttleMs = options.throttleMs ?? COMPLETED_THROTTLE_MS;
    const since = new Date(now.getTime() - ANTILOPAY_COMPLETED_WINDOW_MS);
    const rows = await this.prismaService.providerSubscription.findMany({
      where: {
        gatewayType: PaymentGatewayType.ANTILOPAY,
        status: ProviderSubscriptionStatus.CANCELLED,
        providerRecurrentId: { not: null },
        OR: [{ cancelledAt: { gte: since } }, { lastChargeAt: { gte: since } }],
      },
      orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
      take: ENDED_MAX_PER_RUN,
    });
    let read = 0;
    let failures = 0;
    for (const row of rows) {
      try {
        await this.providerSubscriptionService.syncRow(row);
        read += 1;
        failures = 0;
      } catch (error: unknown) {
        failures += 1;
        this.logger.warn(`Ended Antilopay subscription ${row.id} could not be read again: ${errorText(error)}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn('Antilopay is not answering; the ended subscriptions wait until tomorrow');
          break;
        }
      }
      if (throttleMs > 0) await sleep(throttleMs);
    }
    return read;
  }

  /**
   * One pass of {@link sweepCompleted}; public for the specs. Reads the rows a
   * page at a time and asks about one every {@link COMPLETED_THROTTLE_MS}, so a
   * shop with a thousand payments a month costs Antilopay a few requests a
   * second for a few minutes and never a burst. Returns how many it asked about.
   */
  public async recheckCompletedPayments(now: Date, options: { readonly throttleMs?: number } = {}): Promise<number> {
    const throttleMs = options.throttleMs ?? COMPLETED_THROTTLE_MS;
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.ANTILOPAY },
      select: { settings: true },
    });
    if (gateway === null) return 0;
    const since = new Date(now.getTime() - ANTILOPAY_COMPLETED_WINDOW_MS);
    let asked = 0;
    let failures = 0;
    let cursor: string | null = null;
    for (;;) {
      const rows: AntilopayCheckedRow[] = await this.prismaService.transaction.findMany({
        where: {
          gatewayType: PaymentGatewayType.ANTILOPAY,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: since },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        select: { id: true, paymentId: true, createdAt: true, gatewayData: true },
        orderBy: { id: 'asc' },
        take: COMPLETED_PAGE,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.id ?? null;
      for (const row of rows) {
        // A charge the autopay took is one of OUR payments for a payment id
        // Antilopay never heard: it is asked about through its autopay.
        if (isProviderSubscriptionCharge(row.gatewayData)) continue;
        if (asked >= COMPLETED_MAX_PER_RUN) {
          this.logger.warn(`Antilopay daily re-check stopped after ${asked} payments; the rest wait for tomorrow`);
          return asked;
        }
        try {
          await this.recheckCompleted(row, gateway.settings);
          asked += 1;
          failures = 0;
        } catch (error: unknown) {
          failures += 1;
          this.logger.warn(`Antilopay payment ${row.paymentId} could not be re-checked: ${errorText(error)}`);
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            this.logger.warn('Antilopay is not answering; the daily re-check stops until tomorrow');
            return asked;
          }
        }
        if (throttleMs > 0) await sleep(throttleMs);
      }
      if (rows.length < COMPLETED_PAGE) break;
    }
    return asked;
  }

  private async recheckCompleted(row: AntilopayCheckedRow, settingsJson: Prisma.JsonValue): Promise<void> {
    const check = await this.checkPayment(settingsJson, row.paymentId);
    if (check.kind === 'NOT_FOUND') return;
    if (check.verdict === 'REVERSED') {
      this.logger.warn(`Antilopay reports payment ${row.paymentId} as ${check.status}; handing it to the refund path`);
      await this.handToReconciliation(row, settingsJson, check);
      return;
    }
    if (check.verdict !== 'PAID') {
      // A completed payment that Antilopay now calls open or dead is not
      // something a status can undo; someone should look, nothing is changed.
      this.logger.warn(
        `Antilopay reports the completed payment ${row.paymentId} as ${check.status}; nothing changed`,
      );
    }
  }

  private async stamp(transactionId: string, status: string, now: Date, onlyIfStatus: TransactionStatus): Promise<void> {
    await writeTransactionGatewayData(this.prismaService, transactionId, {
      onlyIfStatus,
      merge: { antilopayCheckedAt: now.toISOString(), antilopayStatus: status },
    });
  }

  /**
   * Writes the answer into the payment inbox as the notice a callback would
   * have been, and queues its reconciliation. The key names the payment and the
   * status, so asking again for the same status is recognised as the same
   * notice (identical payload) and settles nothing twice, while a callback
   * keeps its own row.
   */
  private async handToReconciliation(
    row: AntilopayCheckedRow,
    settingsJson: Prisma.JsonValue,
    check: Extract<AntilopayPaymentCheck, { readonly kind: 'FOUND' }>,
  ): Promise<void> {
    const rawBody = Buffer.from(
      JSON.stringify({ ...check.payload, order_id: row.paymentId, source: ANTILOPAY_PAYMENT_CHECK_SOURCE }),
      'utf8',
    );
    const envelope = {
      ...this.paymentWebhookNormalizerService.normalizeWebhook({
        gatewayType: PaymentGatewayType.ANTILOPAY,
        rawBody,
        headers: {},
        clientIp: null,
        gatewaySettings: settingsJson,
        verifySignature: false,
      }),
      providerEventId: `antilopay-check:${row.paymentId}:${check.status}`,
    };
    const received = await this.paymentWebhookInboxService.recordReceived({ envelope });
    if (received.duplicate) return;
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
      await this.paymentWebhookInboxService.markFailed(received.event.id, PAYMENT_RECONCILIATION_ENQUEUE_FAILED);
      throw error;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Whether the row was asked about within `windowMs` before `now` (`antilopayCheckedAt`). */
function wasCheckedWithin(gatewayData: Prisma.JsonValue | null, windowMs: number, now: Date): boolean {
  const stamp = asRecord(gatewayData)?.['antilopayCheckedAt'];
  if (typeof stamp !== 'string') return false;
  const checkedAt = Date.parse(stamp);
  return Number.isFinite(checkedAt) && now.getTime() - checkedAt < windowMs;
}

/** A payment the panel made for a charge of an autopay (`PROVIDER_SUBSCRIPTION_CHARGE`). */
function isProviderSubscriptionCharge(gatewayData: Prisma.JsonValue | null): boolean {
  return asRecord(gatewayData)?.['snapshotSource'] === 'PROVIDER_SUBSCRIPTION_CHARGE';
}
