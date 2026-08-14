import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';

describe('EntitlementCutoverService reset anchor', () => {
  it('leaves MONTH_ROLLING unanchored until panel createdAt is available', async () => {
    // Written from inside the double, where the surrounding flow analysis
    // cannot see the write; held on an object so the captured input keeps its
    // declared type instead of collapsing to the initial null.
    const scheduled: { input: { resetAnchorAt: Date | null } | null } = { input: null };
    const currentSubscription = {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      trafficLimit: 100,
      deviceLimit: 3,
      planSnapshot: { id: 'plan-1', trafficLimitStrategy: 'MONTH_ROLLING' },
      createdAt: new Date('2025-01-15T12:30:00.000Z'),
      expiresAt: new Date('2027-01-15T12:30:00.000Z'),
    };
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1' }],
      subscription: {
        findUnique: async () => currentSubscription,
      },
      subscriptionTerm: {
        findFirst: async () => null,
      },
    };
    const terms = {
      createScheduledInTransaction: async (_tx: unknown, input: { resetAnchorAt: Date | null }) => {
        scheduled.input = input;
        return { id: 'term-1' };
      },
      activateInTransaction: async () => ({ id: 'term-1', changed: true }),
    };
    const projection = {
      recomputeInTransaction: async () => ({ changed: false }),
    };
    const service = new EntitlementCutoverService({} as never, terms as never, projection as never);

    await service.cutoverSubscriptionInTransaction(tx as never, {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      trafficLimit: 100,
      deviceLimit: 3,
      planSnapshot: { id: 'plan-1', trafficLimitStrategy: 'MONTH_ROLLING' },
      createdAt: new Date('2025-01-15T12:30:00.000Z'),
      expiresAt: new Date('2027-01-15T12:30:00.000Z'),
    });

    assert.ok(scheduled.input, 'the cutover must schedule a term');
    assert.equal(scheduled.input.resetAnchorAt, null);
  });

  it('locks and re-reads the subscription before cutover, skipping a stale candidate deleted meanwhile', async () => {
    let termLookupCalled = false;
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1' }],
      subscription: {
        findUnique: async () => ({
          id: 'sub-1',
          status: SubscriptionStatus.DELETED,
          trafficLimit: 999,
          deviceLimit: 99,
          planSnapshot: {},
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          expiresAt: null,
        }),
      },
      subscriptionTerm: {
        findFirst: async () => {
          termLookupCalled = true;
          return null;
        },
      },
    };
    const service = new EntitlementCutoverService(
      {} as never,
      { createScheduledInTransaction: async () => assert.fail('must not create a term') } as never,
      { recomputeInTransaction: async () => assert.fail('must not recompute') } as never,
    );

    const result = await service.cutoverSubscriptionInTransaction(tx as never, {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      trafficLimit: 100,
      deviceLimit: 3,
      planSnapshot: { id: 'stale-plan', trafficLimitStrategy: 'MONTH' },
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });

    assert.equal(result.outcome, 'SKIPPED_DELETED');
    assert.equal(termLookupCalled, false);
  });
});
