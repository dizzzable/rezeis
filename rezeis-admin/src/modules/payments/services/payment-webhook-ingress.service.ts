import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { PaymentGatewayType } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import {
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
import { ProviderSubscriptionService } from './provider-subscription.service';

interface IngestWebhookInput {
  readonly gatewayType: PaymentGatewayType;
  readonly rawBody: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly clientIp: string | null;
  readonly verifySignature: boolean;
}

@Injectable()
export class PaymentWebhookIngressService {
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
   *   * a RE-DELIVERY raises nothing. The inbox recognises a duplicate by the
   *     provider's own event id, and a repeat of a notification is not a new
   *     event — that is the retry storm, and it is where the volume lives;
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
    kind: 'payment' | 'subscription-status' | 'subscription-charge' | 'card-binding',
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

    return {
      accepted: true,
      duplicate: receivedEvent.duplicate,
      lifecycleStatus: receivedEvent.duplicate
        ? (receivedEvent.event.status ?? PAYMENT_WEBHOOK_STATUS_ENQUEUED)
        : PAYMENT_WEBHOOK_STATUS_ENQUEUED,
    };
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
