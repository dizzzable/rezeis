import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ContestKind,
  ContestMetric,
  ContestNoticeKind,
  ContestPrizeDelivery,
  ContestStatus,
  Currency,
  DeviceSignalKind,
  PaymentGatewayType,
  PointsLedgerSource,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
  UserReviewFlagKind,
  WheelSectorKind,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import type { SystemEventsService } from '../src/common/services/system-events.service';
import { InternalContestsController } from '../src/modules/contests/controllers/internal-contests.controller';
import { ContestService, type ContestInput, type ContestPrizeInput } from '../src/modules/contests/services/contest.service';
import { ContestNoticeService } from '../src/modules/contests/services/contest-notice.service';
import { ContestStandingsService } from '../src/modules/contests/services/contest-standings.service';
import { ContestTrafficService } from '../src/modules/contests/services/contest-traffic.service';
import { ContestWinnerService } from '../src/modules/contests/services/contest-winner.service';
import type { FxRateService } from '../src/modules/fx/fx-rate.service';
import type { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import type { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import type { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import type { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';
import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';
import { PrizePayoutService } from '../src/modules/wheel/services/prize-payout.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';

/**
 * Leaderboards, held prizes and monthly repeats against a real PostgreSQL.
 *
 * Every leaderboard here runs in a month of 2001 of its own: the metrics are
 * counted over the whole database, and nothing any other spec — or any other
 * test here — writes lands in that month, so each board holds exactly the
 * people its test made.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `board-${process.pid}-${Date.now()}`;

/** The month the current test's contest runs in; `january()` moves it on. */
let month = -1;
const monthStart = (): Date => new Date(Date.UTC(2001, month, 1));
const monthEnd = (): Date => new Date(Date.UTC(2001, month + 1, 1));
const inJanuary = (day: number, hour = 12): Date => new Date(Date.UTC(2001, month, day, hour));
const HOUR = 60 * 60 * 1000;

let prisma: PrismaService;
let contests: ContestService;
let winners: ContestWinnerService;
let notices: ContestNoticeService;

const createdUsers: string[] = [];
const createdContests: string[] = [];

const synced: string[] = [];
const syncQueue = {
  enqueueSubscriptionSync: async (subscriptionId: string) => {
    synced.push(subscriptionId);
  },
} as unknown as ProfileSyncQueueService;

const sent: Array<{ userId: string; type: string; payload: Record<string, unknown> }> = [];
const userNotifications = {
  create: async (input: { userId: string; type: string; payload: Record<string, unknown> }) => {
    sent.push(input);
    return 'event';
  },
} as unknown as UserNotificationsService;

const supportNotifications = { notifyAdminReply: async () => undefined } as unknown as SupportNotificationsService;

/** Every operator card the contests raised. */
const raised: Array<{ type: string; metadata: Record<string, unknown> }> = [];
const events = {
  info: (type: string, _category: string, _message: string, metadata: Record<string, unknown> = {}) => {
    raised.push({ type, metadata });
  },
} as unknown as SystemEventsService;

/** Roubles are the base; a currency without a rate is left out, as with the real one. */
const fx = {
  getBaseCurrency: () => 'RUB',
  toBaseMinor: async (amount: unknown, currency: string) =>
    currency === 'RUB' ? { amountBaseMinor: Math.round(Number(amount) * 100), rate: 1 } : null,
} as unknown as FxRateService;

let panelUsers: Array<{ uuid: string; panelId: number | null; userTraffic: { lifetimeUsedTrafficBytes: number | null } }> = [];
const remnawave = {
  strictGetAllPanelUsers: async () => ({ kind: 'ok', value: { users: panelUsers }, detectedVersion: null }),
} as unknown as RemnawaveApiService;

let seq = 0;
async function createUser(name: string, extra: { isBlocked?: boolean } = {}): Promise<string> {
  seq += 1;
  // Letters and digits, 20+ long: an id the cabinet's reference parser takes.
  const id = `b${process.pid.toString(36)}${Date.now().toString(36)}${seq.toString(36)}`.padEnd(24, '0');
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name, ...extra } });
  createdUsers.push(id);
  return id;
}

const pointsPrize = (place: number, amount: number, placeTo: number | null = null): ContestPrizeInput => ({
  place,
  placeTo,
  kind: WheelSectorKind.POINTS,
  title: { ru: `${amount} баллов` },
  amount,
  promoRewardType: null,
  promoPlanId: null,
  promoPlanIds: [],
  promoLifetime: null,
  keyPoolId: null,
  manualInstructions: null,
});

function input(overrides: Partial<ContestInput> = {}): ContestInput {
  return {
    title: { ru: 'Топ' },
    description: {},
    startAt: new Date(Date.now() - HOUR),
    endAt: new Date(Date.now() + HOUR),
    audienceFilter: null,
    maxEntries: null,
    announce: false,
    remind: false,
    ticketsPerPurchase: 0,
    ticketsPerReferral: 0,
    maxTicketsPerUser: null,
    channel: null,
    kind: ContestKind.LEADERBOARD,
    metric: ContestMetric.REFERRALS_PAID,
    minScore: null,
    leaderboardSize: 10,
    prizeDelivery: ContestPrizeDelivery.AUTO,
    repeatMonthly: false,
    prizes: [pointsPrize(1, 100)],
    ...overrides,
  };
}

/** A published contest, moved into a month of 2001 of its own — or wherever `explicit` says. */
async function january(overrides: Partial<ContestInput> = {}, explicit?: { startAt: Date; endAt: Date }): Promise<string> {
  month += 1;
  const window = explicit ?? { startAt: monthStart(), endAt: monthEnd() };
  const created = await contests.create(input(overrides), 'admin-test');
  createdContests.push(created.id);
  await contests.publish(created.id);
  await prisma.contest.update({ where: { id: created.id }, data: window });
  return created.id;
}

async function friendWhoPaid(referrerId: string, qualifiedAt: Date): Promise<void> {
  const friend = await createUser('friend');
  await prisma.referral.create({ data: { referrerId, referredId: friend, level: 1, qualifiedAt } });
}

async function earn(userId: string, delta: number, source: PointsLedgerSource, createdAt: Date): Promise<void> {
  seq += 1;
  await prisma.pointsLedgerEntry.create({
    data: { userId, delta, balanceAfter: delta, source, referenceKey: `${prefix}-${seq}`, createdAt },
  });
}

async function pay(
  userId: string,
  amount: number,
  createdAt: Date,
  extra: { status?: TransactionStatus; gatewayType?: PaymentGatewayType; currency?: Currency } = {},
): Promise<void> {
  await prisma.transaction.create({
    data: {
      userId,
      status: extra.status ?? TransactionStatus.COMPLETED,
      createdAt,
      purchaseType: PurchaseType.NEW,
      gatewayType: extra.gatewayType ?? PaymentGatewayType.YOOKASSA,
      currency: extra.currency ?? Currency.RUB,
      amount,
    },
  });
}

async function points(userId: string): Promise<number> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } })).points;
}

run('leaderboards on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    const payout = new PrizePayoutService(new SpinWalletService(), new RewardGrantService(new PointsWalletService()));
    const standings = new ContestStandingsService(prisma, fx);
    contests = new ContestService(prisma, payout, syncQueue, standings, events);
    winners = new ContestWinnerService(
      prisma,
      new SupportTicketsService(prisma),
      supportNotifications,
      payout,
      syncQueue,
      userNotifications,
    );
    notices = new ContestNoticeService(prisma, userNotifications, standings);
  });

  after(async () => {
    if (prisma === undefined) return;
    // Repeats first: a successor points at the contest it repeats.
    for (const id of [...createdContests].reverse()) {
      await prisma.contest.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await prisma.supportTicket.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await prisma.transaction.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('ranks by friends who paid in the window, gives ranges of places, and writes the board down', async () => {
    const contestId = await january({
      prizes: [pointsPrize(1, 100), pointsPrize(2, 50, 3)],
    });
    const ann = await createUser('Анна');
    const boris = await createUser('Борис');
    const vera = await createUser('Вера');
    const gleb = await createUser('Глеб');
    const blocked = await createUser('Блок', { isBlocked: true });
    for (let i = 0; i < 3; i += 1) await friendWhoPaid(ann, inJanuary(5 + i));
    await friendWhoPaid(boris, inJanuary(3));
    await friendWhoPaid(boris, inJanuary(4));
    await friendWhoPaid(vera, inJanuary(2));
    await friendWhoPaid(vera, inJanuary(9));
    await friendWhoPaid(gleb, inJanuary(10));
    await friendWhoPaid(gleb, new Date(monthStart().getTime() - 12 * HOUR)); // before the window
    for (let i = 0; i < 5; i += 1) await friendWhoPaid(blocked, inJanuary(6));

    const result = await contests.draw({ contestId });

    assert.deepEqual(result, { drawn: true, winners: 3, entrants: 4, tickets: null, repeatedBy: null, pending: 0 });
    const board = await prisma.contestEntry.findMany({
      where: { contestId },
      orderBy: { rank: 'asc' },
      select: { userId: true, rank: true, score: true },
    });
    assert.deepEqual(
      board.map((row) => [row.userId, row.rank, Number(row.score)]),
      [
        [ann, 1, 3],
        // Two each: Борис got there on the 4th, Вера on the 9th.
        [boris, 2, 2],
        [vera, 3, 2],
        [gleb, 4, 1],
      ],
      'the blocked account is not on the board, and a friend from before the window does not count',
    );
    const won = await prisma.contestWinner.findMany({
      where: { contestId },
      orderBy: { place: 'asc' },
      select: { userId: true, place: true, score: true, status: true },
    });
    assert.deepEqual(
      won.map((row) => [row.userId, row.place, Number(row.score), row.status]),
      [
        [ann, 1, 3, WheelSpinStatus.SETTLED],
        [boris, 2, 2, WheelSpinStatus.SETTLED],
        [vera, 3, 2, WheelSpinStatus.SETTLED],
      ],
    );
    assert.equal(await points(ann), 100);
    assert.equal(await points(vera), 50, 'places 2–3 share the one prize');
    assert.equal(await points(gleb), 0);
  });

  it('gives no place below the threshold, and leaves places nobody reached empty', async () => {
    const contestId = await january({ minScore: 2, prizes: [pointsPrize(1, 100), pointsPrize(2, 50)] });
    const one = await createUser('one');
    const two = await createUser('two');
    await friendWhoPaid(one, inJanuary(3));
    await friendWhoPaid(one, inJanuary(4));
    await friendWhoPaid(two, inJanuary(3));

    const result = await contests.draw({ contestId });

    assert.equal(result.drawn && result.winners, 1);
    assert.equal(result.drawn && result.entrants, 2, 'both are on the board, one wins');
  });

  it('ranks payments in the base currency — not a refund, not the partner balance, not an unpriced currency', async () => {
    const contestId = await january({ metric: ContestMetric.PAYMENTS_SUM });
    const big = await createUser('big');
    const small = await createUser('small');
    await pay(big, 500, inJanuary(3));
    await pay(big, 250.5, inJanuary(4));
    await pay(small, 300, inJanuary(3));
    await pay(small, 9000, inJanuary(5), { status: TransactionStatus.REFUNDED });
    await pay(small, 9000, inJanuary(6), { gatewayType: PaymentGatewayType.PARTNER_BALANCE });
    await pay(small, 9000, inJanuary(7), { currency: Currency.USD });

    await contests.draw({ contestId });

    const board = await prisma.contestEntry.findMany({
      where: { contestId },
      orderBy: { rank: 'asc' },
      select: { userId: true, score: true },
    });
    assert.deepEqual(
      board.map((row) => [row.userId, Number(row.score)]),
      [
        [big, 75_050],
        [small, 30_000],
      ],
    );
  });

  it('ranks points earned — cashback, quests and their reversals, not a contest prize or an adjustment', async () => {
    const contestId = await january({ metric: ContestMetric.POINTS_EARNED });
    const earner = await createUser('earner');
    const gifted = await createUser('gifted');
    await earn(earner, 40, PointsLedgerSource.CASHBACK, inJanuary(3));
    await earn(earner, -10, PointsLedgerSource.CASHBACK_REVERSED, inJanuary(4));
    await earn(earner, 25, PointsLedgerSource.QUEST_REWARD, inJanuary(5));
    await earn(gifted, 500, PointsLedgerSource.CONTEST_PRIZE, inJanuary(3));
    await earn(gifted, 500, PointsLedgerSource.MANUAL_ADJUSTMENT, inJanuary(3));
    await earn(gifted, 5, PointsLedgerSource.WHEEL_PRIZE, inJanuary(3));

    await contests.draw({ contestId });

    const board = await prisma.contestEntry.findMany({
      where: { contestId },
      orderBy: { rank: 'asc' },
      select: { userId: true, score: true },
    });
    assert.deepEqual(
      board.map((row) => [row.userId, Number(row.score)]),
      [
        [earner, 55],
        [gifted, 5],
      ],
    );
  });

  it('holds prizes for a check: nothing paid and no conversation until «Выдать», which pays once', async () => {
    const contestId = await january({ prizeDelivery: ContestPrizeDelivery.REVIEW });
    const winner = await createUser('held');
    await friendWhoPaid(winner, inJanuary(3));

    await contests.draw({ contestId });
    await winners.openMissingTickets();

    const row = await prisma.contestWinner.findFirstOrThrow({
      where: { contestId },
      select: { id: true, status: true, heldForReview: true, manualTicketId: true },
    });
    assert.equal(row.status, WheelSpinStatus.PENDING);
    assert.equal(row.heldForReview, true);
    assert.equal(row.manualTicketId, null, '«после проверки» is the operator\'s check, not a conversation');
    assert.equal(await points(winner), 0);

    sent.length = 0;
    for (let round = 0; round < 5; round += 1) await notices.sendDue();
    assert.deepEqual(
      sent.filter((entry) => entry.payload['contestId'] === contestId).map((entry) => entry.type),
      ['contest_won_review'],
    );

    sent.length = 0;
    const [first, second] = await Promise.all([
      winners.issue({ winnerId: row.id, adminId: 'admin-test', note: null }),
      winners.issue({ winnerId: row.id, adminId: 'admin-test', note: null }),
    ]);
    assert.deepEqual(
      [first.settled, second.settled].sort(),
      [false, true],
      'two operators pressing «Выдать» at once pay it once',
    );
    assert.equal(await points(winner), 100);
    const after = await prisma.contestWinner.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true, heldForReview: true, settledBy: true },
    });
    assert.deepEqual(after, { status: WheelSpinStatus.SETTLED, heldForReview: false, settledBy: 'admin-test' });
    assert.deepEqual(
      sent.map((entry) => entry.type),
      ['contest_prize_issued'],
    );
  });

  it('holds prizes «через поддержку» with a conversation for each winner, and pays on «Выдать»', async () => {
    const contestId = await january({ prizeDelivery: ContestPrizeDelivery.SUPPORT });
    const winner = await createUser('support');
    await friendWhoPaid(winner, inJanuary(3));

    await contests.draw({ contestId });
    await winners.openMissingTickets();

    const row = await prisma.contestWinner.findFirstOrThrow({
      where: { contestId },
      select: { id: true, heldForReview: true, manualTicketId: true },
    });
    assert.equal(row.heldForReview, true);
    assert.notEqual(row.manualTicketId, null);

    const settled = await winners.issue({ winnerId: row.id, adminId: 'admin-test', note: 'Начислено' });

    assert.deepEqual(settled, { settled: true, status: WheelSpinStatus.SETTLED });
    assert.equal(await points(winner), 100);
    const said = await prisma.supportTicketMessage.findMany({
      where: { ticketId: row.manualTicketId as string, authorType: 'ADMIN' },
      select: { content: true },
    });
    assert.equal(said.length, 1);
    assert.match(said[0]?.content ?? '', /Начислено/);
  });

  it('refuses a held prize with a reason, and pays nothing', async () => {
    const contestId = await january({ prizeDelivery: ContestPrizeDelivery.REVIEW });
    const winner = await createUser('refused');
    await friendWhoPaid(winner, inJanuary(3));
    await contests.draw({ contestId });
    const row = await prisma.contestWinner.findFirstOrThrow({ where: { contestId }, select: { id: true } });

    const refused = await winners.refuse({ winnerId: row.id, adminId: 'admin-test', reason: 'Накрутка рефералов' });

    assert.deepEqual(refused, { settled: true, status: WheelSpinStatus.REFUSED });
    assert.equal(await points(winner), 0);
    const after = await prisma.contestWinner.findUniqueOrThrow({ where: { id: row.id }, select: { manualTicketId: true } });
    const thread = await prisma.supportTicketMessage.findMany({
      where: { ticketId: after.manualTicketId as string },
      orderBy: { createdAt: 'asc' },
      select: { content: true },
    });
    assert.equal(thread.length, 1, 'the refusal and its reason, not «оператор свяжется, чтобы вручить приз» before it');
    assert.match(thread[0]?.content ?? '', /отказать[\s\S]*Накрутка рефералов/);
  });

  it('starts the same contest again for a month, once', async () => {
    const created = await contests.create(
      input({
        kind: ContestKind.DRAW,
        metric: null,
        repeatMonthly: true,
        prizes: [pointsPrize(1, 100), pointsPrize(2, 10, 5)],
      }),
      'admin-test',
    );
    createdContests.push(created.id);
    await contests.publish(created.id);
    const endAt = new Date(Date.now() - 1000);
    await prisma.contest.update({ where: { id: created.id }, data: { endAt } });

    const result = await contests.draw({ contestId: created.id });
    const again = await contests.draw({ contestId: created.id });

    assert.ok(result.drawn && result.repeatedBy !== null);
    const nextId = result.drawn ? (result.repeatedBy as string) : '';
    createdContests.push(nextId);
    assert.deepEqual(again, { drawn: false, reason: 'ALREADY_DRAWN' });
    const next = await prisma.contest.findUniqueOrThrow({
      where: { id: nextId },
      select: {
        status: true,
        startAt: true,
        endAt: true,
        repeatOfId: true,
        repeatMonthly: true,
        drawSeedHash: true,
        prizes: { orderBy: { place: 'asc' }, select: { place: true, placeTo: true, amount: true } },
      },
    });
    assert.equal(next.status, ContestStatus.ACTIVE);
    assert.equal(next.repeatOfId, created.id);
    assert.equal(next.repeatMonthly, true);
    assert.equal(next.startAt.getTime(), endAt.getTime());
    const days = (next.endAt.getTime() - next.startAt.getTime()) / (24 * HOUR);
    assert.ok(days >= 27.9 && days <= 31.1, `a calendar month, not ${days} days`);
    assert.match(next.drawSeedHash ?? '', /^[0-9a-f]{64}$/, 'a fresh draw key of its own');
    assert.deepEqual(next.prizes, [
      { place: 1, placeTo: null, amount: 100 },
      { place: 2, placeTo: 5, amount: 10 },
    ]);
    assert.equal(await prisma.contest.count({ where: { repeatOfId: created.id } }), 1);
  });

  it('reads traffic from Remnawave, waits for a reading after the end, and ranks by what was used inside', async () => {
    const contestId = await january({ metric: ContestMetric.TRAFFIC });
    const traffic = new ContestTrafficService(prisma, remnawave);
    const old = await createUser('old-sub');
    const fresh = await createUser('new-sub');
    const tag = `${prefix}-rw`;
    await prisma.subscription.create({
      data: {
        userId: old,
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
        remnawaveId: `${tag}-old`,
        createdAt: new Date('2000-06-01T00:00:00.000Z'),
      },
    });
    await prisma.subscription.create({
      data: {
        userId: fresh,
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
        remnawaveId: `${tag}-new`,
        createdAt: inJanuary(10),
      },
    });
    const GB = 1024 ** 3;
    panelUsers = [
      { uuid: `${tag}-old`, panelId: null, userTraffic: { lifetimeUsedTrafficBytes: 100 * GB } },
      { uuid: `${tag}-new`, panelId: null, userTraffic: { lifetimeUsedTrafficBytes: 3 * GB } },
    ];
    await traffic.readDue(inJanuary(11, 0));

    panelUsers = [
      { uuid: `${tag}-old`, panelId: null, userTraffic: { lifetimeUsedTrafficBytes: 105 * GB } },
      { uuid: `${tag}-new`, panelId: null, userTraffic: { lifetimeUsedTrafficBytes: 4 * GB } },
    ];
    assert.equal(await traffic.readDue(inJanuary(11, 0)), 0, 'not again within the hour');

    const early = await contests.draw({ contestId, now: new Date(monthEnd().getTime() + 5 * 60_000) });
    assert.deepEqual(early, { drawn: false, reason: 'AWAITING_TRAFFIC' }, 'the end waits for a reading after it');

    await traffic.readDue(new Date(monthEnd().getTime() + 5 * 60_000));
    const result = await contests.draw({ contestId, now: new Date(monthEnd().getTime() + 6 * 60_000) });

    assert.equal(result.drawn, true);
    const board = await prisma.contestEntry.findMany({
      where: { contestId },
      orderBy: { rank: 'asc' },
      select: { userId: true, score: true },
    });
    assert.deepEqual(
      board.map((row) => [row.userId, Number(row.score) / GB]),
      [
        // Made after the start: everything it ever used is the contest's.
        [fresh, 4],
        // Older: only what it used after the contest first read it.
        [old, 5],
      ].sort((a, b) => (b[1] as number) - (a[1] as number)),
    );
  });

  it('shows a cabinet that asks the board with masked names, its own place and the way to a prize', async () => {
    const contestId = await january({ prizes: [pointsPrize(1, 100)] }, {
      startAt: new Date(Date.now() - 24 * HOUR),
      endAt: new Date(Date.now() + 24 * HOUR),
    });
    const leader = await createUser('Лидер');
    const me = await createUser('Догоняющий');
    for (let i = 0; i < 3; i += 1) await friendWhoPaid(leader, new Date(Date.now() - (5 - i) * HOUR));
    await friendWhoPaid(me, new Date(Date.now() - HOUR));
    const controller = new InternalContestsController(prisma, contests);

    const older = await controller.list(me);
    assert.equal(older.some((row) => row.id === contestId), false, 'an older cabinet would offer «Участвовать»');

    // This window is "now", which other live specs write into as well: what
    // is asserted holds whoever else is on the board.
    const view = (await controller.list(me, 'all')).find((row) => row.id === contestId);
    assert.equal(view?.kind, ContestKind.LEADERBOARD);
    assert.equal(view?.closed, 'AUTOMATIC');
    const board = view?.leaderboard;
    assert.equal(board?.mine?.score, 1);
    assert.ok(board?.top.some((row) => row.name === 'Ли***р' && row.score === 3 && !row.me));
    const mine = board?.top.find((row) => row.me);
    assert.deepEqual([mine?.name, mine?.rank], ['До***й', board?.mine?.rank]);
    assert.equal(board?.toPrize, board?.top[0]?.score, 'one more than first place holds, less the one already made');

    const entered = await contests.enter({ contestId, userId: me });
    assert.deepEqual(entered, { entered: false, reason: 'AUTOMATIC' });
  });

  it('tells the operators once that prizes wait for them, and stays quiet when nothing does', async () => {
    const held = await january({ prizeDelivery: ContestPrizeDelivery.REVIEW, prizes: [pointsPrize(1, 100), pointsPrize(2, 50)] });
    for (const friends of [2, 1]) {
      const id = await createUser(`held-${friends}`);
      for (let i = 0; i < friends; i += 1) await friendWhoPaid(id, inJanuary(3 + i));
    }
    raised.length = 0;

    const result = await contests.draw({ contestId: held });
    await contests.draw({ contestId: held });

    assert.equal(result.drawn && result.pending, 2);
    assert.deepEqual(
      raised.filter((event) => event.metadata['contestId'] === held).map((event) => [event.type, event.metadata['pending']]),
      [['contest.prizes_pending', 2]],
    );

    const paid = await january();
    await friendWhoPaid(await createUser('paid-at-once'), inJanuary(3));
    raised.length = 0;
    await contests.draw({ contestId: paid });
    assert.equal(raised.length, 0, 'a prize paid at once leaves the operators nothing to do');
  });

  it('shows the hints a check needs: friends who share the winner’s device or address, flags', async () => {
    const contestId = await january({ prizeDelivery: ContestPrizeDelivery.REVIEW });
    const winner = await createUser('suspect');
    const friends: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const friend = await createUser(`twin-${i}`);
      friends.push(friend);
      await prisma.referral.create({ data: { referrerId: winner, referredId: friend, level: 1, qualifiedAt: inJanuary(4 + i) } });
    }
    const device = `${prefix}-device`;
    for (const id of [winner, friends[0] as string, friends[1] as string]) {
      await prisma.deviceObservation.create({ data: { userId: id, kind: DeviceSignalKind.INSTALL_ID, value: device } });
    }
    for (const id of [winner, friends[2] as string]) {
      await prisma.userIpObservation.create({ data: { userId: id, address: '203.0.113.77' } });
    }
    await prisma.userReviewFlag.create({ data: { userId: winner, kind: UserReviewFlagKind.DEVICE_MATCH, fingerprint: `${prefix}-flag` } });
    await prisma.user.update({ where: { id: friends[2] as string }, data: { isBlocked: true } });

    await contests.draw({ contestId });
    const [row] = await winners.listForContest(contestId);

    assert.deepEqual(row?.signals?.friends, { counted: 3, sharedDevice: 2, sharedIp: 1, blocked: 1 });
    assert.equal(row?.signals?.reviewFlags, 1);
    assert.equal(row?.signals?.accountAgeDays, 0);
  });

  it('reminds a leaderboard’s prize holders and those right behind, a day before the end, once', async () => {
    const contestId = await january({ remind: true, leaderboardSize: 3, prizes: [pointsPrize(1, 100)] });
    const people: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = await createUser(`r${i}`);
      people.push(id);
      for (let f = 0; f < 6 - i; f += 1) await friendWhoPaid(id, inJanuary(2 + f));
    }
    const dayBefore = new Date(monthEnd().getTime() - 12 * HOUR);
    sent.length = 0;

    await notices.sendDue(dayBefore);
    await notices.sendDue(dayBefore);

    const mine = sent.filter((entry) => entry.payload['contestId'] === contestId);
    assert.deepEqual(
      mine.map((entry) => [people.indexOf(entry.userId), entry.type, entry.payload['place'], entry.payload['contestGap'] ?? null]),
      [
        [0, 'contest_reminder_holding', 1, null],
        // To take first place from six, a score has to beat it: seven.
        [1, 'contest_reminder_chasing', 2, '2'],
        [2, 'contest_reminder_chasing', 3, '3'],
        [3, 'contest_reminder_chasing', 4, '4'],
      ],
      'the prize place and three behind it; nobody further down; nobody twice',
    );
    const row = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { remindedAt: true } });
    assert.notEqual(row.remindedAt, null);
  });

  it('does not remind a contest shorter than two days: a day after its start is not a day before its end', async () => {
    const startAt = monthStart();
    const contestId = await january(
      { kind: ContestKind.DRAW, metric: null, remind: true },
      { startAt, endAt: new Date(startAt.getTime() + 36 * HOUR) },
    );
    await createUser('short-contest');
    sent.length = 0;

    await notices.sendDue(new Date(startAt.getTime() + 25 * HOUR));

    assert.equal(sent.some((entry) => entry.payload['contestId'] === contestId), false);
    const row = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { remindedAt: true } });
    assert.equal(row.remindedAt, null);
  });

  it('reminds the audience of a draw who has not entered, and not the entrants', async () => {
    const contestId = await january({ kind: ContestKind.DRAW, metric: null, remind: true });
    const entrant = await createUser('in-already');
    const outsider = await createUser('not-yet');
    await prisma.contestEntry.create({ data: { contestId, userId: entrant } });
    const dayBefore = new Date(monthEnd().getTime() - 12 * HOUR);
    sent.length = 0;

    for (let round = 0; round < 200; round += 1) {
      const row = await prisma.contest.findUniqueOrThrow({ where: { id: contestId }, select: { remindedAt: true } });
      if (row.remindedAt !== null) break;
      await notices.sendDue(dayBefore);
    }

    const mine = sent.filter((entry) => entry.payload['contestId'] === contestId);
    assert.ok(mine.some((entry) => entry.userId === outsider && entry.type === 'contest_reminder'));
    assert.equal(mine.some((entry) => entry.userId === entrant), false);
  });

  it('tells the board its places, and the winner theirs — not everybody further down', async () => {
    const contestId = await january({ leaderboardSize: 3, prizes: [pointsPrize(1, 100)] });
    const people: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await createUser(`p${i}`);
      people.push(id);
      for (let f = 0; f < 5 - i; f += 1) await friendWhoPaid(id, inJanuary(3 + f));
    }
    await contests.draw({ contestId });
    sent.length = 0;

    for (let round = 0; round < 5; round += 1) await notices.sendDue();

    const mine = sent.filter((entry) => entry.payload['contestId'] === contestId);
    assert.deepEqual(
      mine.map((entry) => [people.indexOf(entry.userId), entry.type]).sort(),
      [
        [0, 'contest_won'],
        [1, 'contest_rank'],
        [2, 'contest_rank'],
      ],
    );
    const second = mine.find((entry) => entry.userId === people[1]);
    assert.equal(second?.payload['place'], 2);
    assert.equal(second?.payload['contestTotal'], 5);
    assert.equal(second?.payload['contestScore'], '4');
    assert.equal(second?.payload['contestMetric'], ContestMetric.REFERRALS_PAID);
    assert.equal(await prisma.contestNotice.count({ where: { contestId, kind: ContestNoticeKind.RESULT } }), 3);
  });
});
