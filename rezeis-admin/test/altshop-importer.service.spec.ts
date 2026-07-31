import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';

describe('AltshopImporterService', () => {
  it('does not rebind an existing subscription owned by another user', async () => {
    const updates: unknown[] = [];
    let result: Record<string, unknown> | null = null;
    const service = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: {
          findFirst: async () => ({ id: 'subscription-1', userId: 'user-other', planSnapshot: {} }),
          update: async (value: unknown) => updates.push(value),
        },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-1' };
        } },
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );
    await service.run({ mode: 'import', createdBy: null, users: [user(1)], subscriptions: [subscription(1)] });
    assert.deepEqual(updates, []);
    assert.equal((result?.conflicts as Record<string, number>).subscriptionOwnerMismatch, 1);
  });

  it('preserves a target plan selected after an earlier import', async () => {
    const updates: Array<{ data: { planSnapshot: Record<string, unknown> } }> = [];
    const service = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: {
          findFirst: async () => ({ id: 'subscription-1', userId: 'user-1', planSnapshot: { planId: 'target-plan' } }),
          update: async (value: { data: { planSnapshot: Record<string, unknown> } }) => updates.push(value),
        },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );
    await service.run({ mode: 'import', createdBy: null, users: [user(1)], subscriptions: [subscription(1)] });
    assert.equal(updates[0].data.planSnapshot.planId, 'target-plan');
  });

  it('rejects a donor subscription when its live Remnawave owner differs', async () => {
    let result: Record<string, unknown> | null = null;
    const service = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: { findFirst: async () => null, create: async () => ({ id: 'sub-1' }) },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-1' };
        } },
      } as never,
      { getAllPanelUsers: async () => [{ uuid: subscription(1).user_remna_id, telegramId: 2 }] } as never,
    );
    await service.run({ mode: 'import', createdBy: null, users: [user(1)], subscriptions: [subscription(1)] });
    assert.equal((result?.conflicts as Record<string, number>).panelOwnerMismatch, 1);
  });

  it('preserves an unavailable donor trial marker across import retries', async () => {
    const claims: Array<{ readonly create: Record<string, unknown> }> = [];
    let consumedClaimExists = false;
    const service = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: { findFirst: async () => null },
        importRecord: { create: async () => ({ id: 'import-1' }) },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            $queryRaw: async () => [{ id: 'user-1' }],
            trialClaim: {
              findFirst: async () => (consumedClaimExists ? { id: 'existing-claim' } : null),
              upsert: async (input: { readonly create: Record<string, unknown> }) => {
                claims.push(input);
                consumedClaimExists = true;
              },
            },
          }),
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );

    const input = { mode: 'import' as const, createdBy: null, users: [user(1, false)], subscriptions: [] };
    await service.run(input);
    await service.run(input);

    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0]?.create, {
      id: 'legacy-trial-unavailable:user-1',
      userId: 'user-1',
      planId: null,
      source: 'LEGACY',
      status: 'CONSUMED',
      units: 1,
      consumedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('imports payment and referral history without reissuing customer effects', async () => {
    const transactions: Array<{ data: Record<string, unknown> }> = [];
    const rewards: unknown[] = [];
    let result: Record<string, unknown> | null = null;
    const users = new Map([[1n, 'referrer'], [2n, 'referred']]);
    const service = new AltshopImporterService(
      {
        user: {
          findUnique: async (input: { where: { telegramId: bigint } }) => ({ id: users.get(input.where.telegramId) }),
          update: async () => undefined,
        },
        subscription: { findFirst: async () => null },
        transaction: {
          findUnique: async () => null,
          create: async (input: { data: Record<string, unknown> }) => {
            transactions.push(input);
            return { id: 'tx-7' };
          },
        },
        referral: {
          findUnique: async () => null,
          create: async () => ({ id: 'referral-1', referrerId: 'referrer' }),
        },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null, create: async (input: unknown) => rewards.push(input) },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-2' };
        } },
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );
    await service.run({
      mode: 'import', createdBy: null, users: [user(1), user(2)], subscriptions: [],
      transactions: [{ id: 7, payment_id: 'provider-id', user_telegram_id: 2, status: 'COMPLETED', purchase_type: 'ADDITIONAL', gateway_type: 'PLATEGA', pricing: { final_amount: 100 }, currency: 'RUB', channel: 'WEB', created_at: '2026-01-01T00:00:00.000Z', plan_snapshot: null }],
      referrals: [{ id: 3, referrer_telegram_id: 1, referred_telegram_id: 2, level: 1, invite_source: 'BOT', created_at: '2026-01-01T00:00:00.000Z' }],
      referralRewards: [{ id: 4, referral_id: 3, user_telegram_id: 1, type: 'POINTS', amount: 20, is_issued: true, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.equal(transactions[0].data.paymentId, 'altshop:7');
    assert.equal(transactions[0].data.gatewayId, undefined);
    assert.equal(rewards.length, 1);
    assert.equal(result?.transactionsCreated, 1);
    assert.equal(result?.referralsCreated, 1);
    assert.equal(result?.referralRewardsCreated, 1);
  });

  it('preserves partner attribution instead of also creating a direct referral', async () => {
    const created: unknown[] = [];
    let result: Record<string, unknown> | null = null;
    const service = new AltshopImporterService(
      {
        user: {
          findUnique: async (input: { where: { telegramId: bigint } }) => ({ id: input.where.telegramId === 1n ? 'partner' : 'referred' }),
          update: async () => undefined,
        },
        subscription: { findFirst: async () => null },
        referral: { findUnique: async () => null, create: async (row: unknown) => created.push(row) },
        partnerReferral: { findFirst: async () => null },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-5' };
        } },
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );
    await service.run({
      mode: 'import', createdBy: null, users: [user(1), user(2)], subscriptions: [],
      referrals: [{ id: 1, referrer_telegram_id: 1, referred_telegram_id: 2, level: 1, created_at: '2026-01-01T00:00:00.000Z' }],
      partnerReferrals: [{ id: 5, partner_id: 99, parent_partner_id: null, referral_telegram_id: 2, level: 1, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.deepEqual(created, []);
    assert.equal((result?.conflicts as Record<string, number>).partnerAttribution, 1);
  });

  it('uses source keys so a partner ledger retry cannot duplicate history', async () => {
    const partnerTransactions: Array<{ data: Record<string, unknown> }> = [];
    const service = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'partner-user' }), update: async () => undefined },
        subscription: { findFirst: async () => null },
        partner: { findUnique: async () => null, create: async () => ({ id: 'partner-1' }) },
        partnerTransaction: {
          findUnique: async () => null,
          create: async (input: { data: Record<string, unknown> }) => partnerTransactions.push(input),
        },
        importRecord: { create: async () => ({ id: 'import-3' }) },
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );
    await service.run({
      mode: 'import', createdBy: null, users: [user(1), user(2)], subscriptions: [],
      partners: [{ id: 10, user_telegram_id: 1, balance: 100, total_earned: 100, total_withdrawn: 0, is_active: true, individual_settings: null, created_at: '2026-01-01T00:00:00.000Z' }],
      partnerTransactions: [{ id: 9, partner_id: 10, referral_telegram_id: 2, level: 1, payment_amount: 100, percent: '10', earned_amount: 10, source_transaction_id: null, description: null, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.equal(partnerTransactions.length, 1);
    assert.equal(partnerTransactions[0].data.sourceKey, 'altshop:partner-transaction:9');
  });

  it('skips an unresolvable partner ledger row instead of creating a misattributed payout', async () => {
    const created: unknown[] = [];
    let result: Record<string, unknown> | null = null;
    const service = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: { findFirst: async () => null },
        partnerTransaction: { findUnique: async () => null, create: async (row: unknown) => created.push(row) },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-4' };
        } },
      } as never,
      { getAllPanelUsers: async () => [] } as never,
    );
    await service.run({
      mode: 'import', createdBy: null, users: [user(1)], subscriptions: [],
      partnerTransactions: [{ id: 5, partner_id: 999, referral_telegram_id: 1, level: 1, payment_amount: 100, percent: '10', earned_amount: 10, source_transaction_id: null, description: null, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.deepEqual(created, []);
    assert.equal((result?.conflicts as Record<string, number>).partnerTransactionSkipped, 1);
  });
});

function user(telegramId: number, isTrialAvailable = true) {
  return { id: telegramId, telegram_id: telegramId, username: null, referral_code: null, name: 'Example', role: 1, language: 'RU', personal_discount: 0, purchase_discount: 0, points: 0, is_blocked: false, is_bot_blocked: false, is_rules_accepted: true, is_trial_available: isTrialAvailable, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
}

function subscription(telegramId: number) {
  return { id: 1, user_remna_id: '11111111-1111-4111-8111-111111111111', user_telegram_id: telegramId, status: 'ACTIVE', is_trial: false, traffic_limit: 0, device_limit: 1, traffic_limit_strategy: null, tag: null, internal_squads: [], external_squad: null, expire_at: null, url: null, plan_snapshot: null, device_type: null, created_at: '2026-01-01T00:00:00.000Z' };
}
