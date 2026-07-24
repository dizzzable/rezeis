import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentWebhookLifecycleStatus } from '@prisma/client';

import { PaymentReconciliationEnqueueError } from '../src/modules/payments/constants/payment-reconciliation.constant';
import {
  PaymentWebhookOpsService,
  runPaymentWebhookReplayJobStateInspectionWithTimeout,
  runPaymentReconciliationQueueCountsWithTimeout,
  runPaymentWebhookReplayQueueInspectionWithTimeout,
} from '../src/modules/payments/services/payment-webhook-ops.service';

function createService(input?: {
  readonly getJobCounts?: () => Promise<Record<string, number>>;
  readonly getJob?: () => Promise<unknown>;
  readonly add?: (...args: readonly unknown[]) => Promise<unknown>;
  readonly groupBy?: () => Promise<readonly unknown[]>;
  readonly count?: () => Promise<number>;
  readonly findMany?: () => Promise<readonly unknown[]>;
  readonly findUnique?: () => Promise<unknown>;
  readonly markReplayRequested?: () => Promise<unknown>;
  readonly markFailed?: (eventId: string, lastError: string) => Promise<unknown>;
  readonly auditCreate?: () => Promise<unknown>;
  readonly notifyWebhookReplay?: () => Promise<unknown>;
  readonly redact?: (payload: unknown) => unknown;
}): PaymentWebhookOpsService {
  const prisma = {
    paymentWebhookEvent: {
      findMany: input?.findMany ?? (async () => []),
      findUnique: input?.findUnique ?? (async () => null),
      groupBy: input?.groupBy ?? (async () => []),
      count: input?.count ?? (async () => 0),
    },
    adminAuditLog: {
      create: input?.auditCreate ?? (async () => ({})),
    },
  };
  const inbox = {
    markReplayRequested: input?.markReplayRequested ?? (async () => createWebhookEventFixture()),
    markFailed: input?.markFailed ?? (async () => createWebhookEventFixture({ status: PaymentWebhookLifecycleStatus.FAILED })),
  };
  const alertService = {
    notifyWebhookReplay: input?.notifyWebhookReplay ?? (async () => undefined),
  };
  const queue = {
    getJobCounts:
      input?.getJobCounts ??
      (async () => ({ waiting: 1, active: 2, delayed: 3, completed: 4, failed: 5 })),
    getJob: input?.getJob ?? (async () => null),
    add: input?.add ?? (async () => ({})),
  };

  return new PaymentWebhookOpsService(
    prisma as never,
    inbox as never,
    { redact: input?.redact ?? ((payload: unknown) => payload) } as never,
    alertService as never,
    queue as never,
  );
}

function createWebhookEventFixture(input?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'webhook-event-1',
    gatewayType: 'YOOKASSA',
    paymentId: 'payment-1',
    providerEventId: 'provider-event-1',
    eventStatus: 'payment.succeeded',
    status: PaymentWebhookLifecycleStatus.FAILED,
    attempts: 1,
    rawPayload: { object: { id: 'payment-1' } },
    payloadHash: 'payload-hash',
    processedAt: null,
    receivedAt: new Date('2025-01-01T00:00:00.000Z'),
    lastTransitionAt: new Date('2025-01-01T00:00:00.000Z'),
    lastReplayedAt: null,
    reconciliationAttempts: 1,
    replayCount: 0,
    lastError: null,
    ...input,
  };
}

describe('PaymentWebhookOpsService reconciliation health queue counts', () => {
  it('normalizes healthy queue counts without changing event health data', async () => {
    const service = createService({
      getJobCounts: async () => ({
        waiting: 1.9,
        active: -10,
        delayed: Number.NaN,
        completed: 4,
        failed: 5,
      }),
      groupBy: async () => [
        {
          status: PaymentWebhookLifecycleStatus.PROCESSED,
          _count: { _all: 7 },
        },
      ],
      count: async () => 3,
    });

    const result = await service.getReconciliationHealth();

    assert.deepEqual(result.queue, {
      waiting: 1,
      active: 0,
      delayed: 0,
      completed: 4,
      failed: 5,
    });
    assert.equal(result.eventsByStatus.PROCESSED, 7);
    assert.equal(result.staleEnqueuedCount, 3);
    assert.equal(result.staleProcessingCount, 3);
  });

  it('falls back to zeroed queue counts when BullMQ counts reject without surfacing raw details', async () => {
    const rawError =
      'Redis failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';
    const service = createService({
      getJobCounts: async () => {
        throw new Error(rawError);
      },
    });

    const result = await service.getReconciliationHealth();
    const serialized = JSON.stringify(result);

    assert.deepEqual(result.queue, {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
    assert.equal(serialized.includes('subscription_sub_SECRET'), false);
  });

  it('returns before a stalled BullMQ counts probe finishes', async () => {
    const slowCounts = new Promise<Record<string, number>>(() => undefined);

    const result = await runPaymentReconciliationQueueCountsWithTimeout(() => slowCounts, 5);

    assert.deepEqual(result, {});
  });

  it('falls back to zeroed counts for synchronous BullMQ count failures without surfacing raw details', async () => {
    const rawError =
      'Redis sync failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';
    const result = await runPaymentReconciliationQueueCountsWithTimeout(
      () => { throw new Error(rawError); },
      5,
    );
    const serialized = JSON.stringify(result);

    assert.deepEqual(result, {});
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
    assert.equal(serialized.includes('subscription_sub_SECRET'), false);
  });

  it('runs independent queue and database health probes concurrently', async () => {
    let started = 0;
    let releaseAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      releaseAllStarted = resolve;
    });
    const startProbe = async <T>(value: T): Promise<T> => {
      started += 1;
      if (started === 4) {
        releaseAllStarted();
      }
      await allStarted;
      return value;
    };
    const countStatuses: PaymentWebhookLifecycleStatus[] = [];
    const service = createService({
      getJobCounts: async () => startProbe({ waiting: 9, active: 8, delayed: 7, completed: 6, failed: 5 }),
      groupBy: async () => startProbe([
        {
          status: PaymentWebhookLifecycleStatus.FAILED,
          _count: { _all: 11 },
        },
      ]),
      count: async () => {
        const status = countStatuses.length === 0
          ? PaymentWebhookLifecycleStatus.ENQUEUED
          : PaymentWebhookLifecycleStatus.PROCESSING;
        countStatuses.push(status);
        return startProbe(status === PaymentWebhookLifecycleStatus.ENQUEUED ? 3 : 4);
      },
    });

    const result = await service.getReconciliationHealth();

    assert.equal(started, 4);
    assert.deepEqual(result.queue, {
      waiting: 9,
      active: 8,
      delayed: 7,
      completed: 6,
      failed: 5,
    });
    assert.equal(result.eventsByStatus.FAILED, 11);
    assert.equal(result.staleEnqueuedCount, 3);
    assert.equal(result.staleProcessingCount, 4);
  });
});

describe('PaymentWebhookOpsService webhook diagnostic responses', () => {
  it('normalizes raw stored webhook errors in list and detail responses', async () => {
    const rawError =
      'Provider failed https://provider.example/webhooks token=fixture provider_id=fixture payment_pi_fixture';
    const event = createWebhookEventFixture({ lastError: rawError });
    const service = createService({
      findMany: async () => [event],
      findUnique: async () => event,
    });

    const [listItem] = await service.listEvents({ limit: 10, offset: 0 } as never);
    const detail = await service.getEventDetail({ eventId: 'webhook-event-1', includeRaw: false });
    const serialized = JSON.stringify({ listItem, detail });

    assert.equal(listItem?.lastError, 'PAYMENT_PROVIDER_ERROR');
    assert.equal(detail.lastError, 'PAYMENT_PROVIDER_ERROR');
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('provider.example'), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
  });

  it('preserves bounded stored webhook error codes in API responses', async () => {
    const event = createWebhookEventFixture({ lastError: 'PAYMENT_PROVIDER_TIMEOUT' });
    const service = createService({
      findMany: async () => [event],
      findUnique: async () => event,
    });

    const [listItem] = await service.listEvents({ limit: 10, offset: 0 } as never);
    const detail = await service.getEventDetail({ eventId: 'webhook-event-1', includeRaw: false });

    assert.equal(listItem?.lastError, 'PAYMENT_PROVIDER_TIMEOUT');
    assert.equal(detail.lastError, 'PAYMENT_PROVIDER_TIMEOUT');
  });

  it('does not return unredacted webhook payload when raw reveal is requested', async () => {
    const rawPayload = {
      apiKey: 'secret-key',
      customerEmail: 'payer@example.com',
      status: 'paid',
    };
    const redactedPayload = {
      apiKey: '***redacted***',
      customerEmail: '[email hidden]',
      status: 'paid',
    };
    const event = createWebhookEventFixture({ rawPayload });
    const service = createService({
      findUnique: async () => event,
      redact: (payload: unknown) => {
        assert.deepEqual(payload, rawPayload);
        return redactedPayload;
      },
    });

    const detail = await service.getEventDetail({ eventId: 'webhook-event-1', includeRaw: true });
    const serialized = JSON.stringify(detail);

    assert.deepEqual(detail.redactedPayload, redactedPayload);
    assert.deepEqual(detail.rawPayload, redactedPayload);
    assert.equal(serialized.includes('secret-key'), false);
    assert.equal(serialized.includes('payer@example.com'), false);
  });
});

describe('PaymentWebhookOpsService replay queue inspection bounds', () => {
  it('returns null before a stalled replay job-state inspection finishes', async () => {
    const slowState = new Promise<string>(() => undefined);

    const result = await runPaymentWebhookReplayJobStateInspectionWithTimeout(() => slowState, 5);

    assert.equal(result, null);
  });

  it('degrades replay job-state inspection failures without surfacing raw details', async () => {
    const rawError =
      'Redis state failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';
    const rejected = await runPaymentWebhookReplayJobStateInspectionWithTimeout(
      () => Promise.reject(new Error(rawError)),
      5,
    );
    const synchronous = await runPaymentWebhookReplayJobStateInspectionWithTimeout(
      () => { throw new Error(rawError); },
      5,
    );

    const serialized = JSON.stringify({ rejected, synchronous });

    assert.equal(rejected, null);
    assert.equal(synchronous, null);
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
    assert.equal(serialized.includes('subscription_sub_SECRET'), false);
  });

  it('replay continues when an existing job state inspection fails', async () => {
    const event = createWebhookEventFixture();
    const addCalls: unknown[][] = [];
    const rawError =
      'Redis state failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';
    const service = createService({
      findUnique: async () => event,
      markReplayRequested: async () => ({ ...event, status: PaymentWebhookLifecycleStatus.ENQUEUED }),
      getJob: async () => ({
        getState: async () => {
          throw new Error(rawError);
        },
      }),
      add: async (...args: readonly unknown[]) => {
        addCalls.push([...args]);
        return {};
      },
    });

    const result = await service.replayEvent({
      eventId: 'webhook-event-1',
      reason: 'operator retry',
      force: false,
      currentAdmin: { id: 'admin-1', role: 'ADMIN', username: 'admin' } as never,
      requestMetadata: { requestId: 'request-1', remoteAddress: null, userAgent: null },
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.alreadyQueued, false);
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
    assert.equal(serialized.includes('subscription_sub_SECRET'), false);
    assert.equal(addCalls.length, 1);
    assert.deepEqual(addCalls[0]?.[2], {
      jobId: 'reconcile:webhook:webhook-event-1',
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  });

  it('returns false before a stalled replay queue inspection finishes', async () => {
    const slowInspection = new Promise<boolean>(() => undefined);

    const result = await runPaymentWebhookReplayQueueInspectionWithTimeout(() => slowInspection, 5);

    assert.equal(result, false);
  });

  it('degrades replay duplicate queue inspection failures to not queued without surfacing raw details', async () => {
    const rawError =
      'Redis failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';
    const result = await runPaymentWebhookReplayQueueInspectionWithTimeout(
      () => Promise.reject(new Error(rawError)),
      5,
    );

    const serialized = JSON.stringify({ result });

    assert.equal(result, false);
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
    assert.equal(serialized.includes('subscription_sub_SECRET'), false);
  });

  it('degrades synchronous replay duplicate queue inspection failures to not queued without surfacing raw details', async () => {
    const rawError =
      'Redis failure redis://admin:secret@redis.internal/0 payload payment_pi_SECRET subscription_sub_SECRET';
    const result = await runPaymentWebhookReplayQueueInspectionWithTimeout(
      () => { throw new Error(rawError); },
      5,
    );

    const serialized = JSON.stringify({ result });

    assert.equal(result, false);
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payment_pi_SECRET'), false);
    assert.equal(serialized.includes('subscription_sub_SECRET'), false);
  });

  it('replay continues through bounded duplicate-inspection failure and keeps enqueue policy unchanged', async () => {
    const event = createWebhookEventFixture();
    const addCalls: unknown[][] = [];
    const service = createService({
      findUnique: async () => event,
      markReplayRequested: async () => ({ ...event, status: PaymentWebhookLifecycleStatus.ENQUEUED }),
      getJob: async () => {
        throw new Error('redis://admin:secret@redis.internal queued job payload payment_pi_SECRET');
      },
      add: async (...args: readonly unknown[]) => {
        addCalls.push([...args]);
        return {};
      },
    });

    const result = await service.replayEvent({
      eventId: 'webhook-event-1',
      reason: 'operator retry',
      force: false,
      currentAdmin: { id: 'admin-1', role: 'ADMIN', username: 'admin' } as never,
      requestMetadata: { requestId: 'request-1', remoteAddress: null, userAgent: null },
    });

    assert.equal(result.alreadyQueued, false);
    assert.equal(addCalls.length, 1);
    assert.equal(addCalls[0]?.[0], 'reconcile-payment');
    assert.deepEqual(addCalls[0]?.[1], {
      eventId: 'webhook-event-1',
      paymentId: 'payment-1',
      gatewayType: 'YOOKASSA',
    });
    assert.deepEqual(addCalls[0]?.[2], {
      jobId: 'reconcile:webhook:webhook-event-1',
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  });

  it('keeps already-queued replay path unchanged without lifecycle writes or enqueue', async () => {
    const event = createWebhookEventFixture();
    let markReplayRequestedCalled = false;
    let addCalled = false;
    let markFailedCalled = false;
    const service = createService({
      findUnique: async () => event,
      markReplayRequested: async () => {
        markReplayRequestedCalled = true;
        return { ...event, status: PaymentWebhookLifecycleStatus.ENQUEUED };
      },
      markFailed: async () => {
        markFailedCalled = true;
        return { ...event, status: PaymentWebhookLifecycleStatus.FAILED };
      },
      getJob: async () => ({
        getState: async () => 'waiting',
      }),
      add: async () => {
        addCalled = true;
        return {};
      },
    });

    const result = await service.replayEvent({
      eventId: 'webhook-event-1',
      reason: 'operator retry',
      force: false,
      currentAdmin: { id: 'admin-1', role: 'ADMIN', username: 'admin' } as never,
      requestMetadata: { requestId: 'request-1', remoteAddress: null, userAgent: null },
    });

    assert.equal(result.alreadyQueued, true);
    assert.equal(markReplayRequestedCalled, false);
    assert.equal(addCalled, false);
    assert.equal(markFailedCalled, false);
  });

  it('sanitizes replay enqueue failures without changing duplicate-inspection behavior', async () => {
    const event = createWebhookEventFixture();
    const markFailedCalls: unknown[][] = [];
    const rawError =
      'Redis failure redis://admin:secret@redis.internal replay enqueue payload payment_pi_SECRET subscription_sub_SECRET';
    const service = createService({
      findUnique: async () => event,
      markReplayRequested: async () => ({ ...event, status: PaymentWebhookLifecycleStatus.ENQUEUED }),
      markFailed: async (...args: readonly unknown[]) => {
        markFailedCalls.push([...args]);
        return { ...event, status: PaymentWebhookLifecycleStatus.FAILED, lastError: 'FAILED' };
      },
      getJob: async () => null,
      add: async () => {
        throw new Error(rawError);
      },
    });

    await assert.rejects(
      service.replayEvent({
        eventId: 'webhook-event-1',
        reason: 'operator retry',
        force: false,
        currentAdmin: { id: 'admin-1', role: 'ADMIN', username: 'admin' } as never,
        requestMetadata: { requestId: 'request-1', remoteAddress: null, userAgent: null },
      }),
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

    assert.deepEqual(markFailedCalls, [['webhook-event-1', PaymentWebhookLifecycleStatus.FAILED]]);
  });

  it('preserves sanitized replay enqueue failure when failed-state marking fails', async () => {
    const event = createWebhookEventFixture();
    const markFailedCalls: unknown[][] = [];
    const rawEnqueueError =
      'Redis enqueue failure redis://admin:secret@redis.internal replay payload payment_pi_SECRET subscription_sub_SECRET';
    const rawMarkFailedError =
      'Database failed marker postgres://admin:secret@db.internal payment_pi_MARK subscription_sub_MARK';
    const service = createService({
      findUnique: async () => event,
      markReplayRequested: async () => ({ ...event, status: PaymentWebhookLifecycleStatus.ENQUEUED }),
      markFailed: async (...args: readonly unknown[]) => {
        markFailedCalls.push([...args]);
        throw new Error(rawMarkFailedError);
      },
      getJob: async () => null,
      add: async () => {
        throw new Error(rawEnqueueError);
      },
    });

    await assert.rejects(
      service.replayEvent({
        eventId: 'webhook-event-1',
        reason: 'operator retry',
        force: false,
        currentAdmin: { id: 'admin-1', role: 'ADMIN', username: 'admin' } as never,
        requestMetadata: { requestId: 'request-1', remoteAddress: null, userAgent: null },
      }),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof PaymentReconciliationEnqueueError, true);
        assert.equal(serialized.includes(rawEnqueueError), false);
        assert.equal(serialized.includes(rawMarkFailedError), false);
        assert.equal(serialized.includes('secret'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('postgres://'), false);
        assert.equal(serialized.includes('payment_pi_SECRET'), false);
        assert.equal(serialized.includes('subscription_sub_SECRET'), false);
        assert.equal(serialized.includes('payment_pi_MARK'), false);
        assert.equal(serialized.includes('subscription_sub_MARK'), false);
        return true;
      },
    );

    assert.deepEqual(markFailedCalls, [['webhook-event-1', PaymentWebhookLifecycleStatus.FAILED]]);
  });
});
