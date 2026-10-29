import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ContestNoticeKind,
  ContestStatus,
  Currency,
  PaymentGatewayType,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
  WheelSectorKind,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { hashDrawSeed } from '../src/modules/contests/contest-draw.util';
import { InternalContestsController } from '../src/modules/contests/controllers/internal-contests.controller';
import { ContestService, type ContestInput } from '../src/modules/contests/services/contest.service';
import { ContestNoticeService } from '../src/modules/contests/services/contest-notice.service';
import { ContestWinnerService } from '../src/modules/contests/services/contest-winner.service';
import type { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import type { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
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

/** What the draw handed to the sync queue: the subscriptions it changed. */
const synced: string[] = [];
const syncQueue = {
  enqueueSubscriptionSync: async (subscriptionId: string) => {
    synced.push(subscriptionId);
  },
} as unknown as ProfileSyncQueueService;

/** Every user notification the notice sweep sent. */
const sent: Array<{ userId: string; type: string; payload: Record<string, unknown> }> = [];
const userNotifications = {
  create: async (input: { userId: string; type: string; payload: Record<string, unknown> }) => {
    sent.push(input);
    return 'event';
  },
} as unknown as UserNotificationsService;

const HOUR = 60 * 60 * 1000;

let telegramSeq = 0;

async function createUser(suffix: string, points = 0, withTelegram = false): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({
    data: {
      id,
      referralCode: `${id}-ref`,
      name: suffix,
      points,
      ...(withTelegram ? { telegramId: BigInt(9_100_000_000 + process.pid * 100 + (telegramSeq += 1)) } : {}),
    },
  });
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
    announce: false,
    ticketsPerPurchase: 0,
    ticketsPerReferral: 0,
    maxTicketsPerUser: null,
    channel: null,
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
      syncQueue,
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
    assert.deepEqual(first, { drawn: true, winners: 1, entrants: 2, tickets: 2 });

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
    assert.deepEqual(result, { drawn: true, winners: 3, entrants: 4, tickets: 4 });

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

    assert.deepEqual(result, { drawn: true, winners: 1, entrants: 1, tickets: 1 });
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

  it('makes the draw key at publish and shows only its hash until the draw', async () => {
    const created = await contests.create(input(), 'admin-test');
    createdContests.push(created.id);
    assert.equal(created.drawSeedHash, null, 'a draft has no key yet');

    const live = await contests.publish(created.id);
    assert.match(live.drawSeedHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(live.drawSeed, null, 'not even the operator sees it before the draw');

    await prisma.contest.update({ where: { id: created.id }, data: { endAt: new Date(Date.now() - 1000) } });
    await contests.draw({ contestId: created.id });
    const drawn = await contests.get(created.id);
    assert.equal(hashDrawSeed(drawn.drawSeed ?? ''), live.drawSeedHash, 'the seed shown after is the one promised');
  });

  it('counts a paid purchase in the window as extra tickets — not a refunded one, not one before', async () => {
    const contestId = await endedContest({ ticketsPerPurchase: 3 });
    const a = await createUser('tix-a');
    const b = await createUser('tix-b');
    await enter(contestId, a);
    await enter(contestId, b);
    const { startAt } = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { startAt: true } });
    const inWindow = new Date(startAt.getTime() + 60_000);
    await pay(a, TransactionStatus.COMPLETED, inWindow);
    await pay(b, TransactionStatus.REFUNDED, inWindow);
    await pay(b, TransactionStatus.COMPLETED, new Date(startAt.getTime() - HOUR));

    // a holds 4 of 5 tickets: 0.7 of 5 lands on a's third. With one ticket
    // each, 0.7 of 2 would have been b's.
    const result = await contests.draw({ contestId, random: () => 0.7 });

    assert.deepEqual(result, { drawn: true, winners: 1, entrants: 2, tickets: 5 });
    assert.equal((await winners.listForContest(contestId))[0]?.winner.id, a);
    const entries = await prisma.contestEntry.findMany({ where: { contestId }, select: { userId: true, tickets: true } });
    assert.deepEqual(Object.fromEntries(entries.map((entry) => [entry.userId, entry.tickets])), { [a]: 4, [b]: 1 });
  });

  it('counts a friend who paid in the window, up to the ceiling', async () => {
    const contestId = await endedContest({ ticketsPerReferral: 5, maxTicketsPerUser: 3 });
    const host = await createUser('ref-host');
    const friend = await createUser('ref-friend');
    await enter(contestId, host);
    const { startAt } = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { startAt: true } });
    await prisma.referral.create({
      data: { referrerId: host, referredId: friend, level: 1, qualifiedAt: new Date(startAt.getTime() + 60_000) },
    });

    const result = await contests.draw({ contestId, random: () => 0 });

    assert.equal(result.drawn && result.tickets, 3, 'one for entering and five for the friend, held at three');
  });

  it('asks for the channel: no Telegram, not a member, or an old cabinet is refused; an unanswerable Telegram is not', async () => {
    const created = await contests.create(
      input({ channel: { chatId: '@contest_news', joinUrl: 'https://t.me/contest_news' } }),
      'admin-test',
    );
    createdContests.push(created.id);
    await contests.publish(created.id);
    const webOnly = await createUser('chan-web');
    const stranger = await createUser('chan-stranger', 0, true);
    const oldCabinet = await createUser('chan-old', 0, true);
    const member = await createUser('chan-member', 0, true);
    const unknown = await createUser('chan-unknown', 0, true);
    const contestId = created.id;

    assert.deepEqual(await contests.enter({ contestId, userId: webOnly, channelMember: true }), {
      entered: false,
      reason: 'NEEDS_TELEGRAM',
    });
    assert.deepEqual(await contests.enter({ contestId, userId: stranger, channelMember: false }), {
      entered: false,
      reason: 'CHANNEL_REQUIRED',
    });
    assert.deepEqual(
      await contests.enter({ contestId, userId: oldCabinet }),
      { entered: false, reason: 'CHANNEL_REQUIRED' },
      'a cabinet that does not ask Telegram does not get the condition waived',
    );
    assert.deepEqual(await contests.enter({ contestId, userId: member, channelMember: true }), {
      entered: true,
      reason: null,
    });
    assert.deepEqual(await contests.enter({ contestId, userId: unknown, channelMember: null }), {
      entered: true,
      reason: null,
    });
  });

  it('hands the cabinet the channel to ask Telegram about', async () => {
    const created = await contests.create(
      input({ channel: { chatId: '-1001234567890', joinUrl: 'https://t.me/+invite_code' } }),
      'admin-test',
    );
    createdContests.push(created.id);
    await contests.publish(created.id);
    const person = await createCabinetUser('chan-ask', true);
    const controller = new InternalContestsController(prisma, contests);

    const first = await controller.enter(person, created.id, {});
    const telegramId = (await prisma.user.findUniqueOrThrow({ where: { id: person }, select: { telegramId: true } }))
      .telegramId;
    assert.deepEqual(first, {
      entered: false,
      reason: 'CHANNEL_REQUIRED',
      channel: { chatId: '-1001234567890', joinUrl: 'https://t.me/+invite_code', telegramId: String(telegramId) },
    });
    const second = await controller.enter(person, created.id, { channelMember: true });
    assert.deepEqual(second, { entered: true, reason: null });
  });

  it('moves the end of a live contest later, never earlier', async () => {
    const created = await contests.create(input(), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);
    const current = await contests.get(created.id);
    const later = new Date(new Date(current.endAt).getTime() + 2 * HOUR);

    const moved = await contests.update(created.id, { ...input(), endAt: later });
    assert.equal(moved.endAt, later.toISOString());

    await assert.rejects(
      () => contests.update(created.id, { ...input(), endAt: new Date(later.getTime() - HOUR) }),
      /более позднее/,
    );
  });

  it('pushes a won «+дни» to Remnawave once the draw has committed', async () => {
    const contestId = await endedContest({
      prizes: [{ ...input().prizes[0]!, kind: WheelSectorKind.DAYS, amount: 7, title: { ru: '7 дней' } }],
    });
    const userId = await createUser('days');
    const subscription = await prisma.subscription.create({
      data: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: new Date(Date.now() + 5 * 24 * HOUR) },
      select: { id: true },
    });
    await enter(contestId, userId);
    synced.length = 0;

    await contests.draw({ contestId, random: () => 0 });

    assert.deepEqual(synced, [subscription.id], 'Remnawave hears of the new expiry, not just the panel');
  });

  it('records why a draw failed, says so once, and clears it when a draw goes through', async () => {
    const failing = new ContestService(prisma, {
      payOut: async () => {
        throw new Error('Ключи кончились');
      },
    } as unknown as PrizePayoutService);
    const contestId = await endedContest();
    const userId = await createUser('fail');
    await enter(contestId, userId);

    await assert.rejects(() => failing.draw({ contestId, random: () => 0 }), /Ключи кончились/);
    assert.equal(await failing.recordDrawFailure(contestId, new Error('Ключи кончились')), true, 'news the first time');
    assert.equal(await failing.recordDrawFailure(contestId, new Error('Ключи кончились')), false, 'not the second');

    const stuck = await contests.get(contestId);
    assert.equal(stuck.status, ContestStatus.ACTIVE, 'the failed draw rolled back whole');
    assert.equal(stuck.drawError, 'Ключи кончились');
    assert.equal(await prisma.contestWinner.count({ where: { contestId } }), 0);

    await contests.draw({ contestId, random: () => 0 });
    assert.equal((await contests.get(contestId)).drawError, null);
  });

  it('tells every entrant how they did, once', async () => {
    const contestId = await endedContest({ title: { ru: 'Итоговый', en: 'Final' } });
    const a = await createUser('note-a');
    const b = await createUser('note-b');
    await enter(contestId, a);
    await enter(contestId, b);
    await contests.draw({ contestId, random: () => 0 });
    const notices = new ContestNoticeService(prisma, userNotifications);
    sent.length = 0;

    for (let round = 0; round < 20 && !(await resultsTold(contestId)); round += 1) await notices.sendDue();

    const mine = sent.filter((entry) => entry.payload['contestId'] === contestId);
    assert.deepEqual(mine.map((entry) => entry.type).sort(), ['contest_lost', 'contest_won']);
    const won = mine.find((entry) => entry.type === 'contest_won');
    assert.equal(won?.payload['place'], 1);
    assert.deepEqual(won?.payload['contestPrize'], { ru: '100 баллов' });
    assert.deepEqual(won?.payload['contestTitle'], { ru: 'Итоговый', en: 'Final' });

    sent.length = 0;
    await notices.sendDue();
    assert.equal(sent.filter((entry) => entry.payload['contestId'] === contestId).length, 0, 'nobody is told twice');
    assert.equal(await prisma.contestNotice.count({ where: { contestId, kind: ContestNoticeKind.RESULT } }), 2);
  });

  it('announces a contest to people who may enter and have not, each once', async () => {
    const created = await contests.create(input({ announce: true }), 'admin-test');
    createdContests.push(created.id);
    await contests.publish(created.id);
    const entrant = await createUser('ann-in');
    const reader = await createUser('ann-out');
    await contests.enter({ contestId: created.id, userId: entrant });
    const notices = new ContestNoticeService(prisma, userNotifications);
    sent.length = 0;

    for (let round = 0; round < 200 && !(await announcementDone(created.id)); round += 1) await notices.sendDue();

    const told = sent
      .filter((entry) => entry.type === 'contest_started' && entry.payload['contestId'] === created.id)
      .map((entry) => entry.userId);
    assert.ok(told.includes(reader), 'the audience is told');
    assert.ok(!told.includes(entrant), 'somebody already in is not');
    assert.equal(new Set(told).size, told.length, 'and nobody twice');
  });

  it('shows everybody a finished contest with masked winners — to a cabinet that asks for it', async () => {
    const contestId = await endedContest();
    const winner = await createCabinetUser('pub-winner');
    const outsider = await createCabinetUser('pub-outsider');
    await enter(contestId, winner);
    await contests.draw({ contestId, random: () => 0 });
    const controller = new InternalContestsController(prisma, contests);

    const older = await controller.list(outsider);
    assert.equal(
      older.some((contest) => contest.id === contestId),
      false,
      'an older cabinet draws every finished contest as «how you did» and would say «не повезло»',
    );

    const view = (await controller.list(outsider, 'all')).find((contest) => contest.id === contestId);
    assert.equal(view?.entered, false);
    assert.equal(view?.myResult, null);
    assert.deepEqual(view?.winners?.map((row) => row.name), ['pu***r']);
    assert.match(view?.seed ?? '', /^[0-9a-f]{64}$/);
  });
});

async function pay(userId: string, status: TransactionStatus, createdAt: Date): Promise<void> {
  await prisma.transaction.create({
    data: {
      userId,
      status,
      createdAt,
      purchaseType: PurchaseType.NEW,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.RUB,
      amount: 199,
    },
  });
}

let cabinetSeq = 0;

/** A user whose id the cabinet's reference parser accepts — letters and digits, 20+ long. */
async function createCabinetUser(name: string, withTelegram = false): Promise<string> {
  cabinetSeq += 1;
  const id = `c${process.pid.toString(36)}${Date.now().toString(36)}${cabinetSeq.toString(36)}`.padEnd(24, '0');
  await prisma.user.create({
    data: {
      id,
      referralCode: `${id}-ref`,
      name,
      ...(withTelegram ? { telegramId: BigInt(9_200_000_000 + process.pid * 100 + cabinetSeq) } : {}),
    },
  });
  createdUsers.push(id);
  return id;
}

async function resultsTold(contestId: string): Promise<boolean> {
  const row = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { resultsNotifiedAt: true } });
  return row.resultsNotifiedAt !== null;
}

async function announcementDone(contestId: string): Promise<boolean> {
  const row = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { announcedAt: true } });
  return row.announcedAt !== null;
}
