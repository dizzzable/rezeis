import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ContestStatus, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { ContestService, type ContestInput } from '../src/modules/contests/services/contest.service';
import { ContestWinnerService } from '../src/modules/contests/services/contest-winner.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import type { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';
import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';
import { PrizePayoutService } from '../src/modules/wheel/services/prize-payout.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';

/**
 * Contests against a real PostgreSQL.
 *
 * The draw is the part worth proving here: one transaction, stamped on
 * ACTIVE, so two sweeps racing for the same contest hand out ONE set of
 * prizes; each place to one person; a manual prize recorded as owed; a key
 * whose pool ran dry recorded as owed rather than as handed over. A fake has
 * neither the unique indexes nor the conditional stamp, and would agree with
 * any of that being wrong.
 *
 * Contests are their own rows and share nothing global, so this file needs no
 * advisory lock — unlike the wheel specs.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `contest-${process.pid}-${Date.now()}`;

let prisma: PrismaService;
let contests: ContestService;
let winners: ContestWinnerService;

const createdUsers: string[] = [];
const createdContests: string[] = [];
const createdPools: string[] = [];

const announced: string[] = [];
const notifications = {
  notifyAdminReply: async (input: { ticketId: string }) => {
    announced.push(input.ticketId);
  },
} as unknown as SupportNotificationsService;

const HOUR = 60 * 60 * 1000;

async function createUser(suffix: string, points = 0): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: suffix, points } });
  createdUsers.push(id);
  return id;
}

function input(overrides: Partial<ContestInput> = {}): ContestInput {
  const now = Date.now();
  return {
    title: { ru: 'Розыгрыш' },
    description: { ru: 'Описание' },
    startAt: new Date(now - HOUR),
    endAt: new Date(now + HOUR),
    audienceFilter: null,
    maxEntries: null,
    prizes: [
      {
        place: 1,
        kind: WheelSectorKind.POINTS,
        title: { ru: '100 баллов' },
        amount: 100,
        promoRewardType: null,
        promoPlanId: null,
        promoPlanIds: [],
        promoLifetime: null,
        keyPoolId: null,
        manualInstructions: null,
      },
    ],
    ...overrides,
  };
}

/** A published contest that is over, ready to draw. */
async function endedContest(overrides: Partial<ContestInput> = {}): Promise<string> {
  const created = await contests.create(input(overrides), 'admin-test');
  createdContests.push(created.id);
  await contests.publish(created.id);
  // Close it by moving the end into the past directly: publish refuses a
  // contest that is already over, which is right, and the clock is not ours.
  await prisma.contest.update({ where: { id: created.id }, data: { endAt: new Date(Date.now() - 1000) } });
  return created.id;
}

async function enter(contestId: string, userId: string): Promise<void> {
  await prisma.contestEntry.create({ data: { contestId, userId } });
}

run('contests on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    const spinWallet = new SpinWalletService();
    contests = new ContestService(
      prisma,
      new PrizePayoutService(spinWallet, new RewardGrantService(new PointsWalletService())),
    );
    winners = new ContestWinnerService(prisma, new SupportTicketsService(prisma), notifications);
  });

  after(async () => {
    if (prisma === undefined) return;
    for (const id of createdContests) {
      await prisma.contest.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdPools) {
      await prisma.wheelKeyPool.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('refuses to publish a contest nobody could win', async () => {
    const created = await contests.create(input({ prizes: [] }), 'admin-test');
    createdContests.push(created.id);

    assert.deepEqual(created.problems, ['Нужен хотя бы один приз']);
    await assert.rejects(() => contests.publish(created.id), /хотя бы один приз/);
    assert.equal((await contests.get(created.id)).status, ContestStatus.DRAFT);
  });

  it('refuses a place that gives nothing', async () => {
    const created = await contests.create(
      input({
        prizes: [
          { ...input().prizes[0]!, place: 1 },
          { ...input().prizes[0]!, place: 2, kind: WheelSectorKind.NOTHING, amount: 0 },
        ],
      }),
      'admin-test',
    );
    createdContests.push(created.id);

    assert.match(created.problems.join(' '), /не повезло/);
  });

  it('refuses to publish a contest that is already over', async () => {
    const created = await contests.create(
      input({ startAt: new Date(Date.now() - 2 * HOUR), endAt: new Date(Date.now() - HOUR) }),
      'admin-test',
    );
    createdContests.push(created.id);

    await assert.rejects(() => contests.publish(created.id), /уже прошёл/);
  });

  it('lets a person in once, and only while it is open', async () => {
    const created = await contests.create(input(), 'admin-test');
    createdContests.push(created.id);
    const userId = await createUser('enter');

    // A draft is not open.
    assert.deepEqual(await contests.enter({ contestId: created.id, userId }), { entered: false, reason: 'NOT_OPEN' });

    await contests.publish(created.id);
    assert.deepEqual(await contests.enter({ contestId: created.id, userId }), { entered: true, reason: null });
    // Again is still "in", not a refusal: the person asked to be in, and they are.
    assert.deepEqual(await contests.enter({ contestId: created.id, userId }), { entered: true, reason: null });
    assert.equal(await prisma.contestEntry.count({ where: { contestId: created.id } }), 1, 'one row, whatever they tap');
  });

  it('refuses a person outside the audience', async () => {
    // Only people with an active subscription — this user has none.
    const created = await contests.create(input({ audienceFilter: { subscription: ['ACTIVE'] } }), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);
    const userId = await createUser('outside');

    assert.deepEqual(await contests.enter({ contestId: created.id, userId }), { entered: false, reason: 'NOT_ELIGIBLE' });
  });

  it('closes at the ceiling', async () => {
    const created = await contests.create(input({ maxEntries: 1 }), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);
    const first = await createUser('cap-1');
    const second = await createUser('cap-2');

    assert.equal((await contests.enter({ contestId: created.id, userId: first })).entered, true);
    assert.deepEqual(await contests.enter({ contestId: created.id, userId: second }), { entered: false, reason: 'FULL' });
  });

  it('will not draw a contest that is still running', async () => {
    const created = await contests.create(input(), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);

    assert.deepEqual(await contests.draw({ contestId: created.id }), { drawn: false, reason: 'NOT_OVER' });
  });

  it('draws once, pays the prize, and refuses to draw again', async () => {
    const contestId = await endedContest();
    const a = await createUser('draw-a');
    const b = await createUser('draw-b');
    await enter(contestId, a);
    await enter(contestId, b);

    const first = await contests.draw({ contestId, random: () => 0 });
    assert.deepEqual(first, { drawn: true, winners: 1, entrants: 2 });

    const contest = await contests.get(contestId);
    assert.equal(contest.status, ContestStatus.DRAWN);
    assert.equal(contest.drawnEntries, 2);
    const rows = await winners.listForContest(contestId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, WheelSpinStatus.SETTLED);
    const paid = await prisma.user.findUnique({ where: { id: rows[0]!.winner.id }, select: { points: true } });
    assert.equal(paid?.points, 100, 'the prize actually arrived');

    const again = await contests.draw({ contestId, random: () => 0 });
    assert.deepEqual(again, { drawn: false, reason: 'ALREADY_DRAWN' });
    assert.equal(await prisma.contestWinner.count({ where: { contestId } }), 1, 'and no second set of winners');
  });

  it('two draws racing hand out one set of prizes', async () => {
    const contestId = await endedContest();
    const a = await createUser('race-a');
    const b = await createUser('race-b');
    await enter(contestId, a);
    await enter(contestId, b);

    const [x, y] = await Promise.all([
      contests.draw({ contestId, random: () => 0 }),
      contests.draw({ contestId, random: () => 0.99 }),
    ]);

    assert.equal([x, y].filter((r) => r.drawn).length, 1, 'exactly one of them drew it');
    assert.equal(await prisma.contestWinner.count({ where: { contestId } }), 1);
    const points = await prisma.pointsLedgerEntry.count({ where: { source: 'CONTEST_PRIZE', userId: { in: [a, b] } } });
    assert.equal(points, 1, 'and the prize was paid once');
  });

  it('gives each place to a different person', async () => {
    const contestId = await endedContest({
      prizes: [1, 2, 3].map((place) => ({ ...input().prizes[0]!, place, amount: place * 10 })),
    });
    const people = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((s) => createUser(`places-${s}`)));
    for (const person of people) await enter(contestId, person);

    const result = await contests.draw({ contestId, random: () => 0.5 });
    assert.deepEqual(result, { drawn: true, winners: 3, entrants: 4 });

    const rows = await winners.listForContest(contestId);
    assert.deepEqual(rows.map((r) => r.place), [1, 2, 3]);
    assert.equal(new Set(rows.map((r) => r.winner.id)).size, 3, 'three different people');
  });

  it('fills only as many places as there are entrants', async () => {
    const contestId = await endedContest({
      prizes: [1, 2, 3].map((place) => ({ ...input().prizes[0]!, place })),
    });
    const only = await createUser('lonely');
    await enter(contestId, only);

    const result = await contests.draw({ contestId, random: () => 0 });

    assert.deepEqual(result, { drawn: true, winners: 1, entrants: 1 });
    assert.equal((await winners.listForContest(contestId))[0]?.place, 1, 'first prize, not third');
  });

  it('records a manual prize as owed and opens the conversation', async () => {
    const contestId = await endedContest({
      prizes: [{ ...input().prizes[0]!, kind: WheelSectorKind.MANUAL, amount: 0, manualInstructions: 'Перевести 1000 ₽' }],
    });
    const userId = await createUser('manual');
    await enter(contestId, userId);

    await contests.draw({ contestId, random: () => 0 });

    const [row] = await winners.listForContest(contestId);
    assert.equal(row?.status, WheelSpinStatus.PENDING);
    assert.equal(row?.instructions, 'Перевести 1000 ₽');

    const opened = await winners.openMissingTickets();
    assert.equal(opened, 1);
    const ticket = await prisma.supportTicket.findFirst({ where: { userId }, select: { subject: true } });
    assert.match(ticket?.subject ?? '', /Розыгрыш/);

    const settled = await winners.issue({ winnerId: row!.id, adminId: 'admin-1', note: 'перевёл' });
    assert.deepEqual(settled, { settled: true, status: WheelSpinStatus.SETTLED });
    assert.equal(announced.length, 1, 'the winner is told');
  });

  it('hands a key out of the pool, and records an empty pool as owed rather than paid', async () => {
    const pool = await prisma.wheelKeyPool.create({
      data: { name: `${prefix}-pool`, keys: { create: [{ value: 'KEY-ONLY-ONE' }] } },
      select: { id: true },
    });
    createdPools.push(pool.id);
    const contestId = await endedContest({
      prizes: [1, 2].map((place) => ({ ...input().prizes[0]!, place, kind: WheelSectorKind.KEY, amount: 0, keyPoolId: pool.id })),
    });
    const a = await createUser('key-a');
    const b = await createUser('key-b');
    await enter(contestId, a);
    await enter(contestId, b);

    await contests.draw({ contestId, random: () => 0 });

    const rows = await winners.listForContest(contestId);
    const statuses = rows.map((r) => r.status).sort();
    assert.deepEqual(statuses, [WheelSpinStatus.PENDING, WheelSpinStatus.SETTLED]);
    const key = await prisma.wheelKey.findFirst({ where: { poolId: pool.id }, select: { claimedWinnerId: true, claimedByUserId: true } });
    assert.notEqual(key?.claimedWinnerId, null, 'the one key is stamped with its winner');
    const owed = rows.find((r) => r.status === WheelSpinStatus.PENDING);
    assert.match(owed?.instructions ?? '', /закончились/);
  });

  it('cancels a live contest and pays nobody', async () => {
    const created = await contests.create(input(), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);
    const userId = await createUser('cancel');
    await contests.enter({ contestId: created.id, userId });

    const cancelled = await contests.cancel(created.id);

    assert.equal(cancelled.status, ContestStatus.CANCELLED);
    assert.equal(cancelled.entries, 1, 'the entry stays for the record');
    await prisma.contest.update({ where: { id: created.id }, data: { endAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(await contests.draw({ contestId: created.id }), { drawn: false, reason: 'NOT_ACTIVE' });
  });

  it('fixes the terms once people can enter', async () => {
    const created = await contests.create(input(), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);

    // Wording may change; prizes may not.
    const edited = await contests.update(created.id, {
      ...input(),
      title: { ru: 'Новое имя' },
      prizes: [{ ...input().prizes[0]!, amount: 999 }],
    });

    assert.deepEqual(edited.title, { ru: 'Новое имя' });
    assert.equal(edited.prizes[0]?.amount, 100, 'the prize people entered for is untouched');
  });
});
