import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { AccountMergeService } from '../src/modules/account-merge/services/account-merge.service';

interface Call {
  readonly model: string;
  readonly op: string;
  readonly args: Record<string, unknown>;
}

interface MergeFixtures {
  readonly source?: Record<string, unknown> | null;
  readonly target?: Record<string, unknown> | null;
  readonly subCount?: number;
  readonly txCount?: number;
  readonly partnerTxCount?: number;
  readonly targetConv?: { id: string } | null;
  readonly targetReferred?: { id: string } | null;
  readonly remnawaveSubs?: Array<{ id: string }>;
  readonly currentSub?: { id: string } | null;
  readonly targetExchangeKeys?: string[];
  readonly targetQuestKeys?: Array<{ questId: string; periodKey: string }>;
  readonly sourceQuestRows?: Array<{ id: string; questId: string; periodKey: string }>;
}

function createMergeMock(fx: MergeFixtures): { prisma: PrismaService; calls: Call[]; events: string[] } {
  const calls: Call[] = [];
  const events: string[] = [];
  const rec = (model: string, op: string, args: Record<string, unknown>): void => {
    calls.push({ model, op, args });
  };

  const tx = {
    $queryRaw: async () => [{ id: 'locked-user' }],
    user: {
      findUnique: async (a: { where: { id: string } }) => {
        if (a.where.id === (fx.source as { id?: string } | null)?.id) return fx.source ?? null;
        if (a.where.id === (fx.target as { id?: string } | null)?.id) return fx.target ?? null;
        return null;
      },
      update: async (a: Record<string, unknown>) => {
        rec('user', 'update', a);
        return { id: 'u' };
      },
      delete: async (a: Record<string, unknown>) => {
        rec('user', 'delete', a);
        return { id: 'u' };
      },
    },
    subscription: {
      updateMany: async (a: Record<string, unknown>) => {
        rec('subscription', 'updateMany', a);
        return { count: fx.subCount ?? 0 };
      },
      findMany: async () => fx.remnawaveSubs ?? [],
      findFirst: async () => fx.currentSub ?? null,
    },
    transaction: {
      updateMany: async (a: Record<string, unknown>) => {
        rec('transaction', 'updateMany', a);
        return { count: fx.txCount ?? 0 };
      },
    },
    referralPointsExchange: {
      findMany: async () => (fx.targetExchangeKeys ?? []).map((idempotencyKey) => ({ idempotencyKey })),
      updateMany: async (a: Record<string, unknown>) => { rec('referralPointsExchange', 'updateMany', a); return { count: 0 }; },
    },
    referralReward: { updateMany: async (a: Record<string, unknown>) => { rec('referralReward', 'updateMany', a); return { count: 0 }; } },
    referralInvite: { updateMany: async (a: Record<string, unknown>) => { rec('referralInvite', 'updateMany', a); return { count: 0 }; } },
    userNotificationEvent: { updateMany: async (a: Record<string, unknown>) => { rec('userNotificationEvent', 'updateMany', a); return { count: 0 }; } },
    webPushSubscription: { updateMany: async (a: Record<string, unknown>) => { rec('webPushSubscription', 'updateMany', a); return { count: 0 }; } },
    supportTicket: { updateMany: async (a: Record<string, unknown>) => { rec('supportTicket', 'updateMany', a); return { count: 0 }; } },
    adClick: { updateMany: async (a: Record<string, unknown>) => { rec('adClick', 'updateMany', a); return { count: 0 }; } },
    broadcastMessage: { updateMany: async (a: Record<string, unknown>) => { rec('broadcastMessage', 'updateMany', a); return { count: 0 }; } },
    userOAuthLink: { updateMany: async (a: Record<string, unknown>) => { rec('userOAuthLink', 'updateMany', a); return { count: 0 }; } },
    savedPaymentMethod: { updateMany: async (a: Record<string, unknown>) => { rec('savedPaymentMethod', 'updateMany', a); return { count: 0 }; } },
    paymentMethodSetup: { updateMany: async (a: Record<string, unknown>) => { rec('paymentMethodSetup', 'updateMany', a); return { count: 0 }; } },
    trialClaim: { updateMany: async (a: Record<string, unknown>) => { rec('trialClaim', 'updateMany', a); return { count: 0 }; } },
    questCompletion: {
      findMany: async (a: { where: { userId: string } }) => {
        // Target lookup returns taken (questId, periodKey); source lookup
        // returns the full source rows (with ids) to dedupe.
        if (a.where.userId === (fx.target as { id?: string } | null)?.id) {
          return fx.targetQuestKeys ?? [];
        }
        return fx.sourceQuestRows ?? [];
      },
      deleteMany: async (a: Record<string, unknown>) => { rec('questCompletion', 'deleteMany', a); return { count: 0 }; },
      updateMany: async (a: Record<string, unknown>) => { rec('questCompletion', 'updateMany', a); return { count: 0 }; },
    },
    promocodeActivation: {
      findMany: async () => [],
      deleteMany: async (a: Record<string, unknown>) => { rec('promocodeActivation', 'deleteMany', a); return { count: 0 }; },
      updateMany: async (a: Record<string, unknown>) => { rec('promocodeActivation', 'updateMany', a); return { count: 0 }; },
    },
    partnerTransaction: {
      updateMany: async (a: Record<string, unknown>) => { rec('partnerTransaction', 'updateMany', a); return { count: fx.partnerTxCount ?? 0 }; },
    },
    partnerReferral: {
      findMany: async () => [],
      deleteMany: async (a: Record<string, unknown>) => { rec('partnerReferral', 'deleteMany', a); return { count: 0 }; },
      updateMany: async (a: Record<string, unknown>) => { rec('partnerReferral', 'updateMany', a); return { count: 0 }; },
    },
    adConversion: {
      // Uniqueness is a partial index on ATTRIBUTED rows now, so the merge probes
      // the target with findFirst instead of a unique-key lookup.
      findFirst: async () => fx.targetConv ?? null,
      deleteMany: async (a: Record<string, unknown>) => { rec('adConversion', 'deleteMany', a); return { count: 0 }; },
      updateMany: async (a: Record<string, unknown>) => { rec('adConversion', 'updateMany', a); return { count: 0 }; },
    },
    referral: {
      deleteMany: async (a: Record<string, unknown>) => { rec('referral', 'deleteMany', a); return { count: 0 }; },
      findUnique: async () => fx.targetReferred ?? null,
      updateMany: async (a: Record<string, unknown>) => { rec('referral', 'updateMany', a); return { count: 0 }; },
    },
    partnerWithdrawal: { updateMany: async (a: Record<string, unknown>) => { rec('partnerWithdrawal', 'updateMany', a); return { count: 0 }; } },
    partner: {
      update: async (a: Record<string, unknown>) => { rec('partner', 'update', a); return { id: 'p' }; },
      delete: async (a: Record<string, unknown>) => { rec('partner', 'delete', a); return { id: 'p' }; },
    },
    trialGrant: {
      update: async (a: Record<string, unknown>) => { rec('trialGrant', 'update', a); return { id: 't' }; },
      delete: async (a: Record<string, unknown>) => { rec('trialGrant', 'delete', a); return { id: 't' }; },
    },
    webAccount: {
      update: async (a: Record<string, unknown>) => { rec('webAccount', 'update', a); return { id: 'w' }; },
      delete: async (a: Record<string, unknown>) => { rec('webAccount', 'delete', a); return { id: 'w' }; },
    },
  };

  const prisma = {
    $transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    profileSyncJob: {
      create: async (a: Record<string, unknown>) => {
        rec('profileSyncJob', 'create', a);
        return { id: 'job-1' };
      },
    },
  } as unknown as PrismaService;

  const eventsService = {
    info: (type: string) => { events.push(type); },
    warn: () => undefined,
    error: () => undefined,
    emit: () => undefined,
  } as unknown as SystemEventsService;

  // Stash the events service on the returned object via closure below.
  (createMergeMock as unknown as { _last?: SystemEventsService })._last = eventsService;
  return { prisma, calls, events };
}

function service(prisma: PrismaService): AccountMergeService {
  const eventsService = (createMergeMock as unknown as { _last?: SystemEventsService })._last ?? ({
    info: () => undefined,
  } as unknown as SystemEventsService);
  const queue = { enqueue: async () => undefined } as unknown as import('../src/modules/profile-sync/profile-sync-queue.service').ProfileSyncQueueService;
  return new AccountMergeService(prisma, eventsService, queue);
}

const baseSource = {
  id: 'SRC',
  telegramId: BigInt(111),
  email: 'src@example.com',
  points: 5,
  personalDiscount: 0,
  purchaseDiscount: 0,
  maxSubscriptions: 1,
  acquisitionPlacementId: null,
  acquisitionAt: null,
  partner: null,
  webAccount: null,
  trialGrant: null,
};
const baseTarget = {
  id: 'TGT',
  telegramId: null,
  email: null,
  points: 3,
  personalDiscount: 0,
  purchaseDiscount: 0,
  maxSubscriptions: 2,
  acquisitionPlacementId: null,
  acquisitionAt: null,
  partner: null,
  webAccount: null,
  trialGrant: null,
};

describe('AccountMergeService', () => {
  it('refuses an unconfirmed merge', async () => {
    const { prisma } = createMergeMock({});
    await assert.rejects(
      () => service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: false, actorAdminId: 'a' }),
      BadRequestException,
    );
  });

  it('refuses merging an account into itself', async () => {
    const { prisma } = createMergeMock({});
    await assert.rejects(
      () => service(prisma).merge({ sourceId: 'X', targetId: 'X', choices: {}, confirm: true, actorAdminId: 'a' }),
      BadRequestException,
    );
  });

  it('throws when an account is missing', async () => {
    const { prisma } = createMergeMock({ source: null, target: { ...baseTarget } });
    await assert.rejects(
      () => service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' }),
      NotFoundException,
    );
  });

  it('re-points children, deletes the source, and emits the merge event', async () => {
    const { prisma, calls, events } = createMergeMock({
      source: { ...baseSource },
      target: { ...baseTarget },
      subCount: 2,
      txCount: 4,
      remnawaveSubs: [{ id: 'sub-1' }],
    });
    const result = await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'admin-1' });

    assert.equal(result.mergedUserId, 'TGT');
    assert.equal(result.movedCounts.subscriptions, 2);
    assert.equal(result.movedCounts.transactions, 4);
    assert.deepStrictEqual(result.remnawaveSubscriptionIds, ['sub-1']);

    // Source unique scalars nulled first.
    const firstUserUpdate = calls.find((c) => c.model === 'user' && c.op === 'update');
    assert.deepStrictEqual((firstUserUpdate?.args as { data: unknown }).data, {
      telegramId: null,
      email: null,
      currentSubscriptionId: null,
    });
    // Subscriptions + transactions re-pointed source→target.
    assert.ok(calls.some((c) => c.model === 'subscription' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'transaction' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'referralPointsExchange' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'referralInvite' && c.op === 'updateMany'));
    // HIGH #14: OAuth links + saved cards + card setups re-pointed, not lost.
    assert.ok(calls.some((c) => c.model === 'userOAuthLink' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'savedPaymentMethod' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'paymentMethodSetup' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'trialClaim' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'questCompletion' && c.op === 'updateMany'));
    // Source user deleted.
    assert.ok(calls.some((c) => c.model === 'user' && c.op === 'delete'));
    assert.deepStrictEqual(events, ['user.accounts_merged']);
  });

  it('re-points OAuth links and saved payment instruments to the target (HIGH #14)', async () => {
    const { prisma, calls } = createMergeMock({ source: { ...baseSource }, target: { ...baseTarget } });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    for (const model of ['userOAuthLink', 'savedPaymentMethod', 'paymentMethodSetup']) {
      const move = calls.find((c) => c.model === model && c.op === 'updateMany');
      assert.ok(move, `${model} must be re-pointed`);
      assert.deepStrictEqual((move?.args as { where: unknown; data: unknown }), {
        where: { userId: 'SRC' },
        data: { userId: 'TGT' },
      });
    }
  });

  it('dedupes quest completions on (questId, periodKey): drops the source dupe, keeps target', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource },
      target: { ...baseTarget },
      // Target already completed quest Q1 for the empty default period.
      targetQuestKeys: [{ questId: 'Q1', periodKey: '' }],
      // Source has the same Q1 (collides → dropped) plus a unique Q2 (moves).
      sourceQuestRows: [
        { id: 'QC_SRC_1', questId: 'Q1', periodKey: '' },
        { id: 'QC_SRC_2', questId: 'Q2', periodKey: '' },
      ],
    });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    const del = calls.find((c) => c.model === 'questCompletion' && c.op === 'deleteMany');
    assert.deepStrictEqual((del?.args as { where: unknown }).where, { id: { in: ['QC_SRC_1'] } });
    const move = calls.find((c) => c.model === 'questCompletion' && c.op === 'updateMany');
    assert.deepStrictEqual((move?.args as { where: unknown; data: unknown }), {
      where: { userId: 'SRC' },
      data: { userId: 'TGT' },
    });
  });

  it('clears source exchange keys that would collide on the merged target', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource },
      target: { ...baseTarget },
      targetExchangeKeys: ['same-request'],
    });

    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    const exchangeUpdates = calls.filter(
      (call) => call.model === 'referralPointsExchange' && call.op === 'updateMany',
    );
    assert.deepStrictEqual(exchangeUpdates, [
      {
        model: 'referralPointsExchange',
        op: 'updateMany',
        args: {
          where: { userId: 'SRC', idempotencyKey: { in: ['same-request'] } },
          data: { idempotencyKey: null },
        },
      },
      {
        model: 'referralPointsExchange',
        op: 'updateMany',
        args: { where: { userId: 'SRC' }, data: { userId: 'TGT' } },
      },
    ]);
  });

  it('sums partner balances and deletes the source partner when both are partners', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource, partner: { id: 'P_SRC', balance: 700, totalEarned: 1000, totalWithdrawn: 300 } },
      target: { ...baseTarget, partner: { id: 'P_TGT' } },
    });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    const partnerUpdate = calls.find((c) => c.model === 'partner' && c.op === 'update');
    assert.deepStrictEqual((partnerUpdate?.args as { data: unknown }).data, {
      balance: { increment: 700 },
      totalEarned: { increment: 1000 },
      totalWithdrawn: { increment: 300 },
    });
    // Partner withdrawals re-pointed (Restrict) before deleting source partner.
    assert.ok(calls.some((c) => c.model === 'partnerWithdrawal' && c.op === 'updateMany'));
    assert.ok(calls.some((c) => c.model === 'partner' && c.op === 'delete'));
  });

  it('re-points a sole source partner to the target', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource, partner: { id: 'P_SRC', balance: 100, totalEarned: 100, totalWithdrawn: 0 } },
      target: { ...baseTarget, partner: null },
    });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    const partnerUpdate = calls.find((c) => c.model === 'partner' && c.op === 'update');
    assert.deepStrictEqual((partnerUpdate?.args as { data: unknown }).data, { userId: 'TGT' });
    assert.ok(!calls.some((c) => c.model === 'partner' && c.op === 'delete'));
  });

  it('keeps exactly one trial grant (deletes the source duplicate)', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource, trialGrant: { id: 'TG_SRC' } },
      target: { ...baseTarget, trialGrant: { id: 'TG_TGT' } },
    });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    assert.ok(calls.some((c) => c.model === 'trialGrant' && c.op === 'delete'));
    assert.ok(!calls.some((c) => c.model === 'trialGrant' && c.op === 'update'));
  });

  it('moves a sole source trial grant to the target', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource, trialGrant: { id: 'TG_SRC' } },
      target: { ...baseTarget, trialGrant: null },
    });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    const tgUpdate = calls.find((c) => c.model === 'trialGrant' && c.op === 'update');
    assert.deepStrictEqual((tgUpdate?.args as { data: unknown }).data, { userId: 'TGT' });
  });

  it('applies the source telegram/email to the target when keep=source', async () => {
    const { prisma, calls } = createMergeMock({ source: { ...baseSource }, target: { ...baseTarget } });
    await service(prisma).merge({
      sourceId: 'SRC',
      targetId: 'TGT',
      choices: { keepTelegram: 'source', keepEmail: 'source' },
      confirm: true,
      actorAdminId: 'a',
    });

    // The LAST user.update targets TGT with the survivors + summed points.
    const targetUpdate = [...calls].reverse().find(
      (c) => c.model === 'user' && c.op === 'update' && (c.args as { where: { id: string } }).where.id === 'TGT',
    );
    const data = (targetUpdate?.args as { data: Record<string, unknown> }).data;
    assert.equal(data.telegramId, BigInt(111));
    assert.equal(data.email, 'src@example.com');
    assert.equal(data.points, 8); // 3 + 5
    assert.equal(data.maxSubscriptions, 2); // max(2,1)
  });

  it('keeps the target login by default and deletes the source web account', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource, webAccount: { id: 'WA_SRC' } },
      target: { ...baseTarget, webAccount: { id: 'WA_TGT' } },
    });
    await service(prisma).merge({ sourceId: 'SRC', targetId: 'TGT', choices: {}, confirm: true, actorAdminId: 'a' });

    const waDelete = calls.find((c) => c.model === 'webAccount' && c.op === 'delete');
    assert.deepStrictEqual((waDelete?.args as { where: unknown }).where, { id: 'WA_SRC' });
  });

  it('keeps the source login when keepLogin=source (deletes target web account, re-points source)', async () => {
    const { prisma, calls } = createMergeMock({
      source: { ...baseSource, webAccount: { id: 'WA_SRC' } },
      target: { ...baseTarget, webAccount: { id: 'WA_TGT' } },
    });
    await service(prisma).merge({
      sourceId: 'SRC',
      targetId: 'TGT',
      choices: { keepLogin: 'source' },
      confirm: true,
      actorAdminId: 'a',
    });

    const waDelete = calls.find((c) => c.model === 'webAccount' && c.op === 'delete');
    assert.deepStrictEqual((waDelete?.args as { where: unknown }).where, { id: 'WA_TGT' });
    const waUpdate = calls.find((c) => c.model === 'webAccount' && c.op === 'update');
    assert.deepStrictEqual((waUpdate?.args as { data: unknown }).data, { userId: 'TGT' });
  });
});
