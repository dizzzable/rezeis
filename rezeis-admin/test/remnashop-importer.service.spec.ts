import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ImportStatus } from '@prisma/client';

import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';

describe('RemnashopImporterService', () => {
  it('does not rebind a subscription already owned by another local user', async () => {
    const subscriptionUpdates: unknown[] = [];
    let storedResult: Record<string, unknown> | null = null;
    const service = new RemnashopImporterService(
      {
        user: {
          findUnique: async () => ({ id: 'user-matched' }),
          update: async () => undefined,
        },
        subscription: {
          findFirst: async () => ({ id: 'subscription-1', userId: 'another-user' }),
          update: async (input: unknown) => subscriptionUpdates.push(input),
        },
        referral: { findUnique: async () => null },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
        importRecord: {
          create: async (input: { data: { result: Record<string, unknown> } }) => {
            storedResult = input.data.result;
            return { id: 'import-1' };
          },
        },
      } as never,
      { strictGetAllPanelUsers: async () => strictOk({ users: [], total: 0 }) } as never,
    );

    await service.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [user(100000001)],
      subscriptions: [subscription(100000001)],
    });

    assert.deepEqual(subscriptionUpdates, []);
    assert.equal(
      ((storedResult as Record<string, unknown>).conflictCounts as Record<string, number>)
        .subscriptionOwnerMismatch,
      1,
    );
  });

  it('keeps a target plan chosen after an earlier import on a retry', async () => {
    const subscriptionUpdates: Array<{ data: { planSnapshot: Record<string, unknown> } }> = [];
    const service = new RemnashopImporterService(
      {
        user: {
          findUnique: async () => ({ id: 'user-matched' }),
          update: async () => undefined,
        },
        subscription: {
          findFirst: async () => ({
            id: 'subscription-1',
            userId: 'user-matched',
            planSnapshot: { importedFrom: 'remnashop', planId: 'target-plan' },
          }),
          update: async (input: { data: { planSnapshot: Record<string, unknown> } }) => {
            subscriptionUpdates.push(input);
          },
        },
        referral: { findUnique: async () => null },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      { strictGetAllPanelUsers: async () => strictOk({ users: [], total: 0 }) } as never,
    );

    await service.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [user(100000001)],
      subscriptions: [subscription(100000001)],
    });

    assert.equal(subscriptionUpdates.length, 1);
    assert.equal(subscriptionUpdates[0].data.planSnapshot.planId, 'target-plan');
  });

  it('rejects a donor subscription whose live panel profile belongs to another Telegram user', async () => {
    let result: Record<string, unknown> | null = null;
    const service = new RemnashopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-matched' }), update: async () => undefined },
        subscription: { findFirst: async () => null, create: async () => ({ id: 'sub-1' }) },
        referral: { findUnique: async () => null },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-1' };
        } },
      } as never,
      {
        strictGetAllPanelUsers: async () =>
          strictOk({
            users: [{ uuid: subscription(100000001).user_remna_id, telegramId: 100000002 }],
            total: 1,
          }),
      } as never,
    );
    await service.run({ mode: 'import', createdBy: null, users: [user(100000001)], subscriptions: [subscription(100000001)] });
    assert.equal(
      ((result as Record<string, unknown>).conflictCounts as Record<string, number>).panelOwnerMismatch,
      1,
    );
  });

  it('preserves an unavailable donor trial marker across import retries', async () => {
    const claims: Array<{ readonly create: Record<string, unknown> }> = [];
    let consumedClaimExists = false;
    const service = new RemnashopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: { findFirst: async () => null },
        referral: { findUnique: async () => null },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
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
      { strictGetAllPanelUsers: async () => strictOk({ users: [], total: 0 }) } as never,
    );

    const input = {
      mode: 'import' as const,
      createdBy: null,
      users: [user(100000001, false)],
      subscriptions: [],
    };
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

  it('keeps a direct referral out when the target user already has partner attribution', async () => {
    let result: Record<string, unknown> | null = null;
    const users = new Map([[100000001n, 'referrer'], [100000002n, 'referred']]);
    const service = new RemnashopImporterService(
      {
        user: { findUnique: async (input: { where: { telegramId: bigint } }) => ({ id: users.get(input.where.telegramId) }), update: async () => undefined },
        subscription: { findFirst: async () => null },
        referral: { findUnique: async () => null, create: async () => assert.fail('must not create referral') },
        partnerReferral: { findFirst: async () => ({ id: 'partner-attribution' }) },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
        importRecord: { create: async (input: { data: { result: Record<string, unknown> } }) => {
          result = input.data.result;
          return { id: 'import-1' };
        } },
      } as never,
      { strictGetAllPanelUsers: async () => strictOk({ users: [], total: 0 }) } as never,
    );
    await service.run({
      mode: 'import', createdBy: null, users: [user(100000001), user(100000002)], subscriptions: [],
      referrals: [{ id: 1, referrer_telegram_id: 100000001, referred_telegram_id: 100000002, level: 'DIRECT', created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.equal(
      ((result as Record<string, unknown>).conflictCounts as Record<string, number>).partnerAttribution,
      1,
    );
  });

  it('imports a historical transaction and referral reward without replaying customer effects', async () => {
    const transactions: unknown[] = [];
    const rewards: unknown[] = [];
    let result: Record<string, unknown> | null = null;
    const userByTelegram = new Map([
      [100000001n, 'user-referrer'],
      [100000002n, 'user-referred'],
    ]);
    const service = new RemnashopImporterService(
      {
        user: {
          findUnique: async (input: { where: { telegramId: bigint } }) => ({
            id: userByTelegram.get(input.where.telegramId),
          }),
          update: async () => undefined,
        },
        subscription: { findFirst: async () => null },
        transaction: {
          findUnique: async () => null,
          create: async (input: unknown) => {
            transactions.push(input);
            return { id: 'transaction-1' };
          },
        },
        referral: {
          findUnique: async () => null,
          create: async () => ({ id: 'referral-1', referrerId: 'user-referrer' }),
        },
        partnerReferral: { findFirst: async () => null },
        referralReward: {
          findUnique: async () => null,
          create: async (input: unknown) => {
            rewards.push(input);
            return { id: 'reward-1' };
          },
        },
        importRecord: {
          create: async (input: {
            data: { result: Record<string, unknown>; status: ImportStatus };
          }) => {
            result = input.data.result;
            assert.equal(input.data.status, ImportStatus.COMMITTED);
            return { id: 'import-2' };
          },
        },
      } as never,
      { strictGetAllPanelUsers: async () => strictOk({ users: [], total: 0 }) } as never,
    );

    await service.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [user(100000001), user(100000002)],
      subscriptions: [],
      transactions: [
        {
          id: 7,
          payment_id: 'provider-payment-7',
          user_telegram_id: 100000002,
          status: 'COMPLETED',
          is_test: false,
          purchase_type: 'NEW',
          gateway_type: 'PLATEGA',
          pricing: { final_amount: '199.00' },
          currency: 'RUB',
          plan_snapshot: { id: 2, name: 'Example plan' },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      referrals: [
        {
          id: 11,
          referrer_telegram_id: 100000001,
          referred_telegram_id: 100000002,
          level: 'FIRST',
          created_at: '2026-05-01T00:00:00.000Z',
        },
      ],
      referralRewards: [
        {
          id: 12,
          referral_id: 11,
          user_telegram_id: 100000001,
          type: 'POINTS',
          amount: 25,
          is_issued: true,
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    assert.equal(transactions.length, 1);
    assert.equal(rewards.length, 1);
    const transaction = transactions[0] as {
      data: { paymentId: string; subscriptionId?: string; gatewayId?: string | null };
    };
    assert.equal(transaction.data.paymentId, 'remnashop:7');
    assert.equal(transaction.data.subscriptionId, undefined);
    assert.equal(transaction.data.gatewayId, undefined);
    const summary = result as Record<string, unknown>;
    assert.equal(summary.transactionsCreated, 1);
    assert.equal(summary.referralsCreated, 1);
    assert.equal(summary.referralRewardsCreated, 1);
  });
});

function user(telegramId: number, isTrialAvailable = true) {
  return {
    id: telegramId - 100000000,
    telegram_id: telegramId,
    username: null,
    referral_code: null,
    name: 'Example user',
    role: 1,
    language: 'RU',
    personal_discount: 0,
    purchase_discount: 0,
    points: 0,
    is_blocked: false,
    is_bot_blocked: false,
    is_rules_accepted: true,
    is_trial_available: isTrialAvailable,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function subscription(telegramId: number) {
  return {
    id: 1,
    user_remna_id: '11111111-1111-4111-8111-111111111111',
    user_telegram_id: telegramId,
    status: 'ACTIVE',
    is_trial: false,
    traffic_limit: 0,
    device_limit: 1,
    traffic_limit_strategy: 'NO_RESET',
    tag: null,
    internal_squads: [],
    external_squad: null,
    expire_at: null,
    url: null,
    plan_snapshot: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}
