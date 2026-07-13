import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';

function build(options: {
  due?: Array<{ id: string; type: string }>;
  activeTerm?: { id: string } | null;
} = {}) {
  const transitions: Array<{ command: string; commandKey: string; entitlementId: string }> = [];
  const recomputes: string[] = [];
  const tx = {
    addOnEntitlement: {
      findMany: async () => options.due ?? [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }],
    },
    subscriptionTerm: {
      findFirst: async () => (options.activeTerm === undefined ? { id: 'term-1' } : options.activeTerm),
    },
    subscription: {
      update: async () => ({ id: 'sub-1', remnawaveId: 'rem-1' }),
    },
    profileSyncJob: {
      create: async () => ({ id: 'job-1' }),
    },
  };
  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  const entitlements = {
    transitionInTransaction: async (_t: unknown, input: { command: string; commandKey: string; entitlementId: string }) => {
      transitions.push({ command: input.command, commandKey: input.commandKey, entitlementId: input.entitlementId });
      return { entitlementId: input.entitlementId, state: 'X', changed: true, eventId: 'e' };
    },
  };
  const projection = {
    recomputeInTransaction: async (_t: unknown, input: { subscriptionId: string }) => {
      recomputes.push(input.subscriptionId);
      return { desiredRevision: 7n, changed: true, desiredTrafficLimitBytes: null, desiredDeviceLimit: 0 };
    },
  };
  const terms = {
    activateInTransaction: async () => ({ id: 'term-1', status: 'ACTIVE', changed: true }),
  };
  const service = new EntitlementBoundaryService(prisma as never, entitlements as never, terms as never, projection as never);
  return { service, transitions, recomputes };
}

describe('EntitlementBoundaryService (T-008)', () => {
  it('BEGIN_EXPIRY + COMPLETE_EXPIRY a due traffic entitlement, then recomputes once', async () => {
    const { service, transitions, recomputes } = build({ due: [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }] });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.began, 1);
    assert.equal(result.expired, 1);
    assert.deepEqual(transitions.map((t) => t.command), ['BEGIN_EXPIRY', 'COMPLETE_EXPIRY']);
    assert.deepEqual(recomputes, ['sub-1']);
    assert.equal(result.desiredRevision, 7n);
    assert.deepEqual(result.syncJobIds, ['job-1']);
  });

  it('leaves a due device entitlement in EXPIRING (device saga completes it later)', async () => {
    const { service, transitions } = build({ due: [{ id: 'ent-d', type: 'EXTRA_DEVICES' }] });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.began, 1);
    assert.equal(result.expired, 0);
    assert.equal(result.deviceExpiryTriggered, true);
    assert.deepEqual(transitions.map((t) => t.command), ['BEGIN_EXPIRY']);
  });

  it('uses stable idempotent command keys per entitlement', async () => {
    const { service, transitions } = build({ due: [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }] });
    await service.expireDueForSubscription('sub-1');
    assert.equal(transitions[0]!.commandKey, 'boundary-begin:ent-1');
    assert.equal(transitions[1]!.commandKey, 'boundary-complete:ent-1');
  });

  it('is a no-op with no recompute when nothing is due', async () => {
    const { service, transitions, recomputes } = build({ due: [] });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.changed, false);
    assert.deepEqual(transitions, []);
    assert.deepEqual(recomputes, []);
  });

  it('expires entitlements but skips recompute when there is no active term', async () => {
    const { service, transitions, recomputes } = build({
      due: [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }],
      activeTerm: null,
    });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(transitions.length, 2);
    assert.deepEqual(recomputes, [], 'no active term → no projection recompute');
    assert.equal(result.desiredRevision, null);
  });

  it('activates a due scheduled term and its pending entitlements atomically', async () => {
    const commands: string[] = [];
    const tx = {
      subscriptionTerm: { findFirst: async () => ({ id: 'term-2' }) },
      addOnEntitlement: { findMany: async () => [{ id: 'ent-pending' }] },
      subscription: { update: async () => ({ remnawaveId: 'rem-1' }) },
      profileSyncJob: { create: async () => ({ id: 'job-activate' }) },
    };
    const prisma = { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
    const entitlements = {
      transitionInTransaction: async (_t: unknown, input: { command: string }) => {
        commands.push(input.command);
        return { changed: true };
      },
    };
    const terms = { activateInTransaction: async () => ({ id: 'term-2', status: 'ACTIVE', changed: true }) };
    const projection = {
      recomputeInTransaction: async () => ({ desiredRevision: 3n, changed: true, desiredTrafficLimitBytes: null, desiredDeviceLimit: 0 }),
    };
    const service = new EntitlementBoundaryService(prisma as never, entitlements as never, terms as never, projection as never);
    const result = await service.activateDueScheduledTerm('sub-1');
    assert.equal(result.activated, true);
    assert.equal(result.termId, 'term-2');
    assert.equal(result.activatedEntitlements, 1);
    assert.deepEqual(commands, ['ACTIVATE']);
    assert.deepEqual(result.syncJobIds, ['job-activate']);
  });

  it('activateDueScheduledTerm is a no-op when no scheduled term is due', async () => {
    const tx = { subscriptionTerm: { findFirst: async () => null } };
    const prisma = { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
    const service = new EntitlementBoundaryService(prisma as never, {} as never, {} as never, {} as never);
    const result = await service.activateDueScheduledTerm('sub-1');
    assert.equal(result.activated, false);
    assert.equal(result.termId, null);
    assert.deepEqual(result.syncJobIds, []);
  });
});
