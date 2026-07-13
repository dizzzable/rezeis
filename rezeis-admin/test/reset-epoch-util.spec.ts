import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { ensureLiveResetEpoch } from '../src/modules/add-on-entitlements/services/reset-epoch.util';

type EpochRow = { id: string; startsAt: Date; plannedEndsAt: Date };

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['term_id', 'planned_ends_at'] },
  });
}

/**
 * Minimal `subscriptionResetEpoch` tx double + savepoint SQL recorder.
 * `findUnique` results are served from a queue (the fast-path window read and
 * the post-rollback re-read). `create` records the insert and either throws a
 * P2002 (simulating a concurrent-writer conflict) or returns a fresh row.
 * `$executeRawUnsafe` records SAVEPOINT / RELEASE / ROLLBACK TO calls.
 */
function mockTx(opts: {
  findUniqueQueue?: Array<EpochRow | null>;
  lastOrdinal?: number | null;
  createThrows?: boolean;
}) {
  const findUniqueQueue = [...(opts.findUniqueQueue ?? [])];
  const state = {
    creates: [] as Array<{ termId: string; ordinal: number; startsAt: Date; plannedEndsAt: Date }>,
    savepointSql: [] as string[],
  };
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      state.savepointSql.push(sql);
      return 0;
    },
    subscriptionResetEpoch: {
      findUnique: async () => (findUniqueQueue.length > 0 ? findUniqueQueue.shift()! : null),
      findFirst: async () =>
        opts.lastOrdinal === null || opts.lastOrdinal === undefined ? null : { ordinal: opts.lastOrdinal },
      create: async (args: { data: EpochRow & { termId: string; ordinal: number } }) => {
        state.creates.push({
          termId: args.data.termId,
          ordinal: args.data.ordinal,
          startsAt: args.data.startsAt,
          plannedEndsAt: args.data.plannedEndsAt,
        });
        if (opts.createThrows === true) throw uniqueViolation();
        return { id: 'epoch-new', startsAt: args.data.startsAt, plannedEndsAt: args.data.plannedEndsAt };
      },
    },
  };
  return { tx, state };
}

const MONTH_ANCHOR = new Date('2026-01-15T00:00:00.000Z');
const NOW = new Date('2026-03-20T12:00:00.000Z');

describe('ensureLiveResetEpoch', () => {
  it('returns null (legacy fallback) for NO_RESET', async () => {
    const { tx, state } = mockTx({});
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'NO_RESET', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: NOW,
    });
    assert.equal(result, null);
    assert.equal(state.creates.length, 0);
    assert.equal(state.savepointSql.length, 0);
  });

  it('returns null when the capability is not ENABLED', async () => {
    const { tx } = mockTx({});
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'DISABLED', now: NOW,
    });
    assert.equal(result, null);
  });

  it('returns null when the anchor is null (cannot compute a window)', async () => {
    const { tx } = mockTx({});
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: null, capability: 'ENABLED', now: NOW,
    });
    assert.equal(result, null);
  });

  it('returns null for a non-null but invalid (NaN) anchor instead of throwing', async () => {
    const { tx, state } = mockTx({});
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: new Date('not-a-date'), capability: 'ENABLED', now: NOW,
    });
    assert.equal(result, null);
    assert.equal(state.creates.length, 0);
  });

  it('returns null for a NaN reference (`now`) instead of throwing', async () => {
    const { tx, state } = mockTx({});
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: new Date('not-a-date'),
    });
    assert.equal(result, null);
    assert.equal(state.creates.length, 0);
  });

  it('returns the existing epoch for the current window without inserting a new one', async () => {
    const existing: EpochRow = {
      id: 'epoch-existing',
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      plannedEndsAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    const { tx, state } = mockTx({ findUniqueQueue: [existing] });
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: NOW,
    });
    assert.deepEqual(result, existing);
    assert.equal(state.creates.length, 0);
    assert.equal(state.savepointSql.length, 0);
  });

  it('inserts the current-window epoch under a savepoint with ordinal = last+1 when none exists', async () => {
    const { tx, state } = mockTx({ findUniqueQueue: [null], lastOrdinal: 2 });
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: NOW,
    });
    assert.ok(result !== null);
    assert.equal(state.creates.length, 1);
    assert.equal(state.creates[0]!.termId, 't1');
    assert.equal(state.creates[0]!.ordinal, 3);
    // MONTH strategy → calendar-month window containing `now` (March 2026 UTC).
    assert.equal(state.creates[0]!.startsAt.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(state.creates[0]!.plannedEndsAt.toISOString(), '2026-04-01T00:00:00.000Z');
    // Savepoint wraps the insert, then is released on success.
    assert.deepEqual(state.savepointSql, ['SAVEPOINT reset_epoch_mint', 'RELEASE SAVEPOINT reset_epoch_mint']);
  });

  it('uses ordinal 1 for the first epoch (no prior epochs on the term)', async () => {
    const { tx, state } = mockTx({ findUniqueQueue: [null], lastOrdinal: null });
    await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: NOW,
    });
    assert.equal(state.creates[0]!.ordinal, 1);
  });

  it('rolls back to the savepoint and returns the winner when a concurrent same-window insert conflicts', async () => {
    const winner: EpochRow = {
      id: 'epoch-winner',
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      plannedEndsAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    // Pre-read misses; the insert raises P2002; the post-rollback re-read finds
    // the committed winner (another tx got there first).
    const { tx, state } = mockTx({ findUniqueQueue: [null, winner], lastOrdinal: 0, createThrows: true });
    const result = await ensureLiveResetEpoch(tx as never, {
      termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: NOW,
    });
    assert.deepEqual(result, winner);
    assert.equal(state.creates.length, 1);
    // Savepoint established, then rolled back (NOT released) after the conflict.
    assert.deepEqual(state.savepointSql, ['SAVEPOINT reset_epoch_mint', 'ROLLBACK TO SAVEPOINT reset_epoch_mint']);
  });

  it('rethrows after rollback when the conflict is on a different window (no winner for our window)', async () => {
    // Pre-read misses; insert raises P2002; post-rollback re-read STILL misses
    // → the collision was on (termId, ordinal) for another window → surface it.
    const { tx, state } = mockTx({ findUniqueQueue: [null, null], lastOrdinal: 0, createThrows: true });
    await assert.rejects(
      () =>
        ensureLiveResetEpoch(tx as never, {
          termId: 't1', strategy: 'MONTH', anchorAt: MONTH_ANCHOR, capability: 'ENABLED', now: NOW,
        }),
      (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    );
    // Savepoint was rolled back so the surrounding tx stays healthy.
    assert.deepEqual(state.savepointSql, ['SAVEPOINT reset_epoch_mint', 'ROLLBACK TO SAVEPOINT reset_epoch_mint']);
  });
});
