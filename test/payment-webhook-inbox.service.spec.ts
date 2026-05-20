import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType } from '@prisma/client';

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

  it('treats repeated providerEventId as duplicate and increments attempts without recreating the event', async () => {
    const { service, state } = createService([
      createStoredEvent({ providerEventId: 'event-1', attempts: 1, status: PAYMENT_WEBHOOK_STATUS_ENQUEUED }),
    ]);

    const result = await service.recordReceived({
      envelope: createEnvelope({ providerEventId: 'event-1' }),
    });

    assert.equal(result.duplicate, true);
    assert.equal(result.event.attempts, 2);
    assert.equal(state.events.length, 1);
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

function createService(initialEvents: readonly StoredEvent[] = []): {
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
