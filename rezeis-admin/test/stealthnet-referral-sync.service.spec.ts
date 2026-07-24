import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StealthnetReferralSyncService } from '../src/modules/imports/services/stealthnet-referral-sync.service';

describe('StealthnetReferralSyncService', () => {
  it('creates the source edge and preserves an already-issued historical credit without re-crediting points', async () => {
    let edge: { id: string; referredId: string; referrerId: string; qualifiedAt: Date | null } | null = null;
    const rewardCreates: Array<{ data: Record<string, unknown> }> = [];
    const qualificationUpdates: unknown[] = [];
    const service = new StealthnetReferralSyncService({
      referral: {
        findUnique: async ({ where }: { where: { referredId: string } }) =>
          edge !== null && edge.referredId === where.referredId ? edge : null,
        findFirst: async () => null,
        create: async ({ data }: { data: { referredId: string; referrerId: string } }) => {
          edge = { id: 'edge-1', referredId: data.referredId, referrerId: data.referrerId, qualifiedAt: null };
          return edge;
        },
        updateMany: async (input: unknown) => {
          qualificationUpdates.push(input);
          return { count: 1 };
        },
      },
      partnerReferral: { findFirst: async () => null },
      referralReward: {
        findUnique: async () => null,
        create: async (input: { data: Record<string, unknown> }) => rewardCreates.push(input),
      },
    } as never);

    const result = await service.syncImport({
      clients: [
        {
          id: 'source-referrer', email: null, password_hash: null, role: 'CLIENT', remnawave_uuid: null,
          referral_code: 'code-1', referrer_id: null, balance: 0, preferred_lang: 'ru', preferred_currency: 'rub',
          telegram_id: '10', telegram_username: 'referrer', is_blocked: false, block_reason: null, trial_used: false,
          current_tariff_id: null, bot_id: null, created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z',
        },
        {
          id: 'source-referred', email: null, password_hash: null, role: 'CLIENT', remnawave_uuid: null,
          referral_code: 'code-2', referrer_id: 'source-referrer', balance: 0, preferred_lang: 'ru', preferred_currency: 'rub',
          telegram_id: '11', telegram_username: 'referred', is_blocked: false, block_reason: null, trial_used: false,
          current_tariff_id: null, bot_id: null, created_at: '2026-05-02T00:00:00.000Z', updated_at: '2026-05-02T00:00:00.000Z',
        },
      ],
      payments: [{
        id: 'source-payment-1', client_id: 'source-referred', order_id: 'order-1', amount: 100,
        currency: 'rub', status: 'PAID', provider: null, external_id: null, tariff_id: null,
        tariff_price_option_id: null, proxy_tariff_id: null, singbox_tariff_id: null,
        remnawave_user_id: null, metadata: null, created_at: '2026-05-03T00:00:00.000Z',
        paid_at: '2026-05-03T00:00:00.000Z', device_count: null, bot_id: null,
      }],
      referralCredits: [{
        id: 'source-credit-1', referrer_id: 'source-referrer', payment_id: 'source-payment-1',
        amount: 10, level: 1, created_at: '2026-05-03T00:00:00.000Z',
      }],
      sourceUserIds: new Map([
        ['source-referrer', 'user-referrer'],
        ['source-referred', 'user-referred'],
      ]),
    });

    assert.equal(result.created, 1);
    assert.equal(result.creditsCreated, 1);
    assert.equal(qualificationUpdates.length, 1);
    assert.deepStrictEqual(rewardCreates, [{
      data: {
        referralId: 'edge-1',
        userId: 'user-referrer',
        type: 'POINTS',
        amount: 10,
        isIssued: true,
        issuedAt: new Date('2026-05-03T00:00:00.000Z'),
        createdAt: new Date('2026-05-03T00:00:00.000Z'),
        sourceKey: 'stealthnet:source-credit-1',
      },
    }]);
  });

  it('returns SOURCE_NOT_FOUND when no completed import contains a mapping for the user', async () => {
    const service = new StealthnetReferralSyncService({
      importRecord: { findMany: async () => [] },
    } as never);

    assert.deepStrictEqual(await service.syncForUser('user-absent'), {
      importRecordId: null,
      status: 'SOURCE_NOT_FOUND',
      referrerUserId: null,
    });
  });

  it('repairs a mapping retained by a failed import instead of discarding partial progress', async () => {
    const queries: unknown[] = [];
    const service = new StealthnetReferralSyncService({
      importRecord: {
        findMany: async (query: unknown) => {
          queries.push(query);
          return [{
            id: 'failed-import-1',
            result: {
              stealthnetReferrals: {
                mappings: [{
                  referredSourceId: 'source-referred',
                  referrerSourceId: 'source-referrer',
                  referredUserId: 'user-referred',
                  referrerUserId: 'user-referrer',
                  status: 'CREATED',
                }],
              },
            },
          }];
        },
      },
      referral: {
        findUnique: async () => null,
        create: async () => ({ id: 'edge-1' }),
      },
      partnerReferral: { findFirst: async () => null },
    } as never);

    assert.deepStrictEqual(await service.syncForUser('user-referred'), {
      importRecordId: 'failed-import-1',
      status: 'CREATED',
      referrerUserId: 'user-referrer',
    });
    assert.deepStrictEqual(queries, [{
      where: { sourceType: 'stealthnet', status: { in: ['COMMITTED', 'FAILED'] } },
      orderBy: [{ committedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, result: true },
    }]);
  });
});
