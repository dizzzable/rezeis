import { createHash } from 'node:crypto';

import { PaymentGatewayType } from '@prisma/client';

import type { PaymentWebhookEnvelopeInterface } from '../interfaces/payment-webhook-envelope.interface';

/**
 * A refund made at Antilopay after the day of the payment.
 *
 * Only the merchant's own cabinet (or Antilopay's refund API, which this panel
 * does not call) can make one, and the panel learns of it two ways: the
 * `refunds[]` of `payment/check` and of a recurrent's payments, and a callback
 * of `type: refund`, which names the refund and the payment but carries no
 * `order_id`. A payment REVERSED on its day and a CHARGEBACK come as a status
 * of the payment itself (`AntilopayStatusService`); a refund leaves the payment
 * SUCCESS and lists itself beside it, so nothing looked at it at all.
 */
export interface AntilopayRefund {
  /** Antilopay's `refund_id`: the key the refund is booked under, so it is booked once. */
  readonly id: string;
  /** The sum given back, as Antilopay wrote it; null when it wrote none. */
  readonly amount: string | null;
  /** COMPLETE is the only status that moved money back. */
  readonly status: string;
}

/** `refunds[]` of a payment as `payment/check` and a recurrent's `payments[]` give it. */
export function readAntilopayRefunds(value: unknown): readonly AntilopayRefund[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refunds: AntilopayRefund[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['refund_id'] === 'string' ? record['refund_id'].trim() : '';
    const status = typeof record['status'] === 'string' ? record['status'].trim().toUpperCase() : '';
    if (id.length === 0 || status.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const rawAmount = record['amount'];
    // A comma decimal («100,50») is the same sum. Left unread it would become
    // `null`, which the refund path takes for a FULL refund.
    const amount =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount)
        ? String(rawAmount)
        : typeof rawAmount === 'string' && /^\d+([.,]\d+)?$/.test(rawAmount.trim())
          ? rawAmount.trim().replace(',', '.')
          : null;
    refunds.push({ id, amount, status });
  }
  return refunds;
}

/** The refunds that moved money back. */
export function completedAntilopayRefunds(refunds: readonly AntilopayRefund[]): readonly AntilopayRefund[] {
  return refunds.filter((refund) => refund.status === 'COMPLETE');
}

/** `rawPayload.source` of a refund notice the panel made from what Antilopay lists. */
export const ANTILOPAY_REFUND_SOURCE = 'ANTILOPAY_REFUND';

/**
 * The provider's refund notice for one payment of ours, in the shape the
 * reconciliation already settles a refund from (`resolveRefundEvent`: the
 * refund's `object.id` and `object.amount.value`, as ЮKassa's carry them). So
 * the existing refund path does all of it: the refund is booked in the
 * payment's ledger under its id — the second look, and the callback that
 * follows, book nothing twice —, a partial one is added to what was given back
 * before, and the refund that reaches the paid sum reverses the payment. Every
 * refund ends the autopay (`refundEndsAutopay`), which is the owner's rule.
 *
 * The event key names the payment and the refund, and the payload holds nothing
 * that changes between looks, so asking again is one notice, not two.
 */
export function antilopayRefundEnvelope(input: {
  /** OUR payment id: the transaction the refund is against. */
  readonly paymentId: string;
  /** Antilopay's own payment id, for the operator's trail. */
  readonly providerPaymentId: string | null;
  readonly refund: AntilopayRefund;
  readonly currency: string | null;
}): PaymentWebhookEnvelopeInterface {
  const rawPayload: Record<string, unknown> = {
    source: ANTILOPAY_REFUND_SOURCE,
    status: 'REFUNDED',
    order_id: input.paymentId,
    ...(input.providerPaymentId === null ? {} : { payment_id: input.providerPaymentId }),
    object: {
      id: input.refund.id,
      ...(input.refund.amount === null
        ? {}
        : { amount: { value: input.refund.amount, ...(input.currency === null ? {} : { currency: input.currency }) } }),
    },
  };
  return {
    gatewayType: PaymentGatewayType.ANTILOPAY,
    paymentId: input.paymentId,
    providerEventId: `antilopay-refund:${input.paymentId}:${input.refund.id}`,
    eventStatus: 'REFUNDED',
    receivedAt: new Date().toISOString(),
    payloadHash: createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex'),
    rawPayload,
  };
}
