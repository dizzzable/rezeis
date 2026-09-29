import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { PaymentGatewayType } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import {
  ANTILOPAY_PAYMENT_CHECK_JOB,
  PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../constants/payment-reconciliation.constant';
import { PaymentWebhookIngressResultInterface } from '../interfaces/payment-webhook-envelope.interface';
import {
  PAYMENT_WEBHOOK_STATUS_ENQUEUED,
  PaymentWebhookInboxService,
} from './payment-webhook-inbox.service';
import { PaymentWebhookNormalizerService } from './payment-webhook-normalizer.service';
import { PaymentMethodSetupService } from './payment-method-setup.service';
import { isRefundProviderStatus } from './payment-reconciliation.service';
import { ProviderSubscriptionService, type ProviderSubscriptionChargeback } from './provider-subscription.service';

interface IngestWebhookInput {
  readonly gatewayType: PaymentGatewayType;
  readonly rawBody: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly clientIp: string | null;
  readonly verifySignature: boolean;
}

@Injectable()
export class PaymentWebhookIngressService {
  private readonly logger = new Logger(PaymentWebhookIngressService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentWebhookNormalizerService: PaymentWebhookNormalizerService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    private readonly paymentMethodSetupService: PaymentMethodSetupService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
    private readonly providerSubscriptionService: ProviderSubscriptionService,
    private readonly systemEventsService: SystemEventsService,
  ) {}

  /**
   * «ВЕБХУК ПЛАТЁЖКИ» — one card per notification this panel ACCEPTED.
   *
   * The type was registered with the rest of the catalogue and raised by
   * nothing, so an operator could tick it in «Доставка в Telegram» and never
   * hear from it. The reason it stayed unbuilt is real and worth writing down:
   * a provider sends several notifications per payment and retries the ones it
   * is unsure about, so the naive version is a card per ping. Two rules keep it
   * to one card per FACT:
   *
   *   * a RE-DELIVERY of a PAYMENT notification raises nothing. The inbox
   *     recognises it by the provider's own event id together with the body
   *     hash, and a byte-identical repeat is not a new event — that is the
   *     retry storm, and it is where the volume lives. Be precise about the
   *     scope: the other three kinds return before the inbox is touched, so
   *     a re-delivered card binding or subscription callback DOES raise
   *     another card. They have no row to be recognised by — deduplicating
   *     them would mean storing one, which is a change to the ingress and
   *     not to this card;
   *   * a REFUSED webhook raises nothing either: a bad signature or an unknown
   *     gateway throws before this is reached, and each already has its own
   *     alarm. This card means "accepted", not "arrived".
   *
   * It is still the noisiest card in the catalogue by some way — roughly one
   * per payment — which is why it is INFO and why it has to be ticked
   * deliberately under «Только выбранные события».
   */
  private announceWebhook(
    gatewayType: PaymentGatewayType,
    kind: 'payment' | 'subscription-status' | 'subscription-charge' | 'card-binding' | 'refund',
    metadata: Record<string, unknown> = {},
  ): void {
    this.systemEventsService.info(
      EVENT_TYPES.PAYMENT_WEBHOOK_RECEIVED,
      'PAYMENT',
      `Payment webhook accepted from ${gatewayType} (${kind})`,
      { gatewayType, webhookKind: kind, ...metadata },
    );
  }


  public async verifyWebhookSignature(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawBody: Buffer;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly clientIp: string | null;
  }): Promise<void> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: input.gatewayType },
    });
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    this.paymentWebhookNormalizerService.verifyWebhookSignature({
      ...input,
      gatewaySettings: gateway.settings,
    });
  }

  public async ingestWebhook(
    input: IngestWebhookInput,
  ): Promise<PaymentWebhookIngressResultInterface> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: input.gatewayType },
    });
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }

    // YooKassa `payment_method.*` events (zero-amount card binding) carry a
    // payment_method object, not a payment, so the paymentId-centric pipeline
    // below can't handle them. Verify the source and route to the setup
    // service. Handled idempotently there; a re-delivery is a safe no-op.
    const paymentMethodEvent = extractYookassaPaymentMethodEvent(
      input.gatewayType,
      input.rawBody,
    );
    if (paymentMethodEvent !== null) {
      if (input.verifySignature) {
        this.paymentWebhookNormalizerService.verifyWebhookSignature({
          gatewayType: input.gatewayType,
          rawBody: input.rawBody,
          headers: input.headers,
          clientIp: input.clientIp,
          gatewaySettings: gateway.settings,
        });
      }
      await this.paymentMethodSetupService.handleYookassaPaymentMethodEvent(
        paymentMethodEvent.object,
      );
      this.announceWebhook(input.gatewayType, 'card-binding');
      return { accepted: true, duplicate: false, lifecycleStatus: PAYMENT_WEBHOOK_STATUS_ENQUEUED };
    }

    // Platega posts a subscription's callbacks to the same address as a
    // payment's. A charge callback is a payment callback plus `SubscriptionId`;
    // a status callback carries the subscription's id as `Id` and a
    // `SUBSCRIPTION_*` status. Neither names a payment of ours, so the pipeline
    // below would look for one and fail. Both only trigger a fresh read of the
    // subscription, which decides what, if anything, was paid.
    const plategaSubscriptionId = extractPlategaSubscriptionId(input.gatewayType, input.rawBody);
    if (plategaSubscriptionId !== null) {
      if (input.verifySignature) {
        this.paymentWebhookNormalizerService.verifyWebhookSignature({
          gatewayType: input.gatewayType,
          rawBody: input.rawBody,
          headers: input.headers,
          clientIp: input.clientIp,
          gatewaySettings: gateway.settings,
        });
      }
      this.announceWebhook(input.gatewayType, 'subscription-status', {
        providerSubscriptionId: plategaSubscriptionId,
      });
      // A chargeback (or a refund) on a subscription charge is the refund of
      // one of its payments. A sync only counts charges and never reverses one,
      // so it goes to the refund reversal every other refund takes, which also
      // ends the autopay (`ProviderSubscriptionService.handleChargeback`).
      // Recorded in the payment inbox before anything else: its handling asks
      // Platega first, and an outage then leaves it FAILED — retried and
      // replayable — rather than dropped (`recordDispute`).
      const dispute = extractPlategaSubscriptionDispute(input.gatewayType, input.rawBody);
      if (dispute !== null) {
        const recorded = await this.providerSubscriptionService.recordDispute(
          input.gatewayType,
          plategaSubscriptionId,
          dispute,
          // Parsed already by the line above, which found the dispute in it.
          JSON.parse(input.rawBody.toString('utf8')) as unknown,
        );
        return {
          accepted: true,
          duplicate: recorded.duplicate,
          lifecycleStatus: PAYMENT_WEBHOOK_STATUS_ENQUEUED,
        };
      }
      await this.providerSubscriptionService.enqueueSync(input.gatewayType, plategaSubscriptionId);
      return { accepted: true, duplicate: false, lifecycleStatus: PAYMENT_WEBHOOK_STATUS_ENQUEUED };
    }

    // RollyPay posts a subscription's charges as ordinary payment events, with
    // an `order_id` RollyPay made up itself («Не разбирайте автоматически
    // сформированный order_id») and without the subscription's id, which only
    // the payment object carries. An order that is not one of our payments is
    // therefore looked up by its payment instead of failing the pipeline below.
    const rollypayForeignPaymentId = await this.findRollypayForeignPaymentId(input.gatewayType, input.rawBody);
    if (rollypayForeignPaymentId !== null) {
      if (input.verifySignature) {
        this.paymentWebhookNormalizerService.verifyWebhookSignature({
          gatewayType: input.gatewayType,
          rawBody: input.rawBody,
          headers: input.headers,
          clientIp: input.clientIp,
          gatewaySettings: gateway.settings,
        });
      }
      this.announceWebhook(input.gatewayType, 'subscription-charge', {
        providerPaymentId: rollypayForeignPaymentId,
      });
      await this.providerSubscriptionService.enqueuePaymentLookup(input.gatewayType, rollypayForeignPaymentId);
      return { accepted: true, duplicate: false, lifecycleStatus: PAYMENT_WEBHOOK_STATUS_ENQUEUED };
    }

    // An Antilopay refund's callback (`type: refund`) names the refund and the
    // payment, and no order. It used to run the pipeline below as a payment
    // notice with an unknown status and change nothing, so a refund made in the
    // cabinet after the payment day was never seen. It is a reason to look: the
    // payment lists its refunds, and the refund path books each one.
    const antilopayRefund = readAntilopayRefundCallback(input.gatewayType, input.rawBody);
    if (antilopayRefund !== null) {
      if (input.verifySignature) {
        this.paymentWebhookNormalizerService.verifyWebhookSignature({
          gatewayType: input.gatewayType,
          rawBody: input.rawBody,
          headers: input.headers,
          clientIp: input.clientIp,
          gatewaySettings: gateway.settings,
        });
      }
      this.announceWebhook(input.gatewayType, 'refund', { providerPaymentId: antilopayRefund.providerPaymentId });
      if (antilopayRefund.status === 'COMPLETE') {
        await this.lookAtAntilopayRefund(antilopayRefund.providerPaymentId);
      }
      return { accepted: true, duplicate: false, lifecycleStatus: PAYMENT_WEBHOOK_STATUS_ENQUEUED };
    }

    // Antilopay puts `recurrent_id` on a payment that is part of a repeat-charge
    // subscription: the sign-up's own first payment, and every charge after it.
    // A charge's `order_id` is not one of ours (Antilopay makes it up when it
    // charges on its schedule), so the pipeline below would look for a payment
    // that does not exist and fail. Such a callback is only a reason to look:
    // the subscription is read with our own keys, and each charge it lists is
    // delivered once, under its own payment id. The first payment carries OUR
    // order and goes down the ordinary pipeline too — it completes the checkout
    // — with the same look queued after it, which is what links the sign-up to
    // its recurrent.
    const antilopayRecurrent = readAntilopayCallbackReferences(input.gatewayType, input.rawBody);
    let recurrentFollowUp: AntilopayCallbackReferences | null = null;
    if (antilopayRecurrent !== null) {
      const ours =
        antilopayRecurrent.orderId === null
          ? null
          : await this.prismaService.transaction.findUnique({
              where: { paymentId: antilopayRecurrent.orderId },
              select: { id: true },
            });
      if (ours === null) {
        if (input.verifySignature) {
          this.paymentWebhookNormalizerService.verifyWebhookSignature({
            gatewayType: input.gatewayType,
            rawBody: input.rawBody,
            headers: input.headers,
            clientIp: input.clientIp,
            gatewaySettings: gateway.settings,
          });
        }
        this.announceWebhook(input.gatewayType, 'subscription-charge', {
          providerRecurrentId: antilopayRecurrent.recurrentId,
          ...(antilopayRecurrent.paymentId === null ? {} : { providerPaymentId: antilopayRecurrent.paymentId }),
        });
        await this.providerSubscriptionService.enqueueRecurrentSync(
          input.gatewayType,
          antilopayRecurrent.recurrentId,
          null,
          { paymentId: antilopayRecurrent.paymentId, status: antilopayRecurrent.status },
        );
        return { accepted: true, duplicate: false, lifecycleStatus: PAYMENT_WEBHOOK_STATUS_ENQUEUED };
      }
      recurrentFollowUp = antilopayRecurrent;
    }

    const envelope = this.paymentWebhookNormalizerService.normalizeWebhook({
      gatewayType: input.gatewayType,
      rawBody: input.rawBody,
      headers: input.headers,
      clientIp: input.clientIp,
      gatewaySettings: gateway.settings,
      verifySignature: input.verifySignature,
    });

    const receivedEvent = await this.paymentWebhookInboxService.recordReceived({ envelope });
    if (!receivedEvent.duplicate) {
      // Inside the not-a-duplicate branch on purpose: see `announceWebhook`.
      this.announceWebhook(input.gatewayType, 'payment', {
        paymentId: envelope.paymentId,
        providerStatus: envelope.eventStatus,
        providerEventId: envelope.providerEventId,
      });
      await this.paymentWebhookInboxService.markEnqueued(receivedEvent.event.id);
      try {
        await runPaymentReconciliationEnqueueWithTimeout(() =>
          this.paymentReconciliationQueue.add(
            PAYMENT_RECONCILIATION_JOB,
            {
              eventId: receivedEvent.event.id,
              paymentId: receivedEvent.event.paymentId,
              gatewayType: receivedEvent.event.gatewayType,
            },
            {
              removeOnComplete: 100,
              removeOnFail: 100,
            },
          ),
        );
      } catch (error: unknown) {
        await this.paymentWebhookInboxService.markFailed(
          receivedEvent.event.id,
          PAYMENT_RECONCILIATION_ENQUEUE_FAILED,
        );
        throw error;
      }
    }

    if (recurrentFollowUp !== null) {
      // After the payment's own work is queued, and never at its cost: a look
      // that could not be queued is found by the sweep (a sign-up not yet
      // linked is looked at every ten minutes), and the callback must answer 200.
      try {
        await this.providerSubscriptionService.enqueueRecurrentSync(
          input.gatewayType,
          recurrentFollowUp.recurrentId,
          recurrentFollowUp.orderId,
          { paymentId: recurrentFollowUp.paymentId, status: recurrentFollowUp.status },
        );
      } catch (error: unknown) {
        this.logger.warn(
          `Could not queue the look at Antilopay recurrent ${recurrentFollowUp.recurrentId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      accepted: true,
      duplicate: receivedEvent.duplicate,
      lifecycleStatus: receivedEvent.duplicate
        ? (receivedEvent.event.status ?? PAYMENT_WEBHOOK_STATUS_ENQUEUED)
        : PAYMENT_WEBHOOK_STATUS_ENQUEUED,
    };
  }

  /**
   * Queues the look a refund's callback asks for. The callback names Antilopay's
   * payment id: our transaction holds it as `gatewayId` for a first payment,
   * and a scheduled charge's renewal carries it in its marker
   * (`providerChargeId`), whose autopay is then read again, because Antilopay's
   * check is by OUR order id and a scheduled charge has none of ours. A payment
   * we do not know is another integration's on the same project.
   */
  private async lookAtAntilopayRefund(providerPaymentId: string): Promise<void> {
    const gatewayType = PaymentGatewayType.ANTILOPAY;
    const payment = await this.prismaService.transaction.findFirst({
      where: { gatewayType, gatewayId: providerPaymentId },
      select: { paymentId: true },
    });
    if (payment !== null) {
      await runPaymentReconciliationEnqueueWithTimeout(() =>
        this.paymentReconciliationQueue.add(
          ANTILOPAY_PAYMENT_CHECK_JOB,
          { orderId: payment.paymentId },
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        ),
      );
      return;
    }
    const charge = await this.prismaService.transaction.findFirst({
      where: { gatewayType, gatewayData: { path: ['providerChargeId'], equals: providerPaymentId } },
      select: { gatewayData: true },
    });
    const data = charge?.gatewayData;
    const subscriptionKey =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)['providerSubscriptionId']
        : undefined;
    if (typeof subscriptionKey === 'string' && subscriptionKey.length > 0) {
      await this.providerSubscriptionService.enqueueSync(gatewayType, subscriptionKey);
      return;
    }
    this.logger.warn(`Refund callback for Antilopay payment ${providerPaymentId}, which is none of ours; ignored`);
  }

  /**
   * The RollyPay payment to look up when a callback's `order_id` is none of
   * our payments. Every checkout's transaction exists, under its `paymentId`,
   * before RollyPay is asked for a link, so an unknown order is not a race.
   */
  private async findRollypayForeignPaymentId(
    gatewayType: PaymentGatewayType,
    rawBody: Buffer,
  ): Promise<string | null> {
    const references = readRollypayCallbackReferences(gatewayType, rawBody);
    if (references === null) {
      return null;
    }
    const ours = await this.prismaService.transaction.findUnique({
      where: { paymentId: references.orderId },
      select: { id: true },
    });
    return ours === null ? references.paymentId : null;
  }
}

/**
 * A RollyPay callback's `order_id` and `payment_id`, or null when this is not
 * a RollyPay callback that carries both.
 */
export function readRollypayCallbackReferences(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): { readonly orderId: string; readonly paymentId: string } | null {
  if (gatewayType !== PaymentGatewayType.ROLLYPAY) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const orderId = root['order_id'];
  const paymentId = root['payment_id'];
  if (typeof orderId !== 'string' || orderId.trim().length === 0) return null;
  if (typeof paymentId !== 'string' || paymentId.trim().length === 0) return null;
  return { orderId: orderId.trim(), paymentId: paymentId.trim() };
}

/** An Antilopay refund's callback: the refund, the payment it belongs to, and how it ended. */
export interface AntilopayRefundCallback {
  readonly refundId: string | null;
  /** Antilopay's own payment id, not our order. */
  readonly providerPaymentId: string;
  /** COMPLETE or FAIL, upper-cased. */
  readonly status: string | null;
}

/** The refund a callback of `type: refund` names, or null for anything else. */
export function readAntilopayRefundCallback(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): AntilopayRefundCallback | null {
  if (gatewayType !== PaymentGatewayType.ANTILOPAY) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  if (root['type'] !== 'refund') return null;
  const read = (key: string): string | null => {
    const value = root[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  };
  const providerPaymentId = read('payment_id');
  if (providerPaymentId === null) return null;
  return { refundId: read('refund_id'), providerPaymentId, status: read('status')?.toUpperCase() ?? null };
}

/** What an Antilopay callback of a repeat-charge subscription's payment names. */
export interface AntilopayCallbackReferences {
  readonly orderId: string | null;
  /** `recurrent_id`: the subscription the payment belongs to. */
  readonly recurrentId: string;
  readonly paymentId: string | null;
  /** The callback's own `status` (SUCCESS, FAIL), upper-cased. */
  readonly status: string | null;
}

/**
 * An Antilopay payment callback's references, or null when it is not a payment
 * of a repeat-charge subscription (no `recurrent_id`), is not a payment
 * callback at all (a refund's or a payout's names a different `type`), or is
 * another gateway's.
 */
export function readAntilopayCallbackReferences(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): AntilopayCallbackReferences | null {
  if (gatewayType !== PaymentGatewayType.ANTILOPAY) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const type = root['type'];
  if (type !== undefined && type !== 'payment') return null;
  const read = (key: string): string | null => {
    const value = root[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  };
  const recurrentId = read('recurrent_id');
  if (recurrentId === null) return null;
  return {
    orderId: read('order_id'),
    recurrentId,
    paymentId: read('payment_id'),
    status: read('status')?.toUpperCase() ?? null,
  };
}

/**
 * The Platega subscription a callback is about, or null for a payment's own
 * callback. Keys are matched without regard to case: the documentation writes
 * them `SubscriptionId` and `Id`, the payment callbacks this route already
 * takes write theirs in camelCase.
 */
export function extractPlategaSubscriptionId(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): string | null {
  if (gatewayType !== PaymentGatewayType.PLATEGA) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const read = (name: string): unknown => {
    const key = Object.keys(root).find((candidate) => candidate.toLowerCase() === name);
    return key === undefined ? undefined : root[key];
  };
  const subscriptionId = read('subscriptionid');
  if (typeof subscriptionId === 'string' && subscriptionId.trim().length > 0) {
    return subscriptionId.trim();
  }
  const status = read('status');
  const id = read('id');
  if (
    typeof status === 'string' &&
    status.toUpperCase().startsWith('SUBSCRIPTION_') &&
    typeof id === 'string' &&
    id.trim().length > 0
  ) {
    return id.trim();
  }
  return null;
}

/**
 * A Platega subscription callback that disputes a charge: a charge callback
 * (`Id`, `SubscriptionId`) whose status is a refund or chargeback
 * (`isRefundProviderStatus`, which knows Platega's `CHARGEBACKED`). Null for a
 * charge, a status callback, and every other gateway.
 */
export function extractPlategaSubscriptionDispute(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): ProviderSubscriptionChargeback | null {
  if (gatewayType !== PaymentGatewayType.PLATEGA) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const read = (name: string): unknown => {
    const key = Object.keys(root).find((candidate) => candidate.toLowerCase() === name);
    return key === undefined ? undefined : root[key];
  };
  const status = read('status');
  if (typeof status !== 'string' || !isRefundProviderStatus(status)) {
    return null;
  }
  const id = read('id');
  return {
    providerPaymentId: typeof id === 'string' && id.trim().length > 0 ? id.trim() : null,
    providerStatus: status,
  };
}

/**
 * Detects a YooKassa `payment_method.*` notification (e.g. `payment_method.active`
 * for a zero-amount binding) and returns its `object`. Returns null for every
 * other gateway/event so the standard payment pipeline handles them unchanged.
 */
function extractYookassaPaymentMethodEvent(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): { readonly event: string; readonly object: Record<string, unknown> } | null {
  if (gatewayType !== PaymentGatewayType.YOOKASSA) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const event = typeof root.event === 'string' ? root.event : '';
  if (!event.startsWith('payment_method.')) {
    return null;
  }
  const object =
    typeof root.object === 'object' && root.object !== null && !Array.isArray(root.object)
      ? (root.object as Record<string, unknown>)
      : {};
  return { event, object };
}
