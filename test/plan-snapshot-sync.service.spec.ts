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
});
