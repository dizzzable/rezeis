import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PartnerSummaryService } from '../src/modules/partners/services/partner-summary.service';

describe('PartnerSummaryService', () => {
  it('returns partner summary for a user-owned partner', async () => {
    const service = new PartnerSummaryService({
      partner: {
        findUnique: async () => ({
          id: 'partner-1',
          userId: 'user-1',
          balance: 1000,
          totalEarned: 5000,
          totalWithdrawn: 2500,
          referralsCount: 5,
          level2ReferralsCount: 2,
          level3ReferralsCount: 1,
          isActive: true,
        }),
      },
    } as never);

    const result = await service.getSummary('user-1');

    assert.deepStrictEqual(result, {
      userId: 'user-1',
      partnerId: 'partner-1',
      balance: 1000,
      totalEarned: 5000,
      totalWithdrawn: 2500,
      referralsCount: 5,
      level2ReferralsCount: 2,
      level3ReferralsCount: 1,
      isActive: true,
    });
  });

  it('lists partner earnings newest first', async () => {
    const service = new PartnerSummaryService({
      partner: {
        findUnique: async () => ({ id: 'partner-1' }),
      },
      partnerTransaction: {
        findMany: async () => [
          {
            id: 'earning-1',
            partnerId: 'partner-1',
            referralTelegramId: BigInt(777000),
            level: 'LEVEL_1',
            paymentAmount: 1000,
            percent: { toString: () => '10.00' },
            earnedAmount: 100,
            sourceTransactionId: 'tx-1',
            description: 'First payment',
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
          },
        ],
      },
    } as never);

    const result = await service.listEarnings('user-1');

    assert.deepStrictEqual(result, [
      {
        id: 'earning-1',
        partnerId: 'partner-1',
        referralTelegramId: '777000',
        level: 'LEVEL_1',
        paymentAmount: 1000,
        percent: '10.00',
        earnedAmount: 100,
        sourceTransactionId: 'tx-1',
        description: 'First payment',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
  });
});
