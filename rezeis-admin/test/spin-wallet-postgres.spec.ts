import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, SpinLedgerSource } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';

/**
 * The spin wallet against a real PostgreSQL, where the invariant it exists for
 * can be checked under concurrency rather than modelled: for every user,
 * SUM(spin_ledger.delta) = users.spin_balance.
 *
 * The free spin is the other half, and it is checked here for the reason the
 * unit spec cannot: two requests racing for one free spin only ever have one
 * winner because PostgreSQL evaluates the timestamp predicate against the row
 * it locks. A fake has no locks.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `spin-${process.pid}-${Date.now()}`;
const wallet = new SpinWalletService();
let prisma: PrismaService;

const TX_OPTIONS = { maxWait: 30_000, timeout: 30_000 } as const;

async function createUser(suffix: string, spinBalance = 0): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({
    data: { id, referralCode: `${prefix}-${suffix}-ref`, name: suffix, spinBalance },
  });
  return id;
}

async function balanceAndLedgerSum(userId: string) {
  const rows = await prisma.$queryRaw<Array<{ balance: number; sum: number; rows: number }>>(Prisma.sql`
    SELECT u."spin_balance" AS balance,
           COALESCE(SUM(l."delta"), 0)::int AS sum,
           COUNT(l."id")::int AS rows
    FROM "users" u
    LEFT JOIN "spin_ledger" l ON l."user_id" = u."id"
    WHERE u."id" = ${userId}
    GROUP BY u."spin_balance"
  `);
  assert.equal(rows.length, 1, `user ${userId} must exist`);
  return rows[0]!;
}

run('SpinWalletService on PostgreSQL', () => {
  const createdUsers: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    for (const id of createdUsers) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('keeps the journal summing to the balance across a sequence of movements', async () => {
    const userId = await createUser('seq');
    createdUsers.push(userId);

    const movements: Array<[number, SpinLedgerSource, string]> = [
      [5, SpinLedgerSource.WHEEL_PRIZE, 'spin-a'],
      [3, SpinLedgerSource.PURCHASED, 'buy-a'],
      [-1, SpinLedgerSource.SPENT, 'spin-b'],
      [-1, SpinLedgerSource.SPENT, 'spin-c'],
    ];
    let running = 0;
    for (const [delta, source, referenceKey] of movements) {
      const result = await prisma.$transaction(
        (tx) => wallet.apply(tx, { userId, delta, source, referenceKey }),
        TX_OPTIONS,
      );
      assert.equal(result.applied, true, `${source} ${referenceKey}`);
      running += delta;
      assert.equal((result as { balanceAfter: number }).balanceAfter, running);
    }

    assert.deepEqual(await balanceAndLedgerSum(userId), { balance: 6, sum: 6, rows: 4 });
  });

  it('holds the invariant while credits and debits land at the same time', async () => {
    const userId = await createUser('race', 20);
    createdUsers.push(userId);
    // The opening 20 predates the journal here only because this fixture set
    // it directly; journal it so the invariant has something to hold.
    await prisma.spinLedgerEntry.create({
      data: {
        userId,
        delta: 20,
        balanceAfter: 20,
        source: SpinLedgerSource.MANUAL_ADJUSTMENT,
        referenceKey: null,
      },
    });

    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i += 1) {
      work.push(
        prisma.$transaction(
          (tx) => wallet.apply(tx, { userId, delta: 3, source: SpinLedgerSource.WHEEL_PRIZE, referenceKey: `race-win-${i}` }),
          TX_OPTIONS,
        ),
      );
      work.push(
        prisma.$transaction(
          (tx) => wallet.apply(tx, { userId, delta: -1, source: SpinLedgerSource.SPENT, referenceKey: `race-spin-${i}` }),
          TX_OPTIONS,
        ),
      );
    }
    const results = await Promise.all(work);
    assert.ok(results.every((result) => (result as { applied: boolean }).applied));

    const state = await balanceAndLedgerSum(userId);
    assert.equal(state.sum, state.balance, 'the journal sums to the balance');
    assert.equal(state.balance, 20 + 30 - 10);
    assert.equal(state.rows, 21, 'one row per movement, none lost, none doubled');
  });

  it('never lets the balance go below zero, however many spins race for the last one', async () => {
    const userId = await createUser('floor', 3);
    createdUsers.push(userId);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        prisma.$transaction(
          (tx) => wallet.apply(tx, { userId, delta: -1, source: SpinLedgerSource.SPENT, referenceKey: `floor-${index}` }),
          TX_OPTIONS,
        ),
      ),
    );

    const applied = outcomes.filter((outcome) => (outcome as { applied: boolean }).applied);
    assert.equal(applied.length, 3, 'exactly the three spins that existed were spent');
    const state = await balanceAndLedgerSum(userId);
    assert.equal(state.balance, 0);
    assert.equal(state.sum, -3, 'and only the three that happened are on the journal');
  });

  it('gives one free spin to exactly one of two requests racing for it', async () => {
    const userId = await createUser('free', 5);
    createdUsers.push(userId);

    const [first, second] = await Promise.all([
      prisma.$transaction(
        (tx) => wallet.consumeSpin(tx, { userId, spinId: 'free-race-a', freeSpinCooldownHours: 24 }),
        TX_OPTIONS,
      ),
      prisma.$transaction(
        (tx) => wallet.consumeSpin(tx, { userId, spinId: 'free-race-b', freeSpinCooldownHours: 24 }),
        TX_OPTIONS,
      ),
    ]);

    const paidWith = [first, second]
      .map((result) => (result.consumed ? result.paidWith : `refused:${result.reason}`))
      .sort();
    assert.deepEqual(paidWith, ['BALANCE', 'FREE'], 'one took the free spin, the other paid');
    const state = await balanceAndLedgerSum(userId);
    assert.equal(state.balance, 4, 'exactly one spin came off the balance');
    assert.equal(state.sum, state.balance - 5, 'and the journal only holds that one');
  });

  it('does not return the free spin until its cooldown has passed', async () => {
    const userId = await createUser('cooldown', 0);
    createdUsers.push(userId);

    const first = await prisma.$transaction(
      (tx) => wallet.consumeSpin(tx, { userId, spinId: 'cd-a', freeSpinCooldownHours: 24 }),
      TX_OPTIONS,
    );
    assert.equal(first.consumed && first.paidWith, 'FREE');

    // Immediately after: no free spin, no balance, so no spin at all.
    const second = await prisma.$transaction(
      (tx) => wallet.consumeSpin(tx, { userId, spinId: 'cd-b', freeSpinCooldownHours: 24 }),
      TX_OPTIONS,
    );
    assert.deepEqual(second, { consumed: false, reason: 'NO_SPINS' });

    // A day later it is back, and it is ONE — staying away does not stack it.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const third = await prisma.$transaction(
      (tx) => wallet.consumeSpin(tx, { userId, spinId: 'cd-c', freeSpinCooldownHours: 24, now: tomorrow }),
      TX_OPTIONS,
    );
    assert.equal(third.consumed && third.paidWith, 'FREE');
    const fourth = await prisma.$transaction(
      (tx) => wallet.consumeSpin(tx, { userId, spinId: 'cd-d', freeSpinCooldownHours: 24, now: tomorrow }),
      TX_OPTIONS,
    );
    assert.deepEqual(fourth, { consumed: false, reason: 'NO_SPINS' });
    assert.deepEqual(await balanceAndLedgerSum(userId), { balance: 0, sum: 0, rows: 0 });
  });

  it('charges a replayed spin once, whichever way the replay arrives', async () => {
    const userId = await createUser('replay', 4);
    createdUsers.push(userId);

    const outcomes = await Promise.allSettled([
      prisma.$transaction(
        (tx) => wallet.consumeSpin(tx, { userId, spinId: 'same-spin', freeSpinCooldownHours: null }),
        TX_OPTIONS,
      ),
      prisma.$transaction(
        (tx) => wallet.consumeSpin(tx, { userId, spinId: 'same-spin', freeSpinCooldownHours: null }),
        TX_OPTIONS,
      ),
    ]);

    const consumed = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.consumed,
    );
    assert.equal(consumed.length, 1, 'exactly one of the two took a spin');
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // The loser of a true race hits the unique index after passing the
        // pre-check; its whole transaction rolls back, spin included.
        assert.ok(
          outcome.reason instanceof Prisma.PrismaClientKnownRequestError && outcome.reason.code === 'P2002',
          `the loser fails on the key, not on anything else: ${String(outcome.reason)}`,
        );
      }
    }
    assert.deepEqual(await balanceAndLedgerSum(userId), { balance: 3, sum: -1, rows: 1 });

    const later = await prisma.$transaction(
      (tx) => wallet.consumeSpin(tx, { userId, spinId: 'same-spin', freeSpinCooldownHours: null }),
      TX_OPTIONS,
    );
    assert.deepEqual(later, { consumed: false, reason: 'DUPLICATE' }, 'a later replay is told, not charged');
  });
});
