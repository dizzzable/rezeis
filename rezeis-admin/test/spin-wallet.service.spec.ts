import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SpinLedgerSource } from '@prisma/client';

import {
  isFreeSpinEnabled,
  resolveFreeSpin,
} from '../src/modules/wheel/spin-availability.util';
import {
  SpinWalletService,
  type SpinWalletTx,
} from '../src/modules/wheel/services/spin-wallet.service';

/**
 * One user row and one journal, behaving the way PostgreSQL does for the
 * statements this wallet issues: every clause of an `updateMany` `where` is
 * the filter, `count` is the only answer, and a read after a write in the same
 * transaction sees the write. Calls are recorded in order, because "the
 * balance was read back AFTER it was written" is half of what is asserted.
 */
interface Row {
  spinBalance: number;
  freeSpinUsedAt: Date | null;
}

function makeTx(input: {
  readonly row: Row | null;
  readonly ledger?: Array<{ source: string; referenceKey: string | null }>;
}) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const existing = input.ledger ?? [];

  const tx = {
    user: {
      updateMany: async (args: {
        where: {
          id: string;
          spinBalance?: { gte?: number };
          OR?: Array<{ freeSpinUsedAt: null | { lte: Date } }>;
        };
        data: { spinBalance?: { increment?: number; decrement?: number }; freeSpinUsedAt?: Date };
      }) => {
        calls.push({ op: 'user.updateMany', args });
        if (input.row === null) return { count: 0 };
        const row = input.row;
        if (args.where.spinBalance?.gte !== undefined && row.spinBalance < args.where.spinBalance.gte) {
          return { count: 0 };
        }
        if (args.where.OR !== undefined) {
          const matches = args.where.OR.some((clause) =>
            clause.freeSpinUsedAt === null
              ? row.freeSpinUsedAt === null
              : row.freeSpinUsedAt !== null && row.freeSpinUsedAt.getTime() <= clause.freeSpinUsedAt.lte.getTime(),
          );
          if (!matches) return { count: 0 };
        }
        if (args.data.freeSpinUsedAt !== undefined) row.freeSpinUsedAt = args.data.freeSpinUsedAt;
        row.spinBalance +=
          (args.data.spinBalance?.increment ?? 0) - (args.data.spinBalance?.decrement ?? 0);
        return { count: 1 };
      },
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        calls.push({ op: 'user.findUnique', args });
        if (input.row === null) return null;
        return args.select?.['spinBalance'] ? { spinBalance: input.row.spinBalance } : { id: args.where.id };
      },
    },
    spinLedgerEntry: {
      findUnique: async (args: {
        where: { source_referenceKey: { source: string; referenceKey: string } };
      }) => {
        calls.push({ op: 'spinLedgerEntry.findUnique', args });
        const key = args.where.source_referenceKey;
        return existing.some((row) => row.source === key.source && row.referenceKey === key.referenceKey)
          ? { id: 'existing' }
          : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ op: 'spinLedgerEntry.create', args });
        ledger.push(args.data);
        return { id: `spin-ledger-${ledger.length}` };
      },
    },
  };

  return { tx: tx as unknown as SpinWalletTx, calls, ledger, row: input.row };
}

const wallet = new SpinWalletService();
const NOW = new Date('2026-09-02T12:00:00.000Z');

describe('resolveFreeSpin — the clock, not a counter', () => {
  it('is available when it has never been used', () => {
    assert.deepEqual(resolveFreeSpin({ freeSpinUsedAt: null, cooldownHours: 24, now: NOW }), {
      available: true,
      availableAt: null,
    });
  });

  it('is one spin however long somebody stays away', () => {
    // THE RULE THIS FILE EXISTS FOR. A week without spinning is still one
    // spin, not seven: the clock runs from the last spin, so not spinning
    // never starts it.
    const aWeekAgo = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const state = resolveFreeSpin({ freeSpinUsedAt: aWeekAgo, cooldownHours: 24, now: NOW });
    assert.deepEqual(state, { available: true, availableAt: null });
    // And there is nowhere for a second one to have accumulated: the answer is
    // a boolean, not a number.
    assert.equal('count' in state, false);
  });

  it('names the moment it comes back while the cooldown runs', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    assert.deepEqual(resolveFreeSpin({ freeSpinUsedAt: twoHoursAgo, cooldownHours: 24, now: NOW }), {
      available: false,
      availableAt: '2026-09-03T10:00:00.000Z',
    });
  });

  it('treats zero, null and nonsense as "the operator turned free spins off"', () => {
    // Zero deliberately: read as a cooldown it would mean a free spin on every
    // request, which is an unlimited wheel one keystroke away.
    for (const cooldownHours of [0, null, undefined, -3, 1.5, Number.NaN]) {
      assert.equal(isFreeSpinEnabled(cooldownHours), false, String(cooldownHours));
      assert.deepEqual(
        resolveFreeSpin({ freeSpinUsedAt: null, cooldownHours, now: NOW }),
        { available: false, availableAt: null },
        String(cooldownHours),
      );
    }
  });
});

describe('SpinWalletService.apply', () => {
  it('credits, then reads the balance back AFTER the write, and journals it', async () => {
    const world = makeTx({ row: { spinBalance: 3, freeSpinUsedAt: null } });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: 5,
      source: SpinLedgerSource.WHEEL_PRIZE,
      referenceKey: 'spin-1',
      details: { segmentId: 'seg-spins' },
    });

    assert.deepEqual(result, { applied: true, delta: 5, balanceAfter: 8, entryId: 'spin-ledger-1' });
    assert.deepEqual(
      world.calls.map((call) => call.op),
      ['spinLedgerEntry.findUnique', 'user.updateMany', 'user.findUnique', 'spinLedgerEntry.create'],
      'the key is checked, the row is written, THEN the balance is read',
    );
    assert.deepEqual(world.ledger, [
      {
        userId: 'u1',
        delta: 5,
        balanceAfter: 8,
        source: 'WHEEL_PRIZE',
        referenceKey: 'spin-1',
        details: { segmentId: 'seg-spins' },
      },
    ]);
  });

  it('carries the floor in the where of the debit and refuses one spin too many', async () => {
    const world = makeTx({ row: { spinBalance: 1, freeSpinUsedAt: null } });

    const ok = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -1,
      source: SpinLedgerSource.SPENT,
      referenceKey: 'spin-a',
    });
    assert.equal(ok.applied, true);
    const write = world.calls.find((call) => call.op === 'user.updateMany')!.args as {
      where: Record<string, unknown>;
    };
    assert.deepEqual(write.where, { id: 'u1', spinBalance: { gte: 1 } });

    const refused = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: -1,
      source: SpinLedgerSource.SPENT,
      referenceKey: 'spin-b',
    });
    assert.deepEqual(refused, { applied: false, reason: 'INSUFFICIENT_BALANCE' });
    assert.equal(world.ledger.length, 1, 'a refused movement writes no row');
  });

  it('tells a missing account apart from an empty one', async () => {
    const world = makeTx({ row: null });

    const result = await wallet.apply(world.tx, {
      userId: 'ghost',
      delta: -1,
      source: SpinLedgerSource.SPENT,
      referenceKey: 'spin-x',
    });

    assert.deepEqual(result, { applied: false, reason: 'USER_NOT_FOUND' });
  });

  it('reports a duplicate before touching the balance', async () => {
    const world = makeTx({
      row: { spinBalance: 3, freeSpinUsedAt: null },
      ledger: [{ source: 'WHEEL_PRIZE', referenceKey: 'spin-1' }],
    });

    const result = await wallet.apply(world.tx, {
      userId: 'u1',
      delta: 5,
      source: SpinLedgerSource.WHEEL_PRIZE,
      referenceKey: 'spin-1',
    });

    assert.deepEqual(result, { applied: false, reason: 'DUPLICATE' });
    assert.deepEqual(world.calls.map((call) => call.op), ['spinLedgerEntry.findUnique']);
    assert.equal(world.row!.spinBalance, 3);
  });

  it('throws on a movement that moves nothing, rather than writing a row that says nothing', async () => {
    const world = makeTx({ row: { spinBalance: 3, freeSpinUsedAt: null } });

    for (const delta of [0, 1.5, Number.NaN]) {
      await assert.rejects(
        () =>
          wallet.apply(world.tx, {
            userId: 'u1',
            delta,
            source: SpinLedgerSource.MANUAL_ADJUSTMENT,
            referenceKey: null,
          }),
        /non-zero integer/,
      );
    }
    assert.equal(world.calls.length, 0);
  });
});

describe('SpinWalletService.consumeSpin', () => {
  it('takes the free spin first and leaves the balance and the journal alone', async () => {
    // Free first because the free one cannot be saved: it does not
    // accumulate, so spending the balance while it is due simply loses it.
    const world = makeTx({ row: { spinBalance: 4, freeSpinUsedAt: null } });

    const result = await wallet.consumeSpin(world.tx, {
      userId: 'u1',
      spinId: 'spin-1',
      freeSpinCooldownHours: 24,
      now: NOW,
    });

    assert.deepEqual(result, { consumed: true, paidWith: 'FREE', balanceAfter: 4 });
    assert.equal(world.row!.spinBalance, 4, 'the balance is untouched');
    assert.equal(world.row!.freeSpinUsedAt?.toISOString(), NOW.toISOString(), 'the clock is stamped');
    assert.deepEqual(world.ledger, [], 'the free spin never touched the balance, so it journals nothing');
  });

  it('falls through to the balance once the free spin is spent, and journals that', async () => {
    const world = makeTx({ row: { spinBalance: 4, freeSpinUsedAt: NOW } });

    const result = await wallet.consumeSpin(world.tx, {
      userId: 'u1',
      spinId: 'spin-2',
      freeSpinCooldownHours: 24,
      now: new Date(NOW.getTime() + 60_000),
    });

    assert.deepEqual(result, { consumed: true, paidWith: 'BALANCE', balanceAfter: 3 });
    assert.deepEqual(world.ledger.map((row) => [row['delta'], row['source'], row['referenceKey']]), [
      [-1, 'SPENT', 'spin-2'],
    ]);
  });

  it('claims the free spin exactly once when two spins race for it', async () => {
    // The claim is a conditional write on the timestamp itself, so the loser
    // finds the row already stamped and pays from the balance instead.
    const world = makeTx({ row: { spinBalance: 1, freeSpinUsedAt: null } });

    const first = await wallet.consumeSpin(world.tx, {
      userId: 'u1', spinId: 'spin-a', freeSpinCooldownHours: 24, now: NOW,
    });
    const second = await wallet.consumeSpin(world.tx, {
      userId: 'u1', spinId: 'spin-b', freeSpinCooldownHours: 24, now: NOW,
    });

    assert.equal(first.consumed && first.paidWith, 'FREE');
    assert.equal(second.consumed && second.paidWith, 'BALANCE');
    assert.equal(world.row!.spinBalance, 0);
  });

  it('uses the balance when the operator has turned free spins off', async () => {
    const world = makeTx({ row: { spinBalance: 2, freeSpinUsedAt: null } });

    const result = await wallet.consumeSpin(world.tx, {
      userId: 'u1', spinId: 'spin-3', freeSpinCooldownHours: null, now: NOW,
    });

    assert.equal(result.consumed && result.paidWith, 'BALANCE');
    assert.equal(world.row!.freeSpinUsedAt, null, 'and does not stamp a clock nobody reads');
  });

  it('refuses when there is neither a free spin nor a balance', async () => {
    const world = makeTx({ row: { spinBalance: 0, freeSpinUsedAt: NOW } });

    const result = await wallet.consumeSpin(world.tx, {
      userId: 'u1',
      spinId: 'spin-4',
      freeSpinCooldownHours: 24,
      now: new Date(NOW.getTime() + 60_000),
    });

    assert.deepEqual(result, { consumed: false, reason: 'NO_SPINS' });
    assert.deepEqual(world.ledger, []);
  });

  it('does not charge twice for a replayed spin id', async () => {
    // A dropped connection is retried by the cabinet with the same spin id.
    // The free branch is already spent by then, and the paid branch is refused
    // by the ledger key rather than taking a second spin.
    const world = makeTx({
      row: { spinBalance: 3, freeSpinUsedAt: NOW },
      ledger: [{ source: 'SPENT', referenceKey: 'spin-5' }],
    });

    const result = await wallet.consumeSpin(world.tx, {
      userId: 'u1',
      spinId: 'spin-5',
      freeSpinCooldownHours: 24,
      now: new Date(NOW.getTime() + 60_000),
    });

    assert.deepEqual(result, { consumed: false, reason: 'DUPLICATE' });
    assert.equal(world.row!.spinBalance, 3);
  });
});
