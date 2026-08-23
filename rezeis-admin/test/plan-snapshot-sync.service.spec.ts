import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

describe('PlanSnapshotSyncService', () => {
  it('mirrors the display facts and FREEZES the four limit keys', async () => {
    // The stored snapshot is what the plan gave THIS subscription. Display
    // facts track the live plan; the four limit keys must not, because
    // `resolveInheritedPlanLimitUpdate` compares the subscription's columns
    // against them to decide whether an operator adjusted it individually.
    // Mirroring them moved that baseline out from under every subscriber at
    // once and pinned their limits for good.
    const updatedSnapshots: unknown[] = [];
    const service = new PlanSnapshotSyncService();

    const updatedCount = await service.syncPlanSnapshotMetadata(
      {
        $queryRaw: async () => [
          {
            id: 'subscription-1',
            planSnapshot: {
              id: 'plan-1',
              name: 'Old name',
              duration: 30,
              originalAmount: '9.99',
              trafficLimit: 256,
              deviceLimit: 1,
              internalSquads: ['99999999-9999-9999-9999-999999999999'],
              externalSquad: null,
            },
          },
        ],
        subscription: {
          update: async (...args: readonly unknown[]) => {
            updatedSnapshots.push((args[0] as { readonly data: unknown }).data);
            return null;
          },
        },
      } as never,
      {
        id: 'plan-1',
        name: 'Starter',
        tag: 'popular',
        type: 'BOTH',
        trafficLimit: 1024,
        deviceLimit: 2,
        trafficLimitStrategy: 'WEEK',
        internalSquads: ['11111111-1111-1111-1111-111111111111'],
        externalSquad: '22222222-2222-2222-2222-222222222222',
      },
    );

    assert.equal(updatedCount, 1);
    assert.deepStrictEqual(updatedSnapshots, [
      {
        planSnapshot: {
          id: 'plan-1',
          duration: 30,
          originalAmount: '9.99',
          // Mirrored — these follow the live plan.
          name: 'Starter',
          tag: 'popular',
          type: 'BOTH',
          trafficLimitStrategy: 'WEEK',
          // Frozen — still what the plan gave this subscription at assignment,
          // NOT the plan's edited 1024 / 2 / squads.
          trafficLimit: 256,
          deviceLimit: 1,
          internalSquads: ['99999999-9999-9999-9999-999999999999'],
          externalSquad: null,
        },
      },
    ]);
  });

  it('keeps the snapshot icon frozen when the operator restyles the plan', async () => {
    // The icon is captured at purchase time on purpose: a customer's card must
    // not change its glyph because the plan was restyled later. Labels DO track
    // the live plan; the icon and the four limit keys do not.
    const updatedSnapshots: unknown[] = [];
    const service = new PlanSnapshotSyncService();

    await service.syncPlanSnapshotMetadata(
      {
        $queryRaw: async () => [
          { id: 'subscription-1', planSnapshot: { id: 'plan-1', name: 'Old name', icon: 'zap' } },
        ],
        subscription: {
          update: async (...args: readonly unknown[]) => {
            updatedSnapshots.push((args[0] as { readonly data: unknown }).data);
            return null;
          },
        },
      } as never,
      {
        id: 'plan-1',
        name: 'Starter',
        tag: null,
        type: 'BOTH',
        trafficLimit: null,
        deviceLimit: 0,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
      },
    );

    const [{ planSnapshot }] = updatedSnapshots as ReadonlyArray<{ planSnapshot: { icon?: unknown; name?: unknown } }>;
    assert.equal(planSnapshot.icon, 'zap');
    assert.equal(planSnapshot.name, 'Starter');
  });
});
