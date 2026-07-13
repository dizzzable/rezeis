import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';

import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';

type State = 'PENDING_ACTIVATION' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'REVERSED' | 'REMEDIATION_REQUIRED';
type Row = { id: string; state: State; version: number };
type EventRow = { id: string; toState: State; metadata?: unknown };

function build(options: {
  row: Row | null;
  updateCount?: number;
  existingEvent?: EventRow | null;
  replayEventAfterClaimLoss?: EventRow | null;
}) {
  const updates: unknown[] = [];
  const events: unknown[] = [];
  let eventReads = 0;
  const withDefaultFingerprint = (event: EventRow | null): EventRow | null =>
    event === null || event.metadata !== undefined
      ? event
      : {
          ...event,
          metadata: {
            commandFingerprint: {
              command: 'ACTIVATE',
              reason: 'TERM_STARTED',
              actorType: 'SYSTEM',
              actorId: null,
              metadata: {},
            },
          },
        };
  const tx = {
    $queryRaw: async () => [{ id: 'locked' }],
    addOnEntitlement: {
      findUnique: async () => options.row,
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: options.updateCount ?? 1 };
      },
    },
    addOnEntitlementEvent: {
      findUnique: async () => {
        eventReads += 1;
        return withDefaultFingerprint(eventReads === 1
          ? (options.existingEvent ?? null)
          : (options.replayEventAfterClaimLoss ?? null));
      },
      create: async (args: unknown) => {
        events.push(args);
        return { id: 'event-1' };
      },
    },
  };

  return {
    service: new AddOnEntitlementService(),
    tx,
    updates,
    events,
  };
}

const command = {
  entitlementId: 'ent-1',
  command: 'ACTIVATE' as const,
  commandKey: 'activate:term-1',
  correlationId: 'corr-1',
  actorType: 'SYSTEM' as const,
  reason: 'TERM_STARTED',
};

describe('AddOnEntitlementService.transitionInTransaction', () => {
  it('conditionally updates and appends one command-keyed immutable event on the provided transaction', async () => {
    const { service, tx, updates, events } = build({
      row: { id: 'ent-1', state: 'PENDING_ACTIVATION', version: 4 },
    });

    const result = await service.transitionInTransaction(tx as never, command);

    assert.deepEqual(result, {
      entitlementId: 'ent-1',
      state: 'ACTIVE',
      changed: true,
      eventId: 'event-1',
    });
    assert.deepEqual(updates, [
      {
        where: { id: 'ent-1', state: 'PENDING_ACTIVATION', version: 4 },
        data: {
          state: 'ACTIVE',
          version: { increment: 1 },
          activatedAt: updates.length > 0
            ? (updates[0] as { data: { activatedAt: Date } }).data.activatedAt
            : undefined,
        },
      },
    ]);
    assert.equal((updates[0] as { data: { activatedAt: unknown } }).data.activatedAt instanceof Date, true);
    assert.deepEqual(events, [
      {
        data: {
          entitlementId: 'ent-1',
          fromState: 'PENDING_ACTIVATION',
          toState: 'ACTIVE',
          reason: 'TERM_STARTED',
          actorType: 'SYSTEM',
          actorId: undefined,
          correlationId: 'corr-1',
          commandKey: 'activate:term-1',
          metadata: {
            commandFingerprint: {
              command: 'ACTIVATE',
              reason: 'TERM_STARTED',
              actorType: 'SYSTEM',
              actorId: null,
              metadata: {},
            },
          },
        },
        select: { id: true },
      },
    ]);
  });

  it('returns the recorded outcome when the same command is replayed after later lifecycle progress', async () => {
    const { service, tx, updates, events } = build({
      row: { id: 'ent-1', state: 'EXPIRED', version: 9 },
      existingEvent: { id: 'event-old', toState: 'ACTIVE' },
    });

    assert.deepEqual(await service.transitionInTransaction(tx as never, command), {
      entitlementId: 'ent-1',
      state: 'ACTIVE',
      changed: false,
      eventId: 'event-old',
    });
    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
  });

  it('rejects reuse of a lifecycle command key with a different command payload', async () => {
    const { service, tx, updates, events } = build({
      row: { id: 'ent-1', state: 'ACTIVE', version: 9 },
      existingEvent: {
        id: 'event-old',
        toState: 'ACTIVE',
        metadata: {
          commandFingerprint: {
            command: 'ACTIVATE',
            reason: 'TERM_STARTED',
            actorType: 'SYSTEM',
            actorId: null,
            metadata: {},
          },
        },
      },
    });

    await assert.rejects(
      () => service.transitionInTransaction(tx as never, {
        ...command,
        command: 'REVERSE',
        reason: 'CHARGEBACK',
      }),
      ConflictException,
    );
    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
  });

  it('turns an optimistic claim loser into harmless replay when the command event now exists', async () => {
    const { service, tx, updates, events } = build({
      row: { id: 'ent-1', state: 'PENDING_ACTIVATION', version: 4 },
      updateCount: 0,
      replayEventAfterClaimLoss: { id: 'event-winner', toState: 'ACTIVE' },
    });

    assert.deepEqual(await service.transitionInTransaction(tx as never, command), {
      entitlementId: 'ent-1',
      state: 'ACTIVE',
      changed: false,
      eventId: 'event-winner',
    });
    assert.equal(updates.length, 1);
    assert.equal(events.length, 0);
  });

  it('fails closed when an incompatible optimistic race has no matching command event', async () => {
    const { service, tx } = build({
      row: { id: 'ent-1', state: 'PENDING_ACTIVATION', version: 4 },
      updateCount: 0,
    });

    await assert.rejects(
      () => service.transitionInTransaction(tx as never, command),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('rejects fulfillment when the subscription is deleted at lock time', async () => {
    let lockReads = 0;
    let upserts = 0;
    const tx = {
      $queryRaw: async () => {
        lockReads += 1;
        return lockReads === 1
          ? [{ id: 'tx-1', subscriptionId: 'sub-1' }]
          : [{ id: 'sub-1', status: 'DELETED' }];
      },
      addOnEntitlement: {
        upsert: async () => {
          upserts += 1;
          return {};
        },
      },
    };
    const service = new AddOnEntitlementService();

    await assert.rejects(
      () => service.createPendingInTransaction(tx as never, {
        subscriptionId: 'sub-1', termId: 'term-1', sourceTransactionId: 'tx-1', sourceLineKey: 'line-deleted',
        addOnId: null, catalogRevision: 1, receiptName: 'Device', type: 'EXTRA_DEVICES',
        valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END', applicabilitySnapshot: {},
        unitAmount: '1', totalAmount: '1', currency: 'USD', purchasedAt: new Date(),
        scheduledActivationAt: new Date(), expiresAt: null, expiryEpochId: null, correlationId: 'corr-deleted',
      }),
      ConflictException,
    );
    assert.equal(lockReads, 2);
    assert.equal(upserts, 0);
  });

  it('rejects an entitlement term belonging to another subscription before upsert', async () => {
    let queryReads = 0;
    let upserts = 0;
    const tx = {
      $queryRaw: async () => {
        queryReads += 1;
        if (queryReads === 1) return [{ id: 'tx-1', subscriptionId: 'sub-a' }];
        if (queryReads === 2) return [{ id: 'sub-a', status: 'ACTIVE' }];
        return [{ id: 'term-b', subscriptionId: 'sub-b' }];
      },
      addOnEntitlement: { upsert: async () => { upserts += 1; return {}; } },
    };
    const service = new AddOnEntitlementService();

    await assert.rejects(
      () => service.createPendingInTransaction(tx as never, {
        subscriptionId: 'sub-a', termId: 'term-b', sourceTransactionId: 'tx-1', sourceLineKey: 'line-cross-sub',
        addOnId: null, catalogRevision: 1, receiptName: 'Cross-subscription', type: 'EXTRA_DEVICES',
        valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END', applicabilitySnapshot: {},
        unitAmount: '1', totalAmount: '1', currency: 'USD', purchasedAt: new Date(),
        scheduledActivationAt: new Date(), expiresAt: null, expiryEpochId: null, correlationId: 'corr-cross-sub',
      }),
      ConflictException,
    );
    assert.equal(queryReads, 3);
    assert.equal(upserts, 0);
  });

  it('creates one immutable pending aggregate and initial event for a source line', async () => {
    const createdRows: unknown[] = [];
    const createdEvents: unknown[] = [];
    const row = {
      id: 'ent-new',
      state: 'PENDING_ACTIVATION' as const,
      version: 1,
    };
    const tx = {
      $queryRaw: (() => {
        let reads = 0;
        return async () => {
          reads += 1;
          if (reads === 1) return [{ id: 'tx-1', subscriptionId: 'sub-1', status: 'ACTIVE' }];
          if (reads === 2) return [{ id: 'sub-1', status: 'ACTIVE' }];
          if (reads === 3) return [{ id: 'term-1', subscriptionId: 'sub-1' }];
          return [{ id: 'epoch-1', termId: 'term-1' }];
        };
      })(),
      addOnEntitlement: {
        upsert: async (args: unknown) => {
          createdRows.push(args);
          const create = (args as { create: Record<string, unknown> }).create;
          return { ...create, id: 'ent-new', state: 'PENDING_ACTIVATION', version: 1 };
        },
      },
      addOnEntitlementEvent: {
        findUnique: async () => null,
        create: async (args: unknown) => {
          createdEvents.push(args);
          return { id: 'event-created' };
        },
      },
    };
    const service = new AddOnEntitlementService();
    const input = {
      subscriptionId: 'sub-1',
      termId: 'term-1',
      sourceTransactionId: 'tx-1',
      sourceLineKey: 'line-1',
      addOnId: 'addon-1',
      catalogRevision: 3,
      receiptName: '50 GB',
      type: 'EXTRA_TRAFFIC' as const,
      valuePerUnit: 50,
      totalValue: 53_687_091_200n,
      lifetime: 'UNTIL_NEXT_RESET' as const,
      applicabilitySnapshot: { rule: 'finite-traffic' },
      unitAmount: '2.50',
      totalAmount: '2.50',
      currency: 'USD' as const,
      purchasedAt: new Date('2026-01-01T00:00:00.000Z'),
      scheduledActivationAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      expiryEpochId: 'epoch-1',
      correlationId: 'payment:tx-1',
    };

    assert.deepEqual(await service.createPendingInTransaction(tx as never, input), {
      entitlementId: 'ent-new',
      state: 'PENDING_ACTIVATION',
      created: true,
      eventId: 'event-created',
    });
    const createData = (createdRows[0] as { create: Record<string, unknown> }).create;
    assert.equal(createData.quantity, 1);
    assert.equal(createData.sourceTransactionId, 'tx-1');
    assert.deepEqual((createdRows[0] as { update: unknown }).update, {});
    assert.equal(createdEvents.length, 1);
  });

  it('replays the same source line without mutating its immutable snapshot or duplicating its event', async () => {
    const purchasedAt = new Date('2026-01-01T00:00:00.000Z');
    const scheduledActivationAt = new Date('2026-01-01T00:00:00.000Z');
    const tx = {
      $queryRaw: (() => {
        let reads = 0;
        return async () => {
          reads += 1;
          if (reads === 1) return [{ id: 'tx-1', subscriptionId: 'sub-1', status: 'ACTIVE' }];
          if (reads === 2) return [{ id: 'sub-1', status: 'ACTIVE' }];
          if (reads === 3) return [{ id: 'term-1', subscriptionId: 'sub-1' }];
          return [{ id: 'epoch-1', termId: 'term-1' }];
        };
      })(),
      addOnEntitlement: {
        upsert: async (args: unknown) => ({
          ...(args as { create: Record<string, unknown> }).create,
          id: 'ent-existing',
          state: 'ACTIVE',
          version: 4,
        }),
      },
      addOnEntitlementEvent: {
        findUnique: async () => ({ id: 'event-created', toState: 'PENDING_ACTIVATION' }),
        create: async () => {
          throw new Error('replay must not create another event');
        },
      },
    };
    const service = new AddOnEntitlementService();

    const result = await service.createPendingInTransaction(tx as never, {
      subscriptionId: 'sub-1', termId: 'term-1', sourceTransactionId: 'tx-1', sourceLineKey: 'line-1',
      addOnId: null, catalogRevision: 1, receiptName: 'Archived add-on', type: 'EXTRA_DEVICES',
      valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END', applicabilitySnapshot: {},
      unitAmount: '1', totalAmount: '1', currency: 'USD', purchasedAt: new Date(),
      scheduledActivationAt: new Date(), expiresAt: null, expiryEpochId: null, correlationId: 'payment:tx-1',
    });

    assert.deepEqual(result, {
      entitlementId: 'ent-existing',
      state: 'ACTIVE',
      created: false,
      eventId: 'event-created',
    });
  });

  it('rejects reuse of a source line with a different immutable snapshot', async () => {
    const tx = {
      $queryRaw: (() => {
        let reads = 0;
        return async () => {
          reads += 1;
          if (reads === 1) return [{ id: 'tx-1', subscriptionId: 'sub-1', status: 'ACTIVE' }];
          if (reads === 2) return [{ id: 'sub-1', status: 'ACTIVE' }];
          if (reads === 3) return [{ id: 'term-1', subscriptionId: 'sub-1' }];
          return [{ id: 'epoch-1', termId: 'term-1' }];
        };
      })(),
      addOnEntitlement: {
        upsert: async () => ({
          id: 'ent-existing', state: 'ACTIVE', version: 4,
          subscriptionId: 'sub-1', termId: 'term-1', sourceTransactionId: 'tx-1', sourceLineKey: 'line-1',
          addOnId: null, catalogRevision: 1, receiptName: 'Original', type: 'EXTRA_DEVICES',
          valuePerUnit: 1, quantity: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END',
          applicabilitySnapshot: {}, unitAmount: { toString: () => '1' }, totalAmount: { toString: () => '1' },
          currency: 'USD', purchasedAt: new Date('2026-01-01T00:00:00.000Z'),
          scheduledActivationAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: null, expiryEpochId: null,
        }),
      },
      addOnEntitlementEvent: { findUnique: async () => ({ id: 'event-created', toState: 'PENDING_ACTIVATION' }) },
    };
    const service = new AddOnEntitlementService();

    await assert.rejects(
      () => service.createPendingInTransaction(tx as never, {
        subscriptionId: 'sub-1', termId: 'term-1', sourceTransactionId: 'tx-1', sourceLineKey: 'line-1',
        addOnId: null, catalogRevision: 1, receiptName: 'Changed', type: 'EXTRA_DEVICES',
        valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END', applicabilitySnapshot: {},
        unitAmount: '1', totalAmount: '1', currency: 'USD',
        purchasedAt: new Date('2026-01-01T00:00:00.000Z'),
        scheduledActivationAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: null, expiryEpochId: null,
        correlationId: 'payment:tx-1',
      }),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('rejects refund command-key reuse before creating another incident', async () => {
    let incidentUpserts = 0;
    const tx = {
      $queryRaw: async () => [{ id: 'ent-1' }],
      addOnEntitlement: {
        findUnique: async () => ({ id: 'ent-1', subscriptionId: 'sub-1', state: 'ACTIVE' }),
      },
      entitlementIncident: {
        upsert: async () => {
          incidentUpserts += 1;
          return {};
        },
      },
      addOnEntitlementEvent: {
        findUnique: async () => ({
          id: 'event-refund-old',
          toState: 'ACTIVE',
          metadata: {
            refundFingerprint: {
              supportRef: 'refund:original',
              summaryCode: 'PAYMENT_REFUNDED',
              metadata: { providerEventId: 'original' },
            },
            incidentId: 'incident-original',
          },
        }),
      },
    };
    const service = new AddOnEntitlementService();

    await assert.rejects(
      () => service.recordRefundOrChargebackInTransaction(tx as never, {
        entitlementId: 'ent-1',
        commandKey: 'refund:provider-event-1',
        supportRef: 'refund:different',
        summaryCode: 'PAYMENT_REFUNDED',
        correlationId: 'corr-retry',
        metadata: { providerEventId: 'different' },
      }),
      ConflictException,
    );
    assert.equal(incidentUpserts, 0);
  });

  it('returns the original refund incident on identical command replay without writes', async () => {
    let incidentUpserts = 0;
    let eventCreates = 0;
    const tx = {
      $queryRaw: async () => [{ id: 'ent-1' }],
      addOnEntitlement: {
        findUnique: async () => ({ id: 'ent-1', subscriptionId: 'sub-1', state: 'ACTIVE' }),
      },
      entitlementIncident: {
        upsert: async () => {
          incidentUpserts += 1;
          return {};
        },
      },
      addOnEntitlementEvent: {
        findUnique: async () => ({
          id: 'event-refund-old',
          toState: 'ACTIVE',
          metadata: {
            refundFingerprint: {
              supportRef: 'refund:original',
              summaryCode: 'PAYMENT_REFUNDED',
              metadata: { providerEventId: 'original' },
            },
            incidentId: 'incident-original',
          },
        }),
        create: async () => {
          eventCreates += 1;
          return {};
        },
      },
    };
    const service = new AddOnEntitlementService();

    assert.deepEqual(
      await service.recordRefundOrChargebackInTransaction(tx as never, {
        entitlementId: 'ent-1',
        commandKey: 'refund:provider-event-1',
        supportRef: 'refund:original',
        summaryCode: 'PAYMENT_REFUNDED',
        correlationId: 'corr-retry',
        metadata: { providerEventId: 'original' },
      }),
      {
        entitlementId: 'ent-1',
        state: 'ACTIVE',
        incidentId: 'incident-original',
        eventId: 'event-refund-old',
        created: false,
      },
    );
    assert.equal(incidentUpserts, 0);
    assert.equal(eventCreates, 0);
  });

  it('replays the original refund incident after later lifecycle progress without writes', async () => {
    let incidentUpserts = 0;
    let eventCreates = 0;
    const tx = {
      $queryRaw: async () => [{ id: 'ent-1' }],
      addOnEntitlement: {
        findUnique: async () => ({ id: 'ent-1', subscriptionId: 'sub-1', state: 'EXPIRED' }),
      },
      entitlementIncident: {
        upsert: async () => {
          incidentUpserts += 1;
          return {};
        },
      },
      addOnEntitlementEvent: {
        findUnique: async () => ({
          id: 'event-refund-old',
          toState: 'ACTIVE',
          metadata: {
            refundFingerprint: {
              supportRef: 'refund:original',
              summaryCode: 'PAYMENT_REFUNDED',
              metadata: { providerEventId: 'original' },
            },
            incidentId: 'incident-original',
          },
        }),
        create: async () => {
          eventCreates += 1;
          return {};
        },
      },
    };
    const service = new AddOnEntitlementService();

    assert.deepEqual(
      await service.recordRefundOrChargebackInTransaction(tx as never, {
        entitlementId: 'ent-1',
        commandKey: 'refund:provider-event-1',
        supportRef: 'refund:original',
        summaryCode: 'PAYMENT_REFUNDED',
        correlationId: 'corr-retry',
        metadata: { providerEventId: 'original' },
      }),
      {
        entitlementId: 'ent-1',
        state: 'EXPIRED',
        incidentId: 'incident-original',
        eventId: 'event-refund-old',
        created: false,
      },
    );
    assert.equal(incidentUpserts, 0);
    assert.equal(eventCreates, 0);
  });

  it('records refund/chargeback as an idempotent incident and same-state audit without clawback', async () => {
    const updates: unknown[] = [];
    const incidentCreates: unknown[] = [];
    const eventCreates: unknown[] = [];
    const tx = {
      $queryRaw: async () => [{ id: 'ent-1' }],
      addOnEntitlement: {
        findUnique: async () => ({ id: 'ent-1', subscriptionId: 'sub-1', state: 'ACTIVE' }),
        updateMany: async (args: unknown) => {
          updates.push(args);
          return { count: 1 };
        },
      },
      entitlementIncident: {
        upsert: async (args: unknown) => {
          incidentCreates.push(args);
          return {
            id: 'incident-1', subscriptionId: 'sub-1', entitlementId: 'ent-1',
            kind: 'REFUND_OR_CHARGEBACK', supportRef: 'refund:provider-event-1',
            summaryCode: 'PAYMENT_REFUNDED',
          };
        },
      },
      addOnEntitlementEvent: {
        findUnique: async () => null,
        create: async (args: unknown) => {
          eventCreates.push(args);
          return { id: 'event-refund' };
        },
      },
    };
    const service = new AddOnEntitlementService();

    assert.deepEqual(
      await service.recordRefundOrChargebackInTransaction(tx as never, {
        entitlementId: 'ent-1',
        commandKey: 'refund:provider-event-1',
        supportRef: 'refund:provider-event-1',
        summaryCode: 'PAYMENT_REFUNDED',
        correlationId: 'corr-refund',
        metadata: { providerEventId: 'provider-event-1' },
      }),
      { entitlementId: 'ent-1', state: 'ACTIVE', incidentId: 'incident-1', eventId: 'event-refund', created: true },
    );
    assert.equal(updates.length, 0);
    assert.deepEqual((incidentCreates[0] as { update: unknown }).update, {});
    assert.equal(eventCreates.length, 1);
  });

  it('maps missing entitlement to a non-leaking not-found error', async () => {
    const { service, tx } = build({ row: null });

    await assert.rejects(
      () => service.transitionInTransaction(tx as never, command),
      (error: unknown) => error instanceof NotFoundException,
    );
  });
});
