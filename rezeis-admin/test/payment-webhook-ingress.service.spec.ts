import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { PaymentGatewayType } from '@prisma/client';

import {
  PaymentReconciliationEnqueueError,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../src/modules/payments/constants/payment-reconciliation.constant';
import type { SystemEventsService } from '../src/common/services/system-events.service';
import { PaymentWebhookIngressService } from '../src/modules/payments/services/payment-webhook-ingress.service';

/**
 * The ingress now raises «Вебхук платёжки». Every test here asserts on a
 * `calls` array it owns, so the card must not land in that — each gets its
 * own sink, and the two tests at the end pass one they read.
 */
/** Cards raised by whichever service a test built; cleared before each one. */
const CARDS: unknown[] = [];

function cardSink(cards: unknown[] = CARDS): SystemEventsService {
  return {
    info: (type: string, _category: string, _message: string, metadata: unknown) => {
      cards.push([type, metadata]);
    },
  } as unknown as SystemEventsService;
}

describe('PaymentWebhookIngressService', () => {
  beforeEach(() => {
    CARDS.length = 0;
  });

  it('marks new webhook deliveries as enqueued', async () => {
    const calls: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
      } as never,
      {
        normalizeWebhook: () => ({
          gatewayType: PaymentGatewayType.YOOKASSA,
          paymentId: 'payment-1',
          providerEventId: 'event-1',
          eventStatus: 'succeeded',
          receivedAt: '2026-04-19T12:00:00.000Z',
          payloadHash: 'hash-1',
          rawPayload: { object: { id: 'payment-1' } },
        }),
      } as never,
      {
        recordReceived: async () => ({
          duplicate: false,
          event: { id: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA },
        }),
        markEnqueued: async (eventId: string) => {
          calls.push(['markEnqueued', eventId]);
          return { id: eventId, status: 'ENQUEUED' };
        },
      } as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      {
        add: async (...args: readonly unknown[]) => {
          calls.push(['queue.add', ...args]);
          return { id: 'job-1' };
        },
      } as never, { enqueueSync: async () => undefined } as never,
      cardSink(),
    );

    const result = await service.ingestWebhook({
      gatewayType: PaymentGatewayType.YOOKASSA,
      rawBody: Buffer.from('{}', 'utf8'),
      headers: {},
      clientIp: '185.71.76.1',
      verifySignature: true,
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.lifecycleStatus, 'ENQUEUED');
    assert.deepStrictEqual(calls, [
      ['markEnqueued', 'event-row-1'],
      [
        'queue.add',
        'reconcile-payment',
        { eventId: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA },
        { removeOnComplete: 100, removeOnFail: 100 },
      ],
    ]);
    // ── ONE CARD, AND IT SAYS WHAT ARRIVED ────────────────────────────
    //
    // `payment.webhook_received` was registered with a title, an emoji, a
    // webhook line and a tick-box, and nothing raised it: an operator could
    // tick «Вебхук платёжки» and never hear from it.
    assert.equal(CARDS.length, 1, `expected one card, got ${JSON.stringify(CARDS)}`);
    const [type, metadata] = CARDS[0] as [string, Record<string, unknown>];
    assert.equal(type, 'payment.webhook_received');
    assert.equal(metadata['webhookKind'], 'payment');
    assert.equal(metadata['paymentId'], 'payment-1');
    assert.equal(metadata['providerStatus'], 'succeeded');
  });

  it('does not re-enqueue duplicate deliveries', async () => {
    const calls: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
      } as never,
      {
        normalizeWebhook: () => ({
          gatewayType: PaymentGatewayType.YOOKASSA,
          paymentId: 'payment-1',
          providerEventId: 'event-1',
          eventStatus: 'succeeded',
          receivedAt: '2026-04-19T12:00:00.000Z',
          payloadHash: 'hash-1',
          rawPayload: { object: { id: 'payment-1' } },
        }),
      } as never,
      {
        recordReceived: async () => ({
          duplicate: true,
          event: { id: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA, status: 'ENQUEUED' },
        }),
        markEnqueued: async (eventId: string) => {
          calls.push(['markEnqueued', eventId]);
          return { id: eventId, status: 'ENQUEUED' };
        },
      } as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      {
        add: async (...args: readonly unknown[]) => {
          calls.push(['queue.add', ...args]);
          return { id: 'job-1' };
        },
      } as never, { enqueueSync: async () => undefined } as never,
      cardSink(),
    );

    const result = await service.ingestWebhook({
      gatewayType: PaymentGatewayType.YOOKASSA,
      rawBody: Buffer.from('{}', 'utf8'),
      headers: {},
      clientIp: '185.71.76.1',
      verifySignature: true,
    });

    assert.equal(result.duplicate, true);
    assert.equal(result.lifecycleStatus, 'ENQUEUED');
    assert.deepStrictEqual(calls, []);
    // ── A RE-DELIVERY IS NOT A NEW FACT ───────────────────────────────
    //
    // This is the whole reason the type stayed unbuilt for so long: a
    // provider retries the notifications it is unsure about, and a card per
    // ping would bury every other card the operator ticked. The inbox
    // already recognises the repeat — the card simply rides that answer.
    assert.deepStrictEqual(CARDS, []);
  });

  it('does not echo normalized raw webhook payload in the ingress response', async () => {
    const rawPayload = {
      apiKey: 'provider-secret-key',
      customerEmail: 'payer@example.com',
      object: { id: 'payment-1' },
    };
    const persistedPayloads: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
      } as never,
      {
        normalizeWebhook: () => ({
          gatewayType: PaymentGatewayType.YOOKASSA,
          paymentId: 'payment-1',
          providerEventId: 'event-1',
          eventStatus: 'succeeded',
          receivedAt: '2026-04-19T12:00:00.000Z',
          payloadHash: 'hash-1',
          rawPayload,
        }),
      } as never,
      {
        recordReceived: async (input: { readonly envelope: { readonly rawPayload: unknown } }) => {
          persistedPayloads.push(input.envelope.rawPayload);
          return {
            duplicate: false,
            event: { id: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA },
          };
        },
        markEnqueued: async (eventId: string) => ({ id: eventId, status: 'ENQUEUED' }),
      } as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      {
        add: async () => ({ id: 'job-1' }),
      } as never, { enqueueSync: async () => undefined } as never,
      cardSink(),
    );

    const result = await service.ingestWebhook({
      gatewayType: PaymentGatewayType.YOOKASSA,
      rawBody: Buffer.from('{}', 'utf8'),
      headers: {},
      clientIp: '185.71.76.1',
      verifySignature: true,
    });
    const serializedResult = JSON.stringify(result);

    assert.deepStrictEqual(result, {
      accepted: true,
      duplicate: false,
      lifecycleStatus: 'ENQUEUED',
    });
    assert.deepStrictEqual(persistedPayloads, [rawPayload]);
    assert.equal(serializedResult.includes('provider-secret-key'), false);
    assert.equal(serializedResult.includes('payer@example.com'), false);
    assert.equal(serializedResult.includes('rawPayload'), false);
  });

  it('bounds stalled reconciliation enqueue waits without surfacing raw queue details', async () => {
    let enqueueStarted = false;

    await assert.rejects(
      runPaymentReconciliationEnqueueWithTimeout(() => {
        enqueueStarted = true;
        return new Promise(() => undefined);
      }, 5),
      PaymentReconciliationEnqueueError,
    );

    assert.equal(enqueueStarted, true);
  });

  it('sanitizes rejected reconciliation enqueue failures', async () => {
    const rawError =
      'Redis failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';

    await assert.rejects(
      runPaymentReconciliationEnqueueWithTimeout(() => Promise.reject(new Error(rawError)), 5),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof PaymentReconciliationEnqueueError, true);
        assert.equal(serialized.includes(rawError), false);
        assert.equal(serialized.includes('secret'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('payment_pi_SECRET'), false);
        assert.equal(serialized.includes('subscription_sub_SECRET'), false);
        return true;
      },
    );
  });

  it('sanitizes synchronous reconciliation enqueue failures', async () => {
    const rawError =
      'Redis sync failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';

    await assert.rejects(
      runPaymentReconciliationEnqueueWithTimeout(() => { throw new Error(rawError); }, 5),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof PaymentReconciliationEnqueueError, true);
        assert.equal(serialized.includes(rawError), false);
        assert.equal(serialized.includes('secret'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('payment_pi_SECRET'), false);
        assert.equal(serialized.includes('subscription_sub_SECRET'), false);
        return true;
      },
    );
  });

  it('marks webhook events failed when reconciliation enqueue fails', async () => {
    const rawError =
      'Redis enqueue failure redis://admin:secret@redis.internal/0 payment_pi_SECRET token raw-provider-token';
    const calls: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
      } as never,
      {
        normalizeWebhook: () => ({
          gatewayType: PaymentGatewayType.YOOKASSA,
          paymentId: 'payment-1',
          providerEventId: 'event-1',
          eventStatus: 'succeeded',
          receivedAt: '2026-04-19T12:00:00.000Z',
          payloadHash: 'hash-1',
          rawPayload: { object: { id: 'payment-1' } },
        }),
      } as never,
      {
        recordReceived: async () => ({
          duplicate: false,
          event: { id: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA },
        }),
        markEnqueued: async (eventId: string) => {
          calls.push(['markEnqueued', eventId]);
          return { id: eventId, status: 'ENQUEUED' };
        },
        markFailed: async (eventId: string, lastError: string) => {
          calls.push(['markFailed', eventId, lastError]);
          return { id: eventId, status: 'FAILED', lastError };
        },
      } as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      {
        add: async () => {
          throw new Error(rawError);
        },
      } as never, { enqueueSync: async () => undefined } as never,
      cardSink(),
    );

    await assert.rejects(
      service.ingestWebhook({
        gatewayType: PaymentGatewayType.YOOKASSA,
        rawBody: Buffer.from('{}', 'utf8'),
        headers: {},
        clientIp: '185.71.76.1',
        verifySignature: true,
      }),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(serialized.includes(rawError), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('secret'), false);
        assert.equal(serialized.includes('payment_pi_SECRET'), false);
        assert.equal(serialized.includes('raw-provider-token'), false);
        return true;
      },
    );

    assert.deepStrictEqual(calls, [
      ['markEnqueued', 'event-row-1'],
      ['markFailed', 'event-row-1', 'FAILED'],
    ]);
  });

  it('keeps webhook ingress enqueue payload and options unchanged', async () => {
    const calls: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
      } as never,
      {
        normalizeWebhook: () => ({
          gatewayType: PaymentGatewayType.YOOKASSA,
          paymentId: 'payment-1',
          providerEventId: 'event-1',
          eventStatus: 'succeeded',
          receivedAt: '2026-04-19T12:00:00.000Z',
          payloadHash: 'hash-1',
          rawPayload: { object: { id: 'payment-1' } },
        }),
      } as never,
      {
        recordReceived: async () => ({
          duplicate: false,
          event: { id: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA },
        }),
        markEnqueued: async (eventId: string) => {
          calls.push(['markEnqueued', eventId]);
          return { id: eventId, status: 'ENQUEUED' };
        },
      } as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      {
        add: async (...args: readonly unknown[]) => {
          calls.push(['queue.add', ...args]);
          return { id: 'job-1' };
        },
      } as never, { enqueueSync: async () => undefined } as never,
      cardSink(),
    );

    const result = await service.ingestWebhook({
      gatewayType: PaymentGatewayType.YOOKASSA,
      rawBody: Buffer.from('{}', 'utf8'),
      headers: {},
      clientIp: '185.71.76.1',
      verifySignature: true,
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.lifecycleStatus, 'ENQUEUED');
    assert.deepStrictEqual(calls, [
      ['markEnqueued', 'event-row-1'],
      [
        'queue.add',
        'reconcile-payment',
        { eventId: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.YOOKASSA },
        { removeOnComplete: 100, removeOnFail: 100 },
      ],
    ]);
  });

  it('routes a YooKassa payment_method.active event to the setup service, not payment reconciliation', async () => {
    const handled: unknown[] = [];
    let verified = false;
    let normalizeCalled = false;
    let enqueued = false;
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
      } as never,
      {
        verifyWebhookSignature: () => {
          verified = true;
        },
        normalizeWebhook: () => {
          normalizeCalled = true;
          throw new Error('payment_method events must skip payment normalization');
        },
      } as never,
      {
        recordReceived: async () => {
          throw new Error('payment_method events must not enter the payment inbox');
        },
      } as never,
      {
        handleYookassaPaymentMethodEvent: async (object: unknown) => {
          handled.push(object);
        },
      } as never,
      {
        add: async () => {
          enqueued = true;
          return { id: 'job' };
        },
      } as never, { enqueueSync: async () => undefined } as never,
      cardSink(),
    );

    const body = Buffer.from(
      JSON.stringify({
        event: 'payment_method.active',
        object: { id: 'pm-1', status: 'active', saved: true, metadata: { paymentMethodSetupId: 's-1' } },
      }),
      'utf8',
    );
    const result = await service.ingestWebhook({
      gatewayType: PaymentGatewayType.YOOKASSA,
      rawBody: body,
      headers: {},
      clientIp: '185.71.76.1',
      verifySignature: true,
    });

    assert.equal(verified, true, 'source must still be verified');
    assert.equal(normalizeCalled, false);
    assert.equal(enqueued, false);
    assert.equal(handled.length, 1);
    assert.equal((handled[0] as { id: string }).id, 'pm-1');
    assert.equal(result.accepted, true);
  });
});

describe('PaymentWebhookIngressService on RollyPay subscription charges', () => {
  function service(knownPaymentIds: readonly string[]) {
    const calls: unknown[] = [];
    const ingress = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.ROLLYPAY, settings: { signingSecret: 'sig-1' } }),
        },
        transaction: {
          findUnique: async ({ where }: { where: { paymentId: string } }) =>
            knownPaymentIds.includes(where.paymentId) ? { id: `tx-${where.paymentId}` } : null,
        },
      } as never,
      {
        verifyWebhookSignature: () => {
          calls.push(['verified']);
        },
        normalizeWebhook: () => {
          calls.push(['normalized']);
          return {
            gatewayType: PaymentGatewayType.ROLLYPAY,
            paymentId: 'order-ours',
            providerEventId: 'pay_1',
            eventStatus: 'paid',
            receivedAt: '2026-09-20T12:00:00.000Z',
            payloadHash: 'hash-1',
            rawPayload: {},
          };
        },
      } as never,
      {
        recordReceived: async () => ({
          duplicate: false,
          event: { id: 'event-row-1', paymentId: 'order-ours', gatewayType: PaymentGatewayType.ROLLYPAY },
        }),
        markEnqueued: async () => ({ id: 'event-row-1', status: 'ENQUEUED' }),
      } as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      { add: async () => ({ id: 'job-1' }) } as never,
      {
        enqueueSync: async () => undefined,
        enqueuePaymentLookup: async (gatewayType: PaymentGatewayType, paymentId: string) => {
          calls.push(['lookup', gatewayType, paymentId]);
        },
      } as never,
      cardSink(),
    );
    const ingest = (body: Record<string, unknown>) =>
      ingress.ingestWebhook({
        gatewayType: PaymentGatewayType.ROLLYPAY,
        rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
        headers: {},
        clientIp: '203.0.113.1',
        verifySignature: true,
      });
    return { calls, ingest };
  }

  it('looks a charge up by its payment when RollyPay made the order id up itself', async () => {
    const { calls, ingest } = service(['order-ours']);
    const result = await ingest({ event_type: 'payment.paid', status: 'paid', order_id: 'rp-auto-17', payment_id: 'pay_9' });
    assert.equal(result.accepted, true);
    assert.deepStrictEqual(calls, [['verified'], ['lookup', PaymentGatewayType.ROLLYPAY, 'pay_9']]);
  });

  it('leaves a payment of ours to the payment pipeline', async () => {
    const { calls, ingest } = service(['order-ours']);
    await ingest({ event_type: 'payment.paid', status: 'paid', order_id: 'order-ours', payment_id: 'pay_1' });
    assert.deepStrictEqual(calls, [['normalized']]);
  });
});

describe('PaymentWebhookIngressService on Platega subscription callbacks', () => {
  // Wave 6: a chargeback on a subscription charge is the refund of one of its
  // payments. It used to reach `sync` alone, which counts charges and never
  // reverses one; it now goes to the chargeback handling, which runs the
  // refund reversal and ends the autopay.
  function service() {
    const calls: unknown[] = [];
    // What the inbox holds already: a callback Platega repeats is a duplicate.
    const repeated = new Set<string>();
    const ingress = new PaymentWebhookIngressService(
      {
        paymentGateway: {
          findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }),
        },
      } as never,
      {
        verifyWebhookSignature: () => {
          calls.push(['verified']);
        },
        normalizeWebhook: () => {
          throw new Error('a subscription callback never reaches the payment pipeline');
        },
      } as never,
      {} as never,
      { handleYookassaPaymentMethodEvent: async () => undefined } as never,
      { add: async () => ({ id: 'job-1' }) } as never,
      {
        enqueueSync: async (gatewayType: PaymentGatewayType, id: string) => {
          calls.push(['sync', gatewayType, id]);
        },
        recordDispute: async (gatewayType: PaymentGatewayType, id: string, dispute: unknown, body: unknown) => {
          calls.push(['dispute', gatewayType, id, dispute, body]);
          const key = JSON.stringify(body);
          const duplicate = repeated.has(key);
          repeated.add(key);
          return { duplicate };
        },
      } as never,
      cardSink(),
    );
    const ingest = (body: Record<string, unknown>) =>
      ingress.ingestWebhook({
        gatewayType: PaymentGatewayType.PLATEGA,
        rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
        headers: {},
        clientIp: '203.0.113.1',
        verifySignature: true,
      });
    return { calls, ingest };
  }

  it('records a chargeback on a subscription charge in the inbox for the chargeback handling, not a sync', async () => {
    const { calls, ingest } = service();
    const body = { Id: 'pl-tx-9', SubscriptionId: 'sub-1', Amount: 299, Status: 'CHARGEBACKED' };
    const result = await ingest(body);
    assert.equal(result.accepted, true);
    assert.equal(result.duplicate, false);
    assert.deepStrictEqual(calls, [
      ['verified'],
      ['dispute', PaymentGatewayType.PLATEGA, 'sub-1', { providerPaymentId: 'pl-tx-9', providerStatus: 'CHARGEBACKED' }, body],
    ]);
    // Platega repeating it is answered as the duplicate the inbox found.
    const again = await ingest(body);
    assert.equal(again.duplicate, true);
  });

  it('still sends a charge and a status callback to a sync', async () => {
    const { calls, ingest } = service();
    await ingest({ Id: 'pl-tx-10', SubscriptionId: 'sub-1', Amount: 299, Status: 'CONFIRMED' });
    await ingest({ Id: 'sub-2', Status: 'SUBSCRIPTION_CANCELLED' });
    assert.deepStrictEqual(calls, [
      ['verified'],
      ['sync', PaymentGatewayType.PLATEGA, 'sub-1'],
      ['verified'],
      ['sync', PaymentGatewayType.PLATEGA, 'sub-2'],
    ]);
  });
});
