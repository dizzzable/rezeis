import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

describe('PlanSnapshotSyncService', () => {
  it('updates only mirrored metadata inside planSnapshot', async () => {
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
          name: 'Starter',
          duration: 30,
          originalAmount: '9.99',
          tag: 'popular',
          type: 'BOTH',
          trafficLimit: 1024,
          deviceLimit: 2,
          trafficLimitStrategy: 'WEEK',
          internalSquads: ['11111111-1111-1111-1111-111111111111'],
          externalSquad: '22222222-2222-2222-2222-222222222222',
        },
      },
    ]);
  });

  it('keeps the snapshot icon frozen when the operator restyles the plan', async () => {
    // The icon is captured at purchase time on purpose: a customer's card must
    // not change its glyph because the plan was restyled later. Labels and
    // limits DO track the live plan — only the icon is frozen.
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
