import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, Prisma } from '@prisma/client';

import {
  PAYMENT_WEBHOOK_STATUS_ENQUEUED,
  PAYMENT_WEBHOOK_STATUS_RECEIVED,
  PaymentWebhookInboxService,
} from '../src/modules/payments/services/payment-webhook-inbox.service';

describe('PaymentWebhookInboxService', () => {
  it('creates a received event for a new providerEventId', async () => {
    const { service, state } = createService();

    const result = await service.recordReceived({
      envelope: createEnvelope({ providerEventId: 'event-1' }),
    });

    assert.equal(result.duplicate, false);
    assert.equal(state.events[0]?.providerEventId, 'event-1');
    assert.equal(result.event.status, PAYMENT_WEBHOOK_STATUS_RECEIVED);
    assert.equal(state.events.length, 1);
  });

  it('treats repeated providerEventId with the SAME payload as duplicate and increments attempts without recreating the event', async () => {
    const { service, state } = createService([
      createStoredEvent({ providerEventId: 'event-1', attempts: 1, status: PAYMENT_WEBHOOK_STATUS_ENQUEUED }),
    ]);

    const result = await service.recordReceived({
      // Same providerEventId AND same payloadHash ('hash-1') → real duplicate.
      envelope: createEnvelope({ providerEventId: 'event-1' }),
    });

    assert.equal(result.duplicate, true);
    assert.equal(result.event.attempts, 2);
    assert.equal(state.events.length, 1);
  });

  it('treats a repeated providerEventId with a CHANGED payload (status progressed) as NOT a duplicate and refreshes the stored event', async () => {
    // Regression guard: gateways like HELEKET/CRYPTOMUS reuse one provider
    // id across pending → paid. The final `paid` notification must NOT be
    // swallowed as a duplicate, otherwise the payment hangs PENDING.
    const { service, state } = createService([
      createStoredEvent({ providerEventId: 'event-1', attempts: 1, status: PAYMENT_WEBHOOK_STATUS_ENQUEUED }),
    ]);

    const result = await service.recordReceived({
      envelope: {
        // Same gatewayType + providerEventId as the stored pending event,
        // but a different payload (status progressed to paid).
        gatewayType: PaymentGatewayType.YOOKASSA,
        paymentId: 'payment-1',
        providerEventId: 'event-1',
        eventStatus: 'paid',
        receivedAt: '2026-04-19T12:05:00.000Z',
        payloadHash: 'hash-2-paid',
        rawPayload: { object: { id: 'payment-1', status: 'paid' } },
      },
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.event.eventStatus, 'paid');
    assert.equal(result.event.payloadHash, 'hash-2-paid');
    assert.equal(result.event.status, PAYMENT_WEBHOOK_STATUS_RECEIVED);
    assert.equal(result.event.attempts, 2);
    // Refreshed in place — no second row created.
    assert.equal(state.events.length, 1);
  });

  it('treats a CHANGED payload that loses the P2002 create race as NOT a duplicate so reconciliation is still enqueued', async () => {
    // Race guard: two deliveries for one provider event id arrive together
    // and neither row exists yet, so both `findFirst` miss and both insert.
    // The `pending` one commits first; the `paid` one below loses on
    // @@unique([gatewayType, providerEventId]). The recovery path used to
    // assume any P2002 meant duplicate and discarded it without ever
    // comparing hashes — the payment then hung PENDING until the expiry
    // sweep cancelled it, after the user had already paid.
    const { service, state } = createService([], {
      failCreateWithP2002: true,
      raceWinner: createStoredEvent({
        providerEventId: 'event-1',
        attempts: 1,
        status: PAYMENT_WEBHOOK_STATUS_ENQUEUED,
      }),
    });

    const result = await service.recordReceived({
      envelope: {
        gatewayType: PaymentGatewayType.YOOKASSA,
        paymentId: 'payment-1',
        providerEventId: 'event-1',
        eventStatus: 'paid',
        receivedAt: '2026-04-19T12:05:00.000Z',
        // Differs from the winner's 'hash-1' — a genuinely new provider state.
        payloadHash: 'hash-2-paid',
        rawPayload: { object: { id: 'payment-1', status: 'paid' } },
      },
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.event.eventStatus, 'paid');
    assert.equal(result.event.payloadHash, 'hash-2-paid');
    assert.equal(result.event.status, PAYMENT_WEBHOOK_STATUS_RECEIVED);
    assert.equal(result.event.attempts, 2);
    // Refreshed the winner in place — no second row.
    assert.equal(state.events.length, 1);
  });

  it('still treats a byte-identical redelivery that loses the P2002 create race as a duplicate', async () => {
    const { service, state } = createService([], {
      failCreateWithP2002: true,
      raceWinner: createStoredEvent({
        providerEventId: 'event-1',
        attempts: 1,
        status: PAYMENT_WEBHOOK_STATUS_ENQUEUED,
      }),
    });

    const result = await service.recordReceived({
      // Same payloadHash ('hash-1') as the row that won the race.
      envelope: createEnvelope({ providerEventId: 'event-1' }),
    });

    assert.equal(result.duplicate, true);
    assert.equal(result.event.attempts, 2);
    assert.equal(state.events.length, 1);
  });

  it('rethrows the P2002 when the winning row has vanished instead of retrying the insert', async () => {
    // No race winner is left to read back. Re-entering recordReceived here is
    // what would let the racing path recurse without bound, so the service
    // surfaces the error and lets the gateway redeliver onto a clean insert.
    const { service, state } = createService([], { failCreateWithP2002: true });

    await assert.rejects(
      service.recordReceived({ envelope: createEnvelope({ providerEventId: 'event-1' }) }),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
    );
    assert.equal(state.events.length, 0);
  });

  it('marks a stored event as enqueued', async () => {
    const { service, state } = createService([
      createStoredEvent({ providerEventId: 'event-1', attempts: 1, status: PAYMENT_WEBHOOK_STATUS_RECEIVED }),
    ]);

    const result = await service.markEnqueued('event-row-1');

    assert.equal(result.status, PAYMENT_WEBHOOK_STATUS_ENQUEUED);
    assert.equal(state.events[0]?.status, PAYMENT_WEBHOOK_STATUS_ENQUEUED);
  });

  it('normalizes failed webhook diagnostics before storing lastError', async () => {
    const { service, state } = createService([
      createStoredEvent({ providerEventId: 'event-1', attempts: 1, status: PAYMENT_WEBHOOK_STATUS_RECEIVED }),
    ]);
    const rawDiagnostic = 'provider failed at https://gateway.example/payments/payment-provider-raw-id with token=provider-secret-fragment and profile uuid 0194f4b6-7cc7-7ecb-9f62-123456789abc';

    const result = await service.markFailed('event-row-1', rawDiagnostic);
    const serialized = JSON.stringify(result);

    assert.equal(result.lastError, 'FAILED');
    assert.equal(state.events[0]?.lastError, 'FAILED');
    assert.doesNotMatch(serialized, /gateway\.example/);
    assert.doesNotMatch(serialized, /provider-secret-fragment/);
    assert.doesNotMatch(serialized, /0194f4b6-7cc7-7ecb-9f62-123456789abc/);
    assert.doesNotMatch(serialized, /payment-provider-raw-id/);
  });
});

function createService(
  initialEvents: readonly StoredEvent[] = [],
  // `failCreateWithP2002` simulates losing the @@unique insert race; `raceWinner`
  // is the row the concurrent transaction committed just before ours was
  // rejected (omit it to simulate the row being gone by the time we re-read).
  raceOptions: {
    readonly failCreateWithP2002?: boolean;
    readonly raceWinner?: StoredEvent;
  } = {},
): {
  readonly service: PaymentWebhookInboxService;
  readonly state: { readonly events: StoredEvent[] };
} {
  const events = initialEvents.map((event) => ({ ...event }));
  const prismaService = {
    paymentWebhookEvent: {
      findFirst: async (args: { readonly where: { readonly gatewayType: PaymentGatewayType; readonly providerEventId: string } }) =>
        events.find(
          (event) =>
            event.gatewayType === args.where.gatewayType &&
            event.providerEventId === args.where.providerEventId,
        ) ?? null,
      create: async (args: { readonly data: Record<string, unknown> }) => {
        if (raceOptions.failCreateWithP2002 === true) {
          if (raceOptions.raceWinner !== undefined) {
            // The other delivery's transaction committed first, so its row is
            // already readable by the time our insert is rejected.
            events.push({ ...raceOptions.raceWinner });
          }
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`gateway_type`,`provider_event_id`)',
            { code: 'P2002', clientVersion: 'test' },
          );
        }
        const nextEvent: StoredEvent = {
          id: `event-row-${events.length + 1}`,
          gatewayType: args.data.gatewayType as PaymentGatewayType,
          paymentId: args.data.paymentId as string,
          providerEventId: args.data.providerEventId as string,
          eventStatus: (args.data.eventStatus as string | null) ?? null,
          status: args.data.status as string | null,
          payloadHash: (args.data.payloadHash as string | null) ?? null,
          rawPayload: (args.data.rawPayload as Record<string, unknown> | null) ?? null,
          attempts: args.data.attempts as number,
          lastError: (args.data.lastError as string | null) ?? null,
          receivedAt: args.data.receivedAt as Date,
          processedAt: (args.data.processedAt as Date | null) ?? null,
        };
        events.push(nextEvent);
        return nextEvent;
      },
      update: async (args: {
        readonly where: { readonly id: string };
        readonly data: Record<string, unknown>;
      }) => {
        const event = events.find((entry) => entry.id === args.where.id);
        if (!event) {
          throw new Error('missing event');
        }
        event.paymentId = (args.data.paymentId as string | undefined) ?? event.paymentId;
        event.eventStatus = (args.data.eventStatus as string | null | undefined) ?? event.eventStatus;
        event.payloadHash = (args.data.payloadHash as string | null | undefined) ?? event.payloadHash;
        event.rawPayload = (args.data.rawPayload as Record<string, unknown> | null | undefined) ?? event.rawPayload;
        event.lastError = (args.data.lastError as string | null | undefined) ?? event.lastError;
        event.receivedAt = (args.data.receivedAt as Date | undefined) ?? event.receivedAt;
        event.status = (args.data.status as string | null | undefined) ?? event.status;
        if (typeof args.data.attempts === 'object' && args.data.attempts !== null && 'increment' in (args.data.attempts as Record<string, unknown>)) {
          event.attempts += Number((args.data.attempts as { readonly increment: number }).increment);
        }
        return event;
      },
    },
  };

  return {
    service: new PaymentWebhookInboxService(prismaService as never),
    state: { events },
  };
}

function createEnvelope(input: { readonly providerEventId: string }) {
  return {
    gatewayType: PaymentGatewayType.YOOKASSA,
    paymentId: 'payment-1',
    providerEventId: input.providerEventId,
    eventStatus: 'succeeded',
    receivedAt: '2026-04-19T12:00:00.000Z',
    payloadHash: 'hash-1',
    rawPayload: { object: { id: 'payment-1', status: 'succeeded' } },
  };
}

function createStoredEvent(input: {
  readonly providerEventId: string;
  readonly attempts: number;
  readonly status: string;
}): StoredEvent {
  return {
    id: 'event-row-1',
    gatewayType: PaymentGatewayType.YOOKASSA,
    paymentId: 'payment-1',
    providerEventId: input.providerEventId,
    eventStatus: 'succeeded',
    status: input.status,
    payloadHash: 'hash-1',
    rawPayload: { object: { id: 'payment-1', status: 'succeeded' } },
    attempts: input.attempts,
    lastError: null,
    receivedAt: new Date('2026-04-19T12:00:00.000Z'),
    processedAt: null,
  };
}

interface StoredEvent {
  id: string;
  gatewayType: PaymentGatewayType;
  paymentId: string;
  providerEventId: string;
  eventStatus: string | null;
  status: string | null;
  payloadHash: string | null;
  rawPayload: Record<string, unknown> | null;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}
