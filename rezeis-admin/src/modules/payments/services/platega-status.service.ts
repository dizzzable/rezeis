import { setTimeout as sleep } from 'node:timers/promises';

import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentGatewayType, Prisma, TransactionStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { CHECKOUT_LIFETIME_MS } from '../constants/checkout-lifetime.constant';
import {
  PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../constants/payment-reconciliation.constant';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { readProviderSubscriptionTerms } from '../utils/provider-subscription-terms.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import { readOptionalString, readRecord, requireSetting } from './payment-provider-execution.helpers';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { PaymentWebhookNormalizerService } from './payment-webhook-normalizer.service';
import { isProviderCreationClaim } from './payments-checkout.service';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const PLATEGA_API = 'https://app.platega.io';

/**
 * A payment is asked about only once it is older than this: its callback, when
 * it arrives at all, comes within seconds of the payment.
 */
export const PLATEGA_FIRST_CHECK_AFTER_MS = 3 * MINUTE_MS;

/**
 * How old the last question about an open payment must be before it is asked
 * again: under the five-minute tick, so a tick that starts a little early
 * never skips the payment for a whole round.
 */
export const PLATEGA_RECHECK_EVERY_MS = 4 * MINUTE_MS;

/**
 * Open payments older than the checkout's lifetime plus this are no longer
 * asked about by the periodic sweep: the expiry sweep asks once more itself,
 * and a row it keeps on hold would otherwise be asked about for ever.
 */
const PLATEGA_SWEEP_WINDOW_MS = CHECKOUT_LIFETIME_MS + 60 * MINUTE_MS;

/**
 * When Platega cannot be asked, the expiry sweep waits for it — but not for
 * ever: a row older than this is cancelled on our own clock, as before, and the
 * lapsed sweep asks about it later.
 */
export const PLATEGA_GIVE_UP_AFTER_MS = CHECKOUT_LIFETIME_MS + 30 * MINUTE_MS;

/**
 * How far back a payment cancelled on our own clock is asked about again. Seven
 * days reach back past the callbacks lost on 05.11.2026 to the release that
 * brings this check.
 */
export const PLATEGA_LAPSED_WINDOW_MS = 7 * DAY_MS;
/** How old the last question about a lapsed payment must be: under the hourly tick, for the same reason. */
const PLATEGA_LAPSED_RECHECK_EVERY_MS = 55 * MINUTE_MS;

/** Rows read at a time, in all at most, and the questions one sweep asks at most. */
const PAGE = 200;
const MAX_READ = 2_000;
const MAX_ASKS = 200;
/** The pause between two questions of the hourly sweep: its rows are not urgent. */
const LAPSED_THROTTLE_MS = 250;
/** A sweep stops after this many failed questions in a row: Platega is not answering. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** After that many failed expiry checks in a row, the expiry sweep stops asking for this long. */
const EXPIRY_BREAKER_MS = 4 * MINUTE_MS;
/** A question to Platega ends by this: the expiry sweep asks one row at a time. */
const REQUEST_TIMEOUT_MS = 15_000;

/** `rawPayload.source` of a notice this service made from a status check. */
export const PLATEGA_PAYMENT_CHECK_SOURCE = 'PLATEGA_PAYMENT_CHECK';

/** What a Platega status means for the panel. */
export type PlategaPaymentVerdict = 'OPEN' | 'PAID' | 'DEAD' | 'REVERSED' | 'UNKNOWN';

/**
 * Platega's statuses of a payment (`GET /transaction/{id}` and the callbacks).
 * PARTIALLY_REFUNDED and DISPUTED say money did arrive and something happened
 * to it since: on a payment the panel never completed, neither says what to do,
 * so they are UNKNOWN — stamped, logged, and left to the operator.
 */
export function classifyPlategaPaymentStatus(status: string): PlategaPaymentVerdict {
  switch (status.trim().toUpperCase()) {
    case 'PENDING':
      return 'OPEN';
    case 'CONFIRMED':
      return 'PAID';
    case 'CANCELED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
    case 'DECLINED':
      return 'DEAD';
    case 'CHARGEBACKED':
      return 'REVERSED';
    default:
      return 'UNKNOWN';
  }
}

/** The statuses after which a lapsed payment is not asked about again. */
const SETTLED_VERDICTS: ReadonlySet<PlategaPaymentVerdict> = new Set(['PAID', 'DEAD', 'REVERSED']);

/** What `GET /transaction/{id}` answered for one payment. */
export type PlategaPaymentCheck =
  | {
      readonly kind: 'FOUND';
      /** Platega's own word, upper-cased. */
      readonly status: string;
      readonly verdict: PlategaPaymentVerdict;
      /** The answer in the shape of Platega's callback, which the normalizer reads. */
      readonly payload: Record<string, unknown>;
    }
  | { readonly kind: 'NOT_FOUND' };

/** A payment row as this service reads it. */
export interface PlategaCheckedRow {
  readonly id: string;
  readonly paymentId: string;
  readonly createdAt: Date;
  /** Platega's id of the payment: what it is asked by. */
  readonly gatewayId: string | null;
  readonly gatewayData: Prisma.JsonValue | null;
  /** Tells a subscription sign-up, whose id is the subscription's (`readProviderSubscriptionTerms`). */
  readonly planSnapshot: Prisma.JsonValue;
}

/** What the expiry sweep does with a row after the check: see `PaymentPendingExpiryService`. */
export type PlategaExpiryVerdict = 'keep' | 'provider-terminal' | 'local-ttl';

/**
 * Asks Platega what became of a one-off payment (`GET /transaction/{id}`),
 * because its callback may never come.
 *
 * Platega tries a callback three times over half an hour and then gives up
 * («сам по себе колбэк больше не придёт»). On 05.11.2026 every callback to an
 * operator's panel failed on their side's TLS handshake, and two paid payments
 * were cancelled by the expiry sweep: the money was ours, the customers held
 * nothing. Platega's own answer to that is «Текущий статус платежа всегда
 * доступен запросом GET /transaction/{id}». So:
 *
 *  1. Every open one-off Platega payment is asked about from three minutes on,
 *     every five minutes, and once more at the moment the expiry sweep would
 *     cancel it — which then cancels only what Platega calls dead, or what
 *     Platega could not be asked about for an hour.
 *  2. Every hour, payments of the last seven days the panel cancelled on its
 *     own clock and never completed are asked about until Platega names an end:
 *     a confirmed one is revived and delivered like any late payment.
 *
 * A subscription sign-up is not asked about here: its checkout's id is the
 * subscription's, which `ProviderSubscriptionService` reads every ten minutes.
 *
 * The answer is not applied here. It is written into the payment inbox as the
 * notice a callback would have been and settled by the reconciliation worker,
 * as `AntilopayStatusService` does, so the status map, the amount check, a
 * revival and the operator's cards are the ones every other payment gets — and
 * a callback that arrives afterwards finds the work done.
 */
@Injectable()
export class PlategaStatusService {
  private readonly logger = new Logger(PlategaStatusService.name);
  private pendingSweepRunning = false;
  private lapsedSweepRunning = false;
  /** Failed expiry checks in a row, and until when the breaker they open holds. */
  private expiryFailures = 0;
  private expiryBreakerUntil = 0;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly paymentWebhookNormalizerService: PaymentWebhookNormalizerService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
  ) {}

  /**
   * Platega's account of one payment, by its own id. NOT_FOUND is a 404: no
   * such payment there. Every other refusal, and a transport failure, throws.
   */
  public async checkPayment(
    settingsJson: Prisma.JsonValue,
    providerPaymentId: string,
    paymentId: string,
  ): Promise<PlategaPaymentCheck> {
    const settings = readGatewaySettings(settingsJson);
    const response = await firstValueFrom(
      this.httpService.get(`${PLATEGA_API}/transaction/${encodeURIComponent(providerPaymentId)}`, {
        headers: { 'X-MerchantId': requireSetting(settings, 'merchantId'), 'X-Secret': requireSetting(settings, 'secret') },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }),
    );
    if (response.status === 404) {
      return { kind: 'NOT_FOUND' };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Platega GET transaction returned HTTP ${response.status}`);
    }
    const data = readRecord(response.data);
    // The answer must be about the payment asked for, and that payment must be
    // ours: a status read off another one would be applied to the wrong row.
    const answeredId = readOptionalString(data, ['id', 'transactionId']);
    if (answeredId !== null && answeredId !== providerPaymentId) {
      throw new Error(`Platega GET transaction ${providerPaymentId} answered for ${answeredId}`);
    }
    const answeredPayload = readOptionalString(data, ['payload']);
    if (answeredPayload !== null && answeredPayload !== paymentId) {
      throw new Error(`Platega transaction ${providerPaymentId} carries another payment's payload`);
    }
    const status = readOptionalString(data, ['status']);
    if (status === null) {
      throw new Error(`Platega GET transaction ${providerPaymentId} carries no status`);
    }
    const details = readRecord(data['paymentDetails']);
    return {
      kind: 'FOUND',
      status: status.toUpperCase(),
      verdict: classifyPlategaPaymentStatus(status),
      // The fields of Platega's callback for a one-off payment, from where the
      // answer keeps them; `payload` is ours, so the notice names our payment.
      payload: {
        id: providerPaymentId,
        amount: details['amount'] ?? data['amount'] ?? null,
        currency: details['currency'] ?? data['currency'] ?? null,
        status: status.toUpperCase(),
        paymentMethod: data['paymentMethod'] ?? null,
        payload: paymentId,
      },
    };
  }

  /** Every five minutes, at an offset from the expiry sweep's ticks: the open payments. */
  @Cron('3-58/5 * * * *', { name: 'platega-pending-check' })
  public async sweepPending(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.pendingSweepRunning) return;
    this.pendingSweepRunning = true;
    try {
      await this.checkOpenPayments(new Date());
    } catch (error: unknown) {
      this.logger.error(`Platega pending check failed: ${errorText(error)}`);
    } finally {
      this.pendingSweepRunning = false;
    }
  }

  /**
   * One pass of {@link sweepPending}; public for the specs. Returns how many
   * payments it asked about. Rows not asked about lately go in the order they
   * were last asked, never-asked first.
   */
  public async checkOpenPayments(now: Date): Promise<number> {
    const gateway = await this.readGateway();
    if (gateway === null) return 0;
    const rows = await this.readRows({
      status: TransactionStatus.PENDING,
      createdAt: {
        lt: new Date(now.getTime() - PLATEGA_FIRST_CHECK_AFTER_MS),
        gte: new Date(now.getTime() - PLATEGA_SWEEP_WINDOW_MS),
      },
    });
    const due = rows
      .filter((row) => isAskable(row) && !wasCheckedWithin(row.gatewayData, PLATEGA_RECHECK_EVERY_MS, now))
      .sort((left, right) => stampOf(left.gatewayData) - stampOf(right.gatewayData))
      .slice(0, MAX_ASKS);
    return this.askEach(due, (row) => this.settleOpenPayment(row, gateway.settings, now), 0);
  }

  /** Every hour: the payments cancelled on our own clock that Platega may have taken. */
  @Cron('41 * * * *', { name: 'platega-lapsed-check' })
  public async sweepLapsed(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.lapsedSweepRunning) return;
    this.lapsedSweepRunning = true;
    try {
      await this.checkLapsedPayments(new Date());
    } catch (error: unknown) {
      this.logger.error(`Platega lapsed check failed: ${errorText(error)}`);
    } finally {
      this.lapsedSweepRunning = false;
    }
  }

  /**
   * One pass of {@link sweepLapsed}; public for the specs. A cancelled payment
   * that was never completed (`fulfilledAt` null — a refunded one was) is asked
   * about until Platega names an end; only a confirmed one goes on, to be
   * revived by the reconciliation.
   */
  public async checkLapsedPayments(now: Date, options: { readonly throttleMs?: number } = {}): Promise<number> {
    const gateway = await this.readGateway();
    if (gateway === null) return 0;
    // Newest first: past {@link MAX_READ} rows a busy shop's oldest abandoned
    // checkouts wait, not the payment made a minute before the sweep.
    const rows = await this.readRows(
      {
        status: TransactionStatus.CANCELED,
        fulfilledAt: null,
        createdAt: { gte: new Date(now.getTime() - PLATEGA_LAPSED_WINDOW_MS) },
      },
      'desc',
    );
    const due = rows
      .filter(
        (row) =>
          isAskable(row) &&
          !hasSettledAnswer(row.gatewayData) &&
          !wasCheckedWithin(row.gatewayData, PLATEGA_LAPSED_RECHECK_EVERY_MS, now),
      )
      .sort((left, right) => stampOf(left.gatewayData) - stampOf(right.gatewayData))
      .slice(0, MAX_ASKS);
    const asked = await this.askEach(
      due,
      async (row) => {
        const check = await this.checkPayment(gateway.settings, row.gatewayId as string, row.paymentId);
        const status = check.kind === 'FOUND' ? check.status : 'NOT_FOUND';
        await this.stamp(row.id, status, now, TransactionStatus.CANCELED);
        if (check.kind === 'FOUND' && check.verdict === 'PAID') {
          this.logger.warn(`Platega confirms payment ${row.paymentId}, which the panel had cancelled; reviving it`);
          await this.handToReconciliation(row, gateway.settings, check);
        }
      },
      options.throttleMs ?? LAPSED_THROTTLE_MS,
    );
    return asked;
  }

  /**
   * The expiry sweep's question, asked at the moment it would cancel an open
   * Platega payment on our own clock: whatever Platega says decides first.
   *
   *  - `keep`              paid (or charged back): the notice is queued and the
   *                        reconciliation settles the row. Also still open at
   *                        Platega, or a check that failed, while the row is
   *                        younger than {@link PLATEGA_GIVE_UP_AFTER_MS}.
   *  - `provider-terminal` Platega itself calls it dead.
   *  - `local-ttl`         a sign-up, no Platega id, unknown there, or a row
   *                        past the give-up age: cancel on our own clock.
   */
  public async verdictBeforeExpiry(row: PlategaCheckedRow, now: Date = new Date()): Promise<PlategaExpiryVerdict> {
    if (!isAskable(row)) return 'local-ttl';
    // Three failed checks in a row open a breaker: the expiry sweep asks one row
    // at a time, and every further row would wait out its own timeout.
    if (now.getTime() < this.expiryBreakerUntil) {
      return this.unverifiedVerdict(row, now, 'Platega was not answering a moment ago');
    }
    try {
      const gateway = await this.readGateway();
      if (gateway === null) throw new Error('the Platega gateway is not configured');
      const verdict = await this.settleOpenPayment(row, gateway.settings, now);
      this.expiryFailures = 0;
      switch (verdict) {
        case 'PAID':
        case 'REVERSED':
          return 'keep';
        case 'DEAD':
          return 'provider-terminal';
        case 'OPEN':
          return this.unverifiedVerdict(row, now, 'Platega still calls it open');
        default:
          return 'local-ttl';
      }
    } catch (error: unknown) {
      this.expiryFailures += 1;
      if (this.expiryFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.expiryFailures = 0;
        this.expiryBreakerUntil = now.getTime() + EXPIRY_BREAKER_MS;
        this.logger.warn(
          `Platega failed ${MAX_CONSECUTIVE_FAILURES} expiry checks in a row (${errorText(error)}); ` +
            `not asking for ${EXPIRY_BREAKER_MS / MINUTE_MS} minutes`,
        );
      }
      return this.unverifiedVerdict(row, now, errorText(error));
    }
  }

  /** What the expiry sweep does with a row whose end Platega did not name. */
  private unverifiedVerdict(row: PlategaCheckedRow, now: Date, why: string): PlategaExpiryVerdict {
    const age = now.getTime() - row.createdAt.getTime();
    if (age >= PLATEGA_GIVE_UP_AFTER_MS) {
      this.logger.warn(
        `Platega payment ${row.paymentId} has no end from Platega after ${Math.round(age / MINUTE_MS)} minutes ` +
          `(${why}); cancelled on our own clock, and asked about again hourly`,
      );
      return 'local-ttl';
    }
    this.logger.warn(`Keeping Platega payment ${row.paymentId} pending: ${why}`);
    return 'keep';
  }

  /**
   * Asks about one open payment, stamps the answer on the row and, for a status
   * that changes what the panel does, hands the notice to the reconciliation.
   * Throws when Platega could not be asked.
   */
  private async settleOpenPayment(
    row: PlategaCheckedRow,
    settingsJson: Prisma.JsonValue,
    now: Date,
  ): Promise<PlategaPaymentVerdict | 'NOT_FOUND'> {
    const check = await this.checkPayment(settingsJson, row.gatewayId as string, row.paymentId);
    if (check.kind === 'NOT_FOUND') {
      await this.stamp(row.id, 'NOT_FOUND', now, TransactionStatus.PENDING);
      return 'NOT_FOUND';
    }
    await this.stamp(row.id, check.status, now, TransactionStatus.PENDING);
    if (check.verdict === 'UNKNOWN') {
      this.logger.warn(`Platega payment ${row.paymentId} has a status this build does not act on: ${check.status}`);
      return 'UNKNOWN';
    }
    if (check.verdict !== 'OPEN') {
      await this.handToReconciliation(row, settingsJson, check);
    }
    return check.verdict;
  }

  /** Asks about each row in turn; stops after three failures in a row. */
  private async askEach(
    rows: readonly PlategaCheckedRow[],
    ask: (row: PlategaCheckedRow) => Promise<unknown>,
    throttleMs: number,
  ): Promise<number> {
    let asked = 0;
    let failures = 0;
    for (const row of rows) {
      if (asked > 0 && throttleMs > 0) await sleep(throttleMs);
      try {
        await ask(row);
        asked += 1;
        failures = 0;
      } catch (error: unknown) {
        failures += 1;
        this.logger.warn(`Platega payment ${row.paymentId} could not be checked: ${errorText(error)}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn('Platega is not answering; the rest wait for the next sweep');
          break;
        }
      }
    }
    return asked;
  }

  private async readGateway(): Promise<{ readonly settings: Prisma.JsonValue } | null> {
    return this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.PLATEGA },
      select: { settings: true },
    });
  }

  /** Platega payments matching `where` that carry Platega's id, a page at a time. */
  private async readRows(
    where: Prisma.TransactionWhereInput,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<PlategaCheckedRow[]> {
    const rows: PlategaCheckedRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: PlategaCheckedRow[] = await this.prismaService.transaction.findMany({
        where: {
          ...where,
          gatewayType: PaymentGatewayType.PLATEGA,
          gatewayId: { not: null },
          ...(cursor === null ? {} : { id: order === 'asc' ? { gt: cursor } : { lt: cursor } }),
        },
        select: { id: true, paymentId: true, createdAt: true, gatewayId: true, gatewayData: true, planSnapshot: true },
        orderBy: { id: order },
        take: PAGE,
      });
      rows.push(...page);
      if (page.length < PAGE || rows.length >= MAX_READ) break;
      cursor = page[page.length - 1]?.id ?? null;
    }
    return rows;
  }

  private async stamp(transactionId: string, status: string, now: Date, onlyIfStatus: TransactionStatus): Promise<void> {
    await writeTransactionGatewayData(this.prismaService, transactionId, {
      onlyIfStatus,
      merge: { plategaCheckedAt: now.toISOString(), plategaStatus: status },
    });
  }

  /**
   * Writes the answer into the payment inbox as the notice a callback would
   * have been, and queues its reconciliation. The key names the payment and the
   * status, so asking again for the same status is the same notice and settles
   * nothing twice, while a callback keeps its own row.
   */
  private async handToReconciliation(
    row: PlategaCheckedRow,
    settingsJson: Prisma.JsonValue,
    check: Extract<PlategaPaymentCheck, { readonly kind: 'FOUND' }>,
  ): Promise<void> {
    const rawBody = Buffer.from(JSON.stringify({ ...check.payload, source: PLATEGA_PAYMENT_CHECK_SOURCE }), 'utf8');
    const envelope = {
      ...this.paymentWebhookNormalizerService.normalizeWebhook({
        gatewayType: PaymentGatewayType.PLATEGA,
        rawBody,
        headers: {},
        clientIp: null,
        gatewaySettings: settingsJson,
        verifySignature: false,
      }),
      providerEventId: `platega-check:${row.paymentId}:${check.status}`,
    };
    const received = await this.paymentWebhookInboxService.recordReceived({ envelope });
    if (received.duplicate) return;
    await this.paymentWebhookInboxService.markEnqueued(received.event.id);
    try {
      await runPaymentReconciliationEnqueueWithTimeout(() =>
        this.paymentReconciliationQueue.add(
          PAYMENT_RECONCILIATION_JOB,
          { eventId: received.event.id, paymentId: received.event.paymentId, gatewayType: received.event.gatewayType },
          { removeOnComplete: 100, removeOnFail: 100 },
        ),
      );
    } catch (error: unknown) {
      await this.paymentWebhookInboxService.markFailed(received.event.id, PAYMENT_RECONCILIATION_ENQUEUE_FAILED);
      throw error;
    }
  }
}

/**
 * A row Platega can be asked about by its own id: a one-off payment whose id is
 * Platega's. A sign-up's id is its subscription's, and a creation claim's is a
 * placeholder of ours.
 */
function isAskable(row: PlategaCheckedRow): boolean {
  return (
    row.gatewayId !== null &&
    row.gatewayId.length > 0 &&
    !isProviderCreationClaim(row.gatewayId) &&
    readProviderSubscriptionTerms(row.planSnapshot) === null &&
    asRecord(row.gatewayData)?.['snapshotSource'] !== 'PROVIDER_SUBSCRIPTION_CHARGE'
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** When the row was last asked about, as a number to sort by; a row never asked sorts first. */
function stampOf(gatewayData: Prisma.JsonValue | null): number {
  const stamp = asRecord(gatewayData)?.['plategaCheckedAt'];
  const parsed = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Whether the row was asked about within `windowMs` before `now`. */
function wasCheckedWithin(gatewayData: Prisma.JsonValue | null, windowMs: number, now: Date): boolean {
  const checkedAt = stampOf(gatewayData);
  return checkedAt > 0 && now.getTime() - checkedAt < windowMs;
}

/**
 * Whether Platega already named an end for the row: a final status, or no such
 * payment there at all. «Open» and a status this build does not act on are not.
 */
function hasSettledAnswer(gatewayData: Prisma.JsonValue | null): boolean {
  const status = asRecord(gatewayData)?.['plategaStatus'];
  return (
    typeof status === 'string' &&
    (status === 'NOT_FOUND' || SETTLED_VERDICTS.has(classifyPlategaPaymentStatus(status)))
  );
}
