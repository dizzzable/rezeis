import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PointsLedgerSource } from '@prisma/client';

import {
  PointsWalletService,
  type PointsWalletTx,
} from '../src/modules/points/services/points-wallet.service';

/**
 * One user row and one ledger table, behaving the way Postgres does for the
 * statements the wallet issues: every clause of an `updateMany` `where` is
 * applied as the filter, `count` is the only answer, and a read after a write
 * in the same transaction sees the write. Calls are recorded in order so a
 * test can assert not only WHAT was written but that the balance was read back
 * AFTER the write rather than before it.
 */
interface Row {
  points: number;
}

interface Recorded {
  readonly op: string;
  readonly args: unknown;
}

function makeTx(input: { readonly row: Row | null; readonly ledger?: Array<{ source: string; referenceKey: string | null }> }) {
  const calls: Recorded[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const existing = input.ledger ?? [];
  const tx = {
    user: {
      updateMany: async (args: {
        where: { id: string; points?: number | { gte?: number; equals?: number } };
        data: { points: { increment?: number; decrement?: number } };
      }) => {
        calls.push({ op: 'user.updateMany', args });
        if (input.row === null) return { count: 0 };
        const cond = args.where.points;
        if (typeof cond === 'number' && input.row.points !== cond) return { count: 0 };
        if (typeof cond === 'object' && cond !== null) {
          if (cond.equals !== undefined && input.row.points !== cond.equals) return { count: 0 };
          if (cond.gte !== undefined && input.row.points < cond.gte) return { count: 0 };
        }
        input.row.points += (args.data.points.increment ?? 0) - (args.data.points.decrement ?? 0);
        return { count: 1 };
      },
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        calls.push({ op: 'user.findUnique', args });
        if (input.row === null) return null;
        return args.select?.['points'] ? { points: input.row.points } : { id: args.where.id };
      },
    },
    pointsLedgerEntry: {
      findUnique: async (args: { where: { source_referenceKey: { source: string; referenceKey: string } } }) => {
        calls.push({ op: 'pointsLedgerEntry.findUnique', args });
        const key = args.where.source_referenceKey;
        return existing.some((row) => row.source === key.source && row.referenceKey === key.referenceKey)
          ? { id: 'ledger-existing' }
          : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ op: 'pointsLedgerEntry.create', args });
        ledger.push(args.data);
        return { id: `ledger-${ledger.length}` };
      },
    },
  };

  return {
    tx: tx as unknown as PointsWalletTx,
    calls,
    ledger,
  };
}

const wallet = new PointsWalletService();

describe('PointsWalletService — a credit', () => {
  it('increments the row with no balance clause and records the balance read back after the write', async () => {
    const world = makeTx({ row: { points: 10 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: 25,
      source: PointsLedgerSource.QUEST_REWARD,
      referenceKey: 'completion-1',
      details: { questId: 'q1' },
    });

    assert.deepEqual(result, { applied: true, delta: 25, balanceAfter: 35, shortfall: 0, entryId: 'ledger-1' });
    assert.deepEqual(
      world.calls.map((call) => call.op),
      ['pointsLedgerEntry.findUnique', 'user.updateMany', 'user.findUnique', 'pointsLedgerEntry.create'],
      'the key is checked, the row is written, THEN the balance is read, then the row is journaled',
    );
    const write = world.calls[1]!.args as { where: Record<string, unknown>; data: unknown };
    assert.deepEqual(write.where, { id: 'u1' }, 'a credit asks the row for nothing');
    assert.deepEqual(write.data, { points: { increment: 25 } });
    assert.deepEqual(world.ledger, [
      {
        userId: 'u1',
        delta: 25,
        balanceAfter: 35,
        source: 'QUEST_REWARD',
        referenceKey: 'completion-1',
        details: { questId: 'q1' },
      },
    ]);
  });

  it('honours an expected balance inside the same conditional write', async () => {
    const world = makeTx({ row: { points: 7 } });

    const refused = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: 100,
      source: PointsLedgerSource.IMPORT,
      referenceKey: 'stealthnet-balance:u1',
      expectedBalance: 0,
    });

    assert.deepEqual(refused, { applied: false, reason: 'PRECONDITION_FAILED' });
    assert.equal(world.ledger.length, 0, 'a refused movement writes no row');
    const write = world.calls.find((call) => call.op === 'user.updateMany')!.args as { where: Record<string, unknown> };
    assert.deepEqual(write.where, { id: 'u1', points: 0 }, 'the precondition travels WITH the write');

    const fresh = makeTx({ row: { points: 0 } });
    const applied = await wallet.apply(fresh.tx, {
      userId: 'u1',
      delta: 100,
      source: PointsLedgerSource.IMPORT,
      referenceKey: 'stealthnet-balance:u1',
      expectedBalance: 0,
    });
    assert.equal(applied.applied, true);
    assert.equal(fresh.ledger[0]!['balanceAfter'], 100);
  });

  it('tells a missing user apart from a refused precondition', async () => {
    const world = makeTx({ row: null });

    const result = await wallet.apply(world.tx, {
      userId: 'ghost',
      delta: 5,
      source: PointsLedgerSource.QUEST_REWARD,
      referenceKey: 'c-ghost',
    });

    assert.deepEqual(result, { applied: false, reason: 'USER_NOT_FOUND' });
  });
});

describe('PointsWalletService — a debit that must be covered', () => {
  it('carries the floor in the where of the write and lands exactly on zero', async () => {
    const world = makeTx({ row: { points: 200 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -200,
      source: PointsLedgerSource.EXCHANGE,
      referenceKey: 'exchange-1',
    });

    assert.deepEqual(result, { applied: true, delta: -200, balanceAfter: 0, shortfall: 0, entryId: 'ledger-1' });
    const write = world.calls.find((call) => call.op === 'user.updateMany')!.args as { where: Record<string, unknown>; data: unknown };
    assert.deepEqual(write.where, { id: 'u1', points: { gte: 200 } }, 'gte, not gt: the whole balance may be taken');
    assert.deepEqual(write.data, { points: { decrement: 200 } });
  });

  it('refuses one point more than the row holds, and writes nothing', async () => {
    const world = makeTx({ row: { points: 200 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -201,
      source: PointsLedgerSource.EXCHANGE,
      referenceKey: 'exchange-2',
    });

    assert.deepEqual(result, { applied: false, reason: 'INSUFFICIENT_BALANCE' });
    assert.equal(world.ledger.length, 0);
    assert.equal(
      world.calls.filter((call) => call.op === 'user.updateMany').length,
      1,
      'one conditional statement, not a read-then-check',
    );
  });

  it('reports a missing user rather than an insufficient balance', async () => {
    const world = makeTx({ row: null });

    const result = await wallet.apply(world.tx, {
      userId: 'ghost',
      delta: -1,
      source: PointsLedgerSource.EXCHANGE,
      referenceKey: 'exchange-3',
    });

    assert.deepEqual(result, { applied: false, reason: 'USER_NOT_FOUND' });
  });
});

describe('PointsWalletService — a floored debit', () => {
  it('takes the full amount in one statement when the row covers it', async () => {
    const world = makeTx({ row: { points: 50 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -20,
      source: PointsLedgerSource.CASHBACK_REVERSED,
      referenceKey: 'tx-1',
      shortfall: 'floor',
    });

    assert.deepEqual(result, { applied: true, delta: -20, balanceAfter: 30, shortfall: 0, entryId: 'ledger-1' });
    assert.equal(world.calls.filter((call) => call.op === 'user.updateMany').length, 1);
    assert.equal('details' in world.ledger[0]!, false, 'no shortfall, no shortfall details: the column is left NULL');
  });

  it('takes what there is, stops at zero, and records requested / applied / shortfall', async () => {
    const world = makeTx({ row: { points: 13 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -40,
      source: PointsLedgerSource.REFERRAL_REWARD_REVOKED,
      referenceKey: 'reward-1',
      shortfall: 'floor',
      details: { rewardId: 'reward-1' },
    });

    assert.deepEqual(result, { applied: true, delta: -13, balanceAfter: 0, shortfall: 27, entryId: 'ledger-1' });
    assert.deepEqual(world.ledger[0], {
      userId: 'u1',
      delta: -13,
      balanceAfter: 0,
      source: 'REFERRAL_REWARD_REVOKED',
      referenceKey: 'reward-1',
      details: { rewardId: 'reward-1', requested: 40, applied: 13, shortfall: 27 },
    });
    const emptying = world.calls.filter((call) => call.op === 'user.updateMany')[1]!.args as { where: Record<string, unknown> };
    assert.deepEqual(
      emptying.where,
      { id: 'u1', points: 13 },
      'the emptying write is conditioned on the exact balance it read, so a concurrent movement makes it miss',
    );
  });

  it('records a zero movement when there is nothing to take, so the key is consumed', async () => {
    const world = makeTx({ row: { points: 0 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -40,
      source: PointsLedgerSource.CASHBACK_REVERSED,
      referenceKey: 'tx-2',
      shortfall: 'floor',
    });

    assert.deepEqual(result, { applied: true, delta: 0, balanceAfter: 0, shortfall: 40, entryId: 'ledger-1' });
    assert.equal(world.ledger[0]!['delta'], 0);
    assert.deepEqual(world.ledger[0]!['details'], { requested: 40, applied: 0, shortfall: 40 });
  });

  it('does not dig into a balance that is already negative', async () => {
    const world = makeTx({ row: { points: -5 } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -10,
      source: PointsLedgerSource.CASHBACK_REVERSED,
      referenceKey: 'tx-3',
      shortfall: 'floor',
    });

    assert.equal(result.applied, true);
    assert.equal((result as { delta: number }).delta, 0);
    assert.equal((result as { balanceAfter: number }).balanceAfter, -5, 'the balance is left where it was');
  });

  it('retries with the fresh balance when the row moved between the read and the emptying write', async () => {
    // Somebody credits 100 right after the wallet read 13: the emptying write
    // conditioned on exactly 13 misses (count 0, the way Postgres answers a
    // predicate that no longer matches), the retry finds 113 and the full
    // debit lands in one statement. Staged by moving the row at the moment
    // the exact-balance statement executes — a model of another session's
    // commit landing first, not of locking.
    const row = { points: 13 };
    const fresh = makeTx({ row });
    let missed = false;
    const freshUpdateMany = (fresh.tx.user as { updateMany: (args: unknown) => Promise<{ count: number }> }).updateMany;
    (fresh.tx.user as { updateMany: (args: unknown) => Promise<{ count: number }> }).updateMany = async (args: unknown) => {
      const where = (args as { where: { points?: unknown } }).where;
      if (!missed && typeof where.points === 'number') {
        missed = true;
        fresh.calls.push({ op: 'user.updateMany', args });
        row.points += 100;
        return { count: 0 };
      }
      return freshUpdateMany(args);
    };

    const result = await wallet.apply(fresh.tx, {
      userId: 'u1',
      delta: -40,
      source: PointsLedgerSource.CASHBACK_REVERSED,
      referenceKey: 'tx-4',
      shortfall: 'floor',
    });

    assert.deepEqual(result, { applied: true, delta: -40, balanceAfter: 73, shortfall: 0, entryId: 'ledger-1' });
    assert.equal(
      fresh.calls.filter((call) => call.op === 'user.updateMany').length,
      3,
      'full debit (miss), exact-balance emptying (miss), full debit again (hit)',
    );
  });
});

describe('PointsWalletService — the idempotency key', () => {
  it('reports a duplicate before touching the balance', async () => {
    const world = makeTx({
      row: { points: 10 },
      ledger: [{ source: 'CASHBACK', referenceKey: 'tx-9' }],
    });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: 13,
      source: PointsLedgerSource.CASHBACK,
      referenceKey: 'tx-9',
    });

    assert.deepEqual(result, { applied: false, reason: 'DUPLICATE' });
    assert.deepEqual(
      world.calls.map((call) => call.op),
      ['pointsLedgerEntry.findUnique'],
      'nothing else ran',
    );
  });

  it('does not look for a duplicate when the movement carries no key', async () => {
    const world = makeTx({ row: { points: 10 } });

    await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -3,
      source: PointsLedgerSource.MANUAL_ADJUSTMENT,
      referenceKey: null,
    });

    assert.equal(world.calls.some((call) => call.op === 'pointsLedgerEntry.findUnique'), false);
    assert.equal(world.ledger[0]!['referenceKey'], null);
  });
});

describe('PointsWalletService — refusals that are bugs in the caller', () => {
  it('throws on a zero or fractional movement instead of writing a row that moves nothing', async () => {
    const world = makeTx({ row: { points: 10 } });

    for (const delta of [0, 1.5, Number.NaN]) {
      await assert.rejects(
        () =>
          wallet.apply(world.tx, {
            userId: 'u1',
            delta,
            source: PointsLedgerSource.MANUAL_ADJUSTMENT,
            referenceKey: null,
          }),
        /non-zero integer/,
      );
    }
    assert.equal(world.calls.length, 0);
  });
});
