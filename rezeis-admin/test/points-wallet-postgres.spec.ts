import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PointsLedgerSource, Prisma } from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

/**
 * The wallet against a real PostgreSQL: the one place the invariant the whole
 * ledger rests on — for every user, SUM(points_ledger.delta) = users.points —
 * can be checked under concurrency rather than modelled.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's fourth job
 * runs it. The migration replay at the end uses `pg` directly because the
 * file is many statements and `DO $$` blocks, which the prepared-statement
 * path of `$executeRawUnsafe` cannot carry.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `pts-${process.pid}-${Date.now()}`;
const wallet = new PointsWalletService();
let prisma: PrismaService;

const TX_OPTIONS = { maxWait: 30_000, timeout: 30_000 } as const;

async function createUser(suffix: string, points = 0): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({ data: { id, referralCode: `${prefix}-${suffix}-ref`, name: suffix, points } });
  return id;
}

async function balanceAndLedgerSum(userId: string): Promise<{ readonly points: number; readonly sum: number; readonly rows: number }> {
  const rows = await prisma.$queryRaw<Array<{ points: number; sum: number; rows: number }>>(Prisma.sql`
    SELECT u."points" AS points,
           COALESCE(SUM(l."delta"), 0)::int AS sum,
           COUNT(l."id")::int AS rows
    FROM "users" u
    LEFT JOIN "points_ledger" l ON l."user_id" = u."id"
    WHERE u."id" = ${userId}
    GROUP BY u."points"
  `);
  assert.equal(rows.length, 1, `user ${userId} must exist`);
  return rows[0]!;
}

function apply(userId: string, input: Omit<Parameters<PointsWalletService['apply']>[1], 'userId'>) {
  return prisma.$transaction((tx) => wallet.apply(tx, { userId, ...input }), TX_OPTIONS);
}

run('PointsWalletService on PostgreSQL', () => {
  const createdUsers: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma !== undefined) {
      for (const id of createdUsers) {
        await prisma.user.delete({ where: { id } }).catch(() => undefined);
      }
      await prisma.$disconnect();
    }
  });

  it('keeps balance_after equal to the running balance across a sequence of movements', async () => {
    const userId = await createUser('seq', 0);
    createdUsers.push(userId);

    const movements: Array<[number, PointsLedgerSource, string | null]> = [
      [100, PointsLedgerSource.CASHBACK, 'tx-a'],
      [-30, PointsLedgerSource.EXCHANGE, 'ex-a'],
      [7, PointsLedgerSource.QUEST_REWARD, 'q-a'],
      [-77, PointsLedgerSource.MANUAL_ADJUSTMENT, null],
    ];
    const expected: number[] = [];
    let running = 0;
    for (const [delta, source, referenceKey] of movements) {
      const result = await apply(userId, { delta, source, referenceKey });
      assert.equal(result.applied, true);
      running += delta;
      expected.push(running);
      assert.equal((result as { balanceAfter: number }).balanceAfter, running);
    }

    const rows = await prisma.pointsLedgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(rows.map((row) => row.balanceAfter), expected);
    assert.deepEqual(await balanceAndLedgerSum(userId), { points: 0, sum: 0, rows: 4 });
  });

  it('holds the invariant under concurrent credits and floored debits', async () => {
    const userId = await createUser('race', 30);
    createdUsers.push(userId);
    // The opening 30 is not in the ledger (the migration writes those rows, and
    // this user postdates it), so journal it the way the migration would.
    await prisma.pointsLedgerEntry.create({
      data: { userId, delta: 30, balanceAfter: 30, source: PointsLedgerSource.OPENING_BALANCE, referenceKey: userId },
    });

    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 12; i += 1) {
      work.push(apply(userId, { delta: 3, source: PointsLedgerSource.CASHBACK, referenceKey: `race-credit-${i}` }));
      work.push(
        apply(userId, {
          delta: -5,
          source: PointsLedgerSource.CASHBACK_REVERSED,
          referenceKey: `race-debit-${i}`,
          shortfall: 'floor',
        }),
      );
    }
    const results = await Promise.all(work);
    assert.ok(results.every((result) => (result as { applied: boolean }).applied), 'every movement was applied');

    const state = await balanceAndLedgerSum(userId);
    assert.equal(state.sum, state.points, 'the ledger sums to the balance');
    assert.ok(state.points >= 0, 'a floored debit never drives the balance negative');
    assert.equal(state.rows, 1 + 24, 'one row per movement, none lost, none doubled');
  });

  it('applies a movement exactly once when two transactions race on the same key', async () => {
    const userId = await createUser('dup', 0);
    createdUsers.push(userId);

    const outcomes = await Promise.allSettled([
      apply(userId, { delta: 13, source: PointsLedgerSource.CASHBACK, referenceKey: 'same-tx' }),
      apply(userId, { delta: 13, source: PointsLedgerSource.CASHBACK, referenceKey: 'same-tx' }),
    ]);

    const applied = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && (outcome.value as { applied: boolean }).applied,
    );
    assert.equal(applied.length, 1, 'exactly one of the two credited');
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // The loser of the race hit the unique index after passing the
        // pre-check; its transaction rolled back including its balance update.
        assert.ok(
          outcome.reason instanceof Prisma.PrismaClientKnownRequestError && outcome.reason.code === 'P2002',
          `the loser fails on the unique key, not on anything else: ${String(outcome.reason)}`,
        );
      }
    }
    assert.deepEqual(await balanceAndLedgerSum(userId), { points: 13, sum: 13, rows: 1 });

    const replay = await apply(userId, { delta: 13, source: PointsLedgerSource.CASHBACK, referenceKey: 'same-tx' });
    assert.deepEqual(replay, { applied: false, reason: 'DUPLICATE' }, 'a later replay is told, not refused by the index');
  });

  it('refuses an uncovered debit without writing, and floors a covered-in-part one', async () => {
    const userId = await createUser('floor', 0);
    createdUsers.push(userId);
    await apply(userId, { delta: 10, source: PointsLedgerSource.CASHBACK, referenceKey: 'floor-credit' });

    const refused = await apply(userId, { delta: -11, source: PointsLedgerSource.EXCHANGE, referenceKey: 'floor-refused' });
    assert.deepEqual(refused, { applied: false, reason: 'INSUFFICIENT_BALANCE' });
    assert.deepEqual(await balanceAndLedgerSum(userId), { points: 10, sum: 10, rows: 1 });

    const floored = await apply(userId, {
      delta: -25,
      source: PointsLedgerSource.CASHBACK_REVERSED,
      referenceKey: 'floor-reversal',
      shortfall: 'floor',
    });
    assert.deepEqual(floored, { applied: true, delta: -10, balanceAfter: 0, shortfall: 15, entryId: (floored as { entryId: string }).entryId });
    const row = await prisma.pointsLedgerEntry.findUniqueOrThrow({
      where: { source_referenceKey: { source: PointsLedgerSource.CASHBACK_REVERSED, referenceKey: 'floor-reversal' } },
    });
    assert.deepEqual(row.details, { requested: 25, applied: 10, shortfall: 15 });
    assert.deepEqual(await balanceAndLedgerSum(userId), { points: 0, sum: 0, rows: 2 });
  });

  it('replays the migration safely: opening rows only for balances no movement has journaled yet', async () => {
    const migrationSql = readFileSync(
      join(process.cwd(), 'prisma', 'migrations', '20260902120000_points_ledger_and_cashback', 'migration.sql'),
      'utf8',
    );
    const untouched = await createUser('opening-a', 42);
    const journaled = await createUser('opening-b', 0);
    createdUsers.push(untouched, journaled);
    await apply(journaled, { delta: 7, source: PointsLedgerSource.CASHBACK, referenceKey: 'opening-b-tx' });

    const pg = new Client({ connectionString: testUrl });
    await pg.connect();
    try {
      await pg.query(migrationSql);
      await pg.query(migrationSql);
    } finally {
      await pg.end();
    }

    const openingRows = await prisma.pointsLedgerEntry.findMany({
      where: { userId: { in: [untouched, journaled] }, source: PointsLedgerSource.OPENING_BALANCE },
    });
    assert.deepEqual(
      openingRows.map((row) => [row.userId, row.delta, row.balanceAfter, row.referenceKey]),
      [[untouched, 42, 42, untouched]],
      'one opening row for the balance nothing had journaled; none for the user whose movement is already on record',
    );
    assert.deepEqual(await balanceAndLedgerSum(untouched), { points: 42, sum: 42, rows: 1 });
    assert.deepEqual(await balanceAndLedgerSum(journaled), { points: 7, sum: 7, rows: 1 });
  });
});
