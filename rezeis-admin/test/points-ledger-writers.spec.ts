import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReferralRewardType } from '@prisma/client';

import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';

/**
 * The writers whose own specs never reach their points path: the referral
 * refund reversal and the Stealthnet balance import. Each drives the real
 * service through the real wallet against a fake that models one user row,
 * and asserts the one ledger row the movement must leave behind.
 *
 * The other writers are covered where their fakes already live: the quest
 * claim, the referral payout, the exchange, the operator's adjustment and the
 * account merge each assert their ledger row in their own spec.
 */

interface UserRow {
  id: string;
  points: number;
}

function walletFakes(row: UserRow, recorded: Array<{ op: string; args: unknown }>) {
  return {
    user: {
      findUnique: async (args: { where: { id?: string; telegramId?: bigint }; select?: Record<string, boolean> }) => {
        recorded.push({ op: 'user.findUnique', args });
        if (args.where.telegramId !== undefined) return { id: row.id };
        if (args.where.id !== row.id) return null;
        return args.select?.['points'] ? { points: row.points } : { id: row.id, createdAt: new Date('2020-01-01T00:00:00.000Z') };
      },
      update: async (args: unknown) => {
        recorded.push({ op: 'user.update', args });
        return { id: row.id };
      },
      updateMany: async (args: {
        where: { id: string; points?: number | { gte?: number } };
        data: { points: { increment?: number; decrement?: number } };
      }) => {
        recorded.push({ op: 'user.updateMany', args });
        if (args.where.id !== row.id) return { count: 0 };
        const cond = args.where.points;
        if (typeof cond === 'number' && row.points !== cond) return { count: 0 };
        if (typeof cond === 'object' && cond?.gte !== undefined && row.points < cond.gte) return { count: 0 };
        row.points += (args.data.points.increment ?? 0) - (args.data.points.decrement ?? 0);
        return { count: 1 };
      },
    },
    pointsLedgerEntry: {
      findUnique: async (args: unknown) => {
        recorded.push({ op: 'pointsLedgerEntry.findUnique', args });
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.push({ op: 'pointsLedgerEntry.create', args });
        return { id: 'ledger-1' };
      },
    },
  };
}

function ledgerRows(recorded: Array<{ op: string; args: unknown }>): Array<Record<string, unknown>> {
  return recorded
    .filter((call) => call.op === 'pointsLedgerEntry.create')
    .map((call) => (call.args as { data: Record<string, unknown> }).data);
}

describe('the referral reward reversal writes through the wallet', () => {
  function makeService(row: UserRow, reward: { isIssued: boolean; amount: number }) {
    const recorded: Array<{ op: string; args: unknown }> = [];
    const model = {
      ...walletFakes(row, recorded),
      referral: {
        findFirst: async () => ({ id: 'referral-1' }),
        update: async (args: unknown) => {
          recorded.push({ op: 'referral.update', args });
          return {};
        },
      },
      referralReward: {
        findMany: async () => [
          { id: 'reward-1', userId: row.id, type: ReferralRewardType.POINTS, amount: reward.amount, isIssued: reward.isIssued },
        ],
        update: async (args: unknown) => {
          recorded.push({ op: 'referralReward.update', args });
          return {};
        },
      },
    };
    const client = {
      ...model,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(model),
    };
    const service = new ReferralQualificationService(
      client as never,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      new PointsWalletService(),
    );
    return { service, recorded };
  }

  it('debits an issued POINTS reward with a floor, and journals requested / applied / shortfall', async () => {
    const row = { id: 'referrer-1', points: 15 };
    const { service, recorded } = makeService(row, { isIssued: true, amount: 40 });

    await service.reverseQualificationForTransaction('tx-refunded');

    assert.equal(row.points, 0, 'what the referrer still held was taken; the balance stops at zero');
    assert.deepEqual(ledgerRows(recorded), [
      {
        userId: 'referrer-1',
        delta: -15,
        balanceAfter: 0,
        source: 'REFERRAL_REWARD_REVOKED',
        referenceKey: 'reward-1',
        details: {
          rewardId: 'reward-1',
          referralId: 'referral-1',
          transactionId: 'tx-refunded',
          requested: 40,
          applied: 15,
          shortfall: 25,
        },
      },
    ]);
    assert.ok(
      recorded.some((call) => call.op === 'referralReward.update'),
      'and the reward is still marked revoked',
    );
  });

  it('touches no balance for a reward that was never issued', async () => {
    const row = { id: 'referrer-1', points: 15 };
    const { service, recorded } = makeService(row, { isIssued: false, amount: 40 });

    await service.reverseQualificationForTransaction('tx-refunded');

    assert.equal(row.points, 15);
    assert.deepEqual(ledgerRows(recorded), []);
    assert.equal(recorded.some((call) => call.op === 'user.updateMany'), false);
  });
});

describe('the Stealthnet balance import writes through the wallet', () => {
  function makeService(row: UserRow) {
    const recorded: Array<{ op: string; args: unknown }> = [];
    const model = {
      ...walletFakes(row, recorded),
      subscription: { findFirst: async () => null, update: async () => undefined },
      importRecord: { create: async () => ({ id: 'import-1' }) },
    };
    const client = {
      ...model,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(model),
    };
    const service = new StealthnetImporterService(
      client as never,
      { strictGetAllPanelUsers: async () => strictOk({ users: [], total: 0 }) } as never,
      {
        syncImport: async () => ({
          mappings: [], created: 0, existing: 0, skipped: 0,
          creditsCreated: 0, creditsExisting: 0, creditsSkipped: 0,
        }),
      } as never,
      new PointsWalletService(),
    );
    return { service, recorded };
  }

  const client = {
    id: 'client-1', email: null, password_hash: null, role: 'user', remnawave_uuid: null,
    referral_code: null, referrer_id: null, balance: 300, preferred_lang: 'ru', preferred_currency: 'RUB',
    telegram_id: '123', telegram_username: null, is_blocked: false, block_reason: null, trial_used: false,
    current_tariff_id: null, bot_id: null, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
  };
  const emptyBackup = {
    subscriptions: [], tariffs: [], tariffCategories: [], tariffPriceOptions: [], payments: [], referralCredits: [],
  };

  it('credits the migrated balance once, keyed on the user, only while the wallet is still empty', async () => {
    const row = { id: 'user-1', points: 0 };
    const { service, recorded } = makeService(row);

    await service.run({ mode: 'import', createdBy: 'admin-1', clients: [client], ...emptyBackup } as never);

    assert.equal(row.points, 300, '1:1 by default');
    assert.deepEqual(ledgerRows(recorded), [
      {
        userId: 'user-1',
        delta: 300,
        balanceAfter: 300,
        source: 'IMPORT',
        referenceKey: 'stealthnet-balance:user-1',
        details: { importer: 'stealthnet', clientId: 'client-1', balance: 300, rate: 1 },
      },
    ]);
    const write = recorded.find((call) => call.op === 'user.updateMany')!.args as { where: Record<string, unknown> };
    assert.deepEqual(write.where, { id: 'user-1', points: 0 }, 'the "still empty" precondition travels with the write');
  });

  it('does not credit again on a re-import: the wallet already holds points', async () => {
    const row = { id: 'user-1', points: 120 };
    const { service, recorded } = makeService(row);

    await service.run({ mode: 'import', createdBy: 'admin-1', clients: [client], ...emptyBackup } as never);

    assert.equal(row.points, 120, 'already-earned points are never overwritten');
    assert.deepEqual(ledgerRows(recorded), []);
  });
});
