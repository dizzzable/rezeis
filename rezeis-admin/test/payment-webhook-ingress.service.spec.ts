import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType } from '@prisma/client';

import {
  PaymentReconciliationEnqueueError,
  runPaymentReconciliationEnqueueWithTimeout,
} from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentWebhookIngressService } from '../src/modules/payments/services/payment-webhook-ingress.service';

describe('PaymentWebhookIngressService', () => {
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
      {
        add: async (...args: readonly unknown[]) => {
          calls.push(['queue.add', ...args]);
          return { id: 'job-1' };
        },
      } as never,
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
      {
        add: async (...args: readonly unknown[]) => {
          calls.push(['queue.add', ...args]);
          return { id: 'job-1' };
        },
      } as never,
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
      {
        add: async () => {
          throw new Error(rawError);
        },
      } as never,
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
      {
        add: async (...args: readonly unknown[]) => {
          calls.push(['queue.add', ...args]);
          return { id: 'job-1' };
        },
      } as never,
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
});
