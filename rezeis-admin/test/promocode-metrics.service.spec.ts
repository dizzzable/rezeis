import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeRewardType } from '@prisma/client';

import { PromocodesStatsService } from '../src/modules/promocodes/services/promocodes-stats.service';

describe('PromocodesStatsService', () => {
  it('aggregates activation totals by code, reward, user, and day', async () => {
    let findManyArgs: unknown;
    const service = new PromocodesStatsService({
      promocodeActivation: {
        findMany: async (args: unknown) => {
          findManyArgs = args;
          return [
            {
              promocodeId: 'promo-1',
              promocodeCode: 'PROMO',
              rewardType: PromocodeRewardType.DURATION,
              rewardValue: 7,
              userId: 'user-1',
              activatedAt: new Date('2026-04-20T10:00:00.000Z'),
              user: { name: 'Alice', username: 'alice', telegramId: BigInt('1001') },
            },
            {
              promocodeId: 'promo-1',
              promocodeCode: 'PROMO',
              rewardType: PromocodeRewardType.DURATION,
              rewardValue: 3,
              userId: 'user-2',
              activatedAt: new Date('2026-04-20T12:00:00.000Z'),
              user: { name: '', username: null, telegramId: BigInt('1002') },
            },
          ];
        },
      },
    } as never);

    const result = await service.getStats({
      from: new Date('2026-04-01T00:00:00.000Z'),
      promocodeId: 'promo-1',
    });

    assert.deepStrictEqual((findManyArgs as { where: unknown }).where, {
      promocodeId: 'promo-1',
      activatedAt: { gte: new Date('2026-04-01T00:00:00.000Z') },
    });
    assert.deepStrictEqual(result.totals, { activations: 2, uniqueUsers: 2 });
    assert.deepStrictEqual(result.byCode, [{
      promocodeId: 'promo-1',
      promocodeCode: 'PROMO',
      rewardType: PromocodeRewardType.DURATION,
      activations: 2,
      uniqueUsers: 2,
    }]);
    assert.deepStrictEqual(result.byReward, [{
      rewardType: PromocodeRewardType.DURATION,
      activations: 2,
      totalRewardValue: 10,
    }]);
    assert.deepStrictEqual(result.topUsers.map((user) => user.displayName), ['Alice', 'tg:1002']);
    assert.deepStrictEqual(result.timeline, [{ bucket: '2026-04-20', activations: 2 }]);
  });
});
