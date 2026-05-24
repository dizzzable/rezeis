import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PartnersService } from '../src/modules/partners/services/partners.service';

const NULL_EVENTS = { info: () => undefined, warn: () => undefined, error: () => undefined };
const NULL_NOTIFICATIONS = {
  notifyEarning: async () => undefined,
  notifyWithdrawalApproved: async () => undefined,
  notifyWithdrawalRejected: async () => undefined,
};

function makeFakePartner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    user: { id: 'u1', name: 'Alice', username: 'alice', telegramId: BigInt(1234567), createdAt: new Date('2026-01-01T00:00:00Z') },
    balance: 10000,
    totalEarned: 50000,
    totalWithdrawn: 20000,
    isActive: true,
    useGlobalSettings: true,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: null,
    level2Percent: null,
    level3Percent: null,
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    _count: { referrals: 5 },
    ...overrides,
  };
}

describe('PartnersService', () => {
  it('lists partners with totalEarned desc by default', async () => {
    const seen: { orderBy: unknown; take: number; skip: number }[] = [];
    const service = new PartnersService(
      {
        partner: {
          findMany: async (args: { orderBy: unknown; take: number; skip: number }) => {
            seen.push(args);
            return [makeFakePartner()];
          },
        },
      } as never,
      NULL_EVENTS as never,
      { backfillPartnerReferralChainForUser: async () => ({ attached: 0, considered: 0 }) } as never,
      NULL_NOTIFICATIONS as never,
    );
    const result = await service.listPartners({} as never);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.referralsCount, 5);
    assert.deepEqual(seen[0]?.orderBy, [{ totalEarned: 'desc' }, { createdAt: 'desc' }]);
  });

  it('applies free-text search to user name/username/telegramId', async () => {
    const seen: { where: unknown }[] = [];
    const service = new PartnersService(
      {
        partner: {
          findMany: async (args: { where: unknown }) => {
            seen.push(args);
            return [];
          },
        },
      } as never,
      NULL_EVENTS as never,
      { backfillPartnerReferralChainForUser: async () => ({ attached: 0, considered: 0 }) } as never,
      NULL_NOTIFICATIONS as never,
    );
    await service.listPartners({ search: '1234567' } as never);
    assert.ok(seen[0]?.where);
    const where = seen[0]?.where as { user: { OR: unknown[] } };
    assert.ok(Array.isArray(where.user.OR));
    assert.equal(where.user.OR.length, 3); // name, username, telegramId
  });

  it('toggles partner status and triggers backfill on activation', async () => {
    let backfillCalls = 0;
    const service = new PartnersService(
      {
        partner: {
          findUnique: async () => makeFakePartner({ isActive: false }),
          update: async (args: { data: { isActive: boolean } }) => makeFakePartner({ isActive: args.data.isActive }),
        },
      } as never,
      NULL_EVENTS as never,
      {
        backfillPartnerReferralChainForUser: async () => {
          backfillCalls += 1;
          return { attached: 3, considered: 5 };
        },
      } as never,
      NULL_NOTIFICATIONS as never,
    );
    const updated = await service.togglePartnerStatus('p1');
    assert.equal(updated.isActive, true);
    assert.equal(backfillCalls, 1);
  });

  it('does not call backfill when toggling from active → inactive', async () => {
    let backfillCalls = 0;
    const service = new PartnersService(
      {
        partner: {
          findUnique: async () => makeFakePartner({ isActive: true }),
          update: async () => makeFakePartner({ isActive: false }),
        },
      } as never,
      NULL_EVENTS as never,
      {
        backfillPartnerReferralChainForUser: async () => {
          backfillCalls += 1;
          return { attached: 0, considered: 0 };
        },
      } as never,
      NULL_NOTIFICATIONS as never,
    );
    const updated = await service.togglePartnerStatus('p1');
    assert.equal(updated.isActive, false);
    assert.equal(backfillCalls, 0);
  });
});
