import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { bindResetEpochWindow } from '../src/modules/add-on-entitlements/services/reset-epoch.util';

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
    /** The window key every lookup asked for, so a test can see which window was meant. */
    windowReads: [] as string[],
  };
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      state.savepointSql.push(sql);
      return 0;
    },
    subscriptionResetEpoch: {
      findUnique: async (args: { where: { termId_plannedEndsAt: { termId: string; plannedEndsAt: Date } } }) => {
        const key = args.where.termId_plannedEndsAt;
        state.windowReads.push(`${key.termId}@${key.plannedEndsAt.toISOString()}`);
        return findUniqueQueue.length > 0 ? findUniqueQueue.shift()! : null;
      },
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

/** MONTH: between Remnawave's resets on the 1st at 00:20 (UTC). */
const WINDOW = {
  termId: 't1',
  startsAt: new Date('2026-03-01T00:20:00.000Z'),
  plannedEndsAt: new Date('2026-04-01T00:20:00.000Z'),
} as const;

describe('bindResetEpochWindow', () => {
  it('returns the existing epoch for the window without inserting a new one', async () => {
    const existing: EpochRow = { id: 'epoch-existing', startsAt: WINDOW.startsAt, plannedEndsAt: WINDOW.plannedEndsAt };
    const { tx, state } = mockTx({ findUniqueQueue: [existing] });
    const result = await bindResetEpochWindow(tx as never, WINDOW);
    assert.deepEqual(result, existing);
    assert.deepEqual(state.windowReads, ['t1@2026-04-01T00:20:00.000Z']);
    assert.equal(state.creates.length, 0);
    assert.equal(state.savepointSql.length, 0);
  });

  it('binds exactly the window it is given — Remnawave\'s, computed by the caller (Moscow: 21:20 UTC the day before)', async () => {
    const { tx, state } = mockTx({ findUniqueQueue: [null], lastOrdinal: 0 });
    await bindResetEpochWindow(tx as never, {
      termId: 't1',
      startsAt: new Date('2026-02-28T21:20:00.000Z'),
      plannedEndsAt: new Date('2026-03-31T21:20:00.000Z'),
    });
    assert.equal(state.creates.length, 1);
    assert.equal(state.creates[0]!.startsAt.toISOString(), '2026-02-28T21:20:00.000Z');
    assert.equal(state.creates[0]!.plannedEndsAt.toISOString(), '2026-03-31T21:20:00.000Z');
  });

  it('inserts the window\'s epoch under a savepoint with ordinal = last+1 when none exists', async () => {
    const { tx, state } = mockTx({ findUniqueQueue: [null], lastOrdinal: 2 });
    const result = await bindResetEpochWindow(tx as never, WINDOW);
    assert.equal(result.id, 'epoch-new');
    assert.equal(state.creates.length, 1);
    assert.equal(state.creates[0]!.termId, 't1');
    assert.equal(state.creates[0]!.ordinal, 3);
    assert.equal(state.creates[0]!.startsAt.toISOString(), '2026-03-01T00:20:00.000Z');
    assert.equal(state.creates[0]!.plannedEndsAt.toISOString(), '2026-04-01T00:20:00.000Z');
    // Savepoint wraps the insert, then is released on success.
    assert.deepEqual(state.savepointSql, ['SAVEPOINT reset_epoch_mint', 'RELEASE SAVEPOINT reset_epoch_mint']);
  });

  it('uses ordinal 1 for the first epoch (no prior epochs on the term)', async () => {
    const { tx, state } = mockTx({ findUniqueQueue: [null], lastOrdinal: null });
    await bindResetEpochWindow(tx as never, WINDOW);
    assert.equal(state.creates[0]!.ordinal, 1);
  });

  it('rolls back to the savepoint and returns the winner when a concurrent same-window insert conflicts', async () => {
    const winner: EpochRow = { id: 'epoch-winner', startsAt: WINDOW.startsAt, plannedEndsAt: WINDOW.plannedEndsAt };
    // Pre-read misses; the insert raises P2002; the post-rollback re-read finds
    // the committed winner (another tx got there first).
    const { tx, state } = mockTx({ findUniqueQueue: [null, winner], lastOrdinal: 0, createThrows: true });
    const result = await bindResetEpochWindow(tx as never, WINDOW);
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
      () => bindResetEpochWindow(tx as never, WINDOW),
      (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    );
    // Savepoint was rolled back so the surrounding tx stays healthy.
    assert.deepEqual(state.savepointSql, ['SAVEPOINT reset_epoch_mint', 'ROLLBACK TO SAVEPOINT reset_epoch_mint']);
  });
});
