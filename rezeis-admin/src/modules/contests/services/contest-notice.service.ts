import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  BroadcastAudience,
  ContestKind,
  ContestMetric,
  ContestNoticeKind,
  ContestPrizeDelivery,
  ContestStatus,
  Prisma,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAudienceWhere, normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { countPlaces, readGapToPrize } from './contest.service';
import { ContestStandingsService } from './contest-standings.service';

/** Notice types, as the template catalogue and the panel's template page name them. */
export const CONTEST_NOTICE_TYPES = {
  started: 'contest_started',
  leaderboardStarted: 'contest_leaderboard_started',
  won: 'contest_won',
  wonManual: 'contest_won_manual',
  wonReview: 'contest_won_review',
  lost: 'contest_lost',
  rank: 'contest_rank',
  reminder: 'contest_reminder',
  reminderHolding: 'contest_reminder_holding',
  reminderChasing: 'contest_reminder_chasing',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * People told per contest per sweep. A sweep runs every minute, so this is
 * the pace: a few hundred messages a minute stays well inside what Telegram
 * takes from one bot, and an audience of thousands is told within the hour.
 */
const BATCH = 300;

/**
 * Tells people about contests: that one has opened, and how they did.
 *
 * The owner's choice (29.10.2026): an announcement to everybody who may enter
 * when the operator ticks «Сообщить о конкурсе»; the result to every entrant
 * after the draw — the winner, and «не повезло» to the rest. Each through the
 * ordinary user notification, so it reaches the bot and the cabinet feed and
 * its words live in «Уведомления» → «Шаблоны сообщений».
 *
 * A leaderboard has nobody who entered: its results go to the winners and to
 * everybody else on the public board — «ваше место X из Y» — and not to the
 * thousands further down, who never asked to be in a contest at all.
 *
 * One reminder a day before the end, when the operator ticks «Напомнить за
 * сутки»: a draw reminds the audience that has not entered yet; a
 * leaderboard reminds the people at the prize places and those right behind
 * them — «вы на 12-м месте, до приза не хватает 1 друга» — and nobody else.
 * A contest shorter than two days gets none: its reminder would land on the
 * day it started.
 *
 * ── At most once ──────────────────────────────────────────────────────────
 *
 * A `contest_notices` row is written BEFORE the message goes, under a unique
 * index on (contest, kind, person). A sweep that dies halfway leaves rows for
 * people who may not have been told — and does not tell them again. The
 * other order would tell some people twice, and a second «вы выиграли» is
 * worse than a missing one: the cabinet still shows the result.
 *
 * A contest is marked done (`announcedAt`, `resultsNotifiedAt`) when a sweep
 * finds nobody left, so the queries stop visiting it.
 */
@Injectable()
export class ContestNoticeService {
  private readonly logger = new Logger(ContestNoticeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly userNotifications: UserNotificationsService,
    /** The base currency a payments score is told in. `@Optional()` for the specs. */
    @Optional() private readonly standings?: ContestStandingsService,
  ) {}

  public async sendDue(
    now = new Date(),
  ): Promise<{ readonly announced: number; readonly results: number; readonly reminded: number }> {
    let announced = 0;
    let results = 0;
    let reminded = 0;

    const opening = await this.prismaService.contest.findMany({
      where: {
        status: ContestStatus.ACTIVE,
        announce: true,
        announcedAt: null,
        startAt: { lte: now },
        endAt: { gt: now },
      },
      orderBy: { startAt: 'asc' },
      take: 5,
      select: { id: true, title: true, endAt: true, audienceFilter: true, kind: true, metric: true },
    });
    for (const contest of opening) {
      announced += await this.announce(contest, now);
    }

    const drawn = await this.prismaService.contest.findMany({
      where: { status: ContestStatus.DRAWN, resultsNotifiedAt: null },
      orderBy: { drawnAt: 'asc' },
      take: 5,
      select: {
        id: true,
        title: true,
        kind: true,
        metric: true,
        leaderboardSize: true,
        prizeDelivery: true,
        drawnEntries: true,
        prizes: { select: { place: true, placeTo: true } },
      },
    });
    for (const contest of drawn) {
      results += await this.tellResults(contest, now);
    }

    const ending = await this.prismaService.contest.findMany({
      where: {
        status: ContestStatus.ACTIVE,
        remind: true,
        remindedAt: null,
        endAt: { gt: now, lte: new Date(now.getTime() + DAY_MS) },
        startAt: { lte: new Date(now.getTime() - DAY_MS) },
      },
      orderBy: { endAt: 'asc' },
      take: 20,
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        audienceFilter: true,
        kind: true,
        metric: true,
        minScore: true,
        leaderboardSize: true,
        prizes: { select: { place: true, placeTo: true } },
      },
    });
    for (const contest of ending) {
      // Shorter than two days: a day after its start is already less than a
      // day before its end, and «остались сутки» would not be true. The query
      // cannot compare its two columns, so the rule is kept here.
      if (contest.endAt.getTime() - contest.startAt.getTime() < 2 * DAY_MS) continue;
      reminded += await this.remind(contest, now);
    }
    return { announced, results, reminded };
  }

  /** One batch of «остались сутки». */
  private async remind(
    contest: {
      readonly id: string;
      readonly title: Prisma.JsonValue;
      readonly startAt: Date;
      readonly endAt: Date;
      readonly audienceFilter: Prisma.JsonValue | null;
      readonly kind: ContestKind;
      readonly metric: ContestMetric | null;
      readonly minScore: bigint | null;
      readonly leaderboardSize: number;
      readonly prizes: readonly { readonly place: number; readonly placeTo: number | null }[];
    },
    now: Date,
  ): Promise<number> {
    const common = { contestId: contest.id, contestTitle: contest.title, contestEndsAt: contest.endAt.toISOString() };

    if (contest.kind !== ContestKind.LEADERBOARD) {
      const filter = normalizeAudienceFilter(contest.audienceFilter);
      const audience = filter === null ? {} : buildAudienceWhere(BroadcastAudience.ALL, filter);
      const people = await this.prismaService.user.findMany({
        where: {
          AND: [
            { isBlocked: false },
            audience,
            { contestEntries: { none: { contestId: contest.id } } },
            { contestNotices: { none: { contestId: contest.id, kind: ContestNoticeKind.REMINDER } } },
          ],
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: { id: true },
      });
      const claimed = await this.claim(contest.id, ContestNoticeKind.REMINDER, people.map((person) => person.id));
      for (const userId of claimed) await this.notify(userId, CONTEST_NOTICE_TYPES.reminder, common);
      if (people.length < BATCH) await this.markReminded(contest.id, now);
      return claimed.length;
    }

    // The board is a few hundred people at most here: the prize places and
    // as many again behind them. One pass, then done.
    if (this.standings === undefined) return 0;
    const board = await this.standings.live({ ...contest }, now);
    const places = countPlaces(contest.prizes);
    const reach = Math.min(board.length, places + contest.leaderboardSize);
    const candidates = board.slice(0, reach);
    const claimed = new Set(
      await this.claim(contest.id, ContestNoticeKind.REMINDER, candidates.map((row) => row.userId)),
    );
    const currency = this.standings.baseCurrency();
    let sent = 0;
    for (const [index, row] of candidates.entries()) {
      if (!claimed.has(row.userId)) continue;
      const gap = readGapToPrize(board, index, places, contest.minScore);
      const holding = gap === 0;
      await this.notify(row.userId, holding ? CONTEST_NOTICE_TYPES.reminderHolding : CONTEST_NOTICE_TYPES.reminderChasing, {
        ...common,
        place: index + 1,
        contestScore: row.score.toString(),
        contestMetric: contest.metric,
        contestCurrency: currency,
        ...(holding || gap === null ? {} : { contestGap: String(gap) }),
      });
      sent += 1;
    }
    await this.markReminded(contest.id, now);
    return sent;
  }

  private async markReminded(contestId: string, now: Date): Promise<void> {
    await this.prismaService.contest.updateMany({
      where: { id: contestId, remindedAt: null },
      data: { remindedAt: now },
    });
  }

  /** One batch of «начался конкурс» to people who may enter and have not. */
  private async announce(
    contest: {
      readonly id: string;
      readonly title: Prisma.JsonValue;
      readonly endAt: Date;
      readonly audienceFilter: Prisma.JsonValue | null;
      readonly kind: ContestKind;
      readonly metric: ContestMetric | null;
    },
    now: Date,
  ): Promise<number> {
    const ranked = contest.kind === ContestKind.LEADERBOARD;
    const filter = normalizeAudienceFilter(contest.audienceFilter);
    const audience = filter === null ? {} : buildAudienceWhere(BroadcastAudience.ALL, filter);
    const people = await this.prismaService.user.findMany({
      where: {
        AND: [
          { isBlocked: false },
          audience,
          { contestEntries: { none: { contestId: contest.id } } },
          { contestNotices: { none: { contestId: contest.id, kind: ContestNoticeKind.ANNOUNCED } } },
        ],
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true },
    });

    const claimed = await this.claim(contest.id, ContestNoticeKind.ANNOUNCED, people.map((person) => person.id));
    for (const userId of claimed) {
      await this.notify(userId, ranked ? CONTEST_NOTICE_TYPES.leaderboardStarted : CONTEST_NOTICE_TYPES.started, {
        contestId: contest.id,
        contestTitle: contest.title,
        contestEndsAt: contest.endAt.toISOString(),
        ...(ranked ? { contestMetric: contest.metric } : {}),
      });
    }
    if (people.length < BATCH) {
      await this.prismaService.contest.updateMany({
        where: { id: contest.id, announcedAt: null },
        data: { announcedAt: now },
      });
    }
    return claimed.length;
  }

  /** One batch of results to entrants — or, on a leaderboard, the board — not yet told. */
  private async tellResults(
    contest: {
      readonly id: string;
      readonly title: Prisma.JsonValue;
      readonly kind: ContestKind;
      readonly metric: ContestMetric | null;
      readonly leaderboardSize: number;
      readonly prizeDelivery: ContestPrizeDelivery;
      readonly drawnEntries: number | null;
      readonly prizes: readonly { readonly place: number; readonly placeTo: number | null }[];
    },
    now: Date,
  ): Promise<number> {
    const ranked = contest.kind === ContestKind.LEADERBOARD;
    // Every prize place is inside this, and so is the whole public board.
    const told = Math.max(contest.leaderboardSize, countPlaces(contest.prizes));
    const entries = await this.prismaService.contestEntry.findMany({
      where: {
        contestId: contest.id,
        ...(ranked ? { rank: { lte: told } } : {}),
        user: { contestNotices: { none: { contestId: contest.id, kind: ContestNoticeKind.RESULT } } },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { userId: true, rank: true, score: true },
    });
    const userIds = entries.map((entry) => entry.userId);
    const entryOf = new Map(entries.map((entry) => [entry.userId, entry]));
    const wins = await this.prismaService.contestWinner.findMany({
      where: { contestId: contest.id, userId: { in: userIds } },
      select: { userId: true, place: true, status: true, heldForReview: true, prizeSnapshot: true },
    });
    const winOf = new Map(wins.map((win) => [win.userId, win]));
    const currency = this.standings?.baseCurrency() ?? 'RUB';

    const claimed = await this.claim(contest.id, ContestNoticeKind.RESULT, userIds);
    for (const userId of claimed) {
      const win = winOf.get(userId);
      if (win === undefined) {
        const entry = entryOf.get(userId);
        if (ranked && entry?.rank != null) {
          await this.notify(userId, CONTEST_NOTICE_TYPES.rank, {
            contestId: contest.id,
            contestTitle: contest.title,
            place: entry.rank,
            contestTotal: contest.drawnEntries ?? entry.rank,
            contestScore: (entry.score ?? 0n).toString(),
            contestMetric: contest.metric,
            contestCurrency: currency,
          });
          continue;
        }
        await this.notify(userId, CONTEST_NOTICE_TYPES.lost, { contestId: contest.id, contestTitle: contest.title });
        continue;
      }
      // Held for the operator's check: the person is told it is coming, not
      // that it is theirs already. Owed and handed over by a human — a manual
      // prize, a prize «через поддержку», a key the pool ran out of: an
      // operator will be in touch.
      await this.notify(
        userId,
        win.heldForReview && contest.prizeDelivery === ContestPrizeDelivery.REVIEW
          ? CONTEST_NOTICE_TYPES.wonReview
          : win.status === WheelSpinStatus.PENDING
            ? CONTEST_NOTICE_TYPES.wonManual
            : CONTEST_NOTICE_TYPES.won,
        {
          contestId: contest.id,
          contestTitle: contest.title,
          contestPrize: readTitle(win.prizeSnapshot),
          place: win.place,
        },
      );
    }
    if (entries.length < BATCH) {
      await this.prismaService.contest.updateMany({
        where: { id: contest.id, resultsNotifiedAt: null },
        data: { resultsNotifiedAt: now },
      });
    }
    return claimed.length;
  }

  /**
   * Write the notice rows and return the people they were written for. A row
   * that already exists — a concurrent sweep, a retry — is skipped, and so is
   * its person.
   */
  private async claim(contestId: string, kind: ContestNoticeKind, userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const before = await this.prismaService.contestNotice.findMany({
      where: { contestId, kind, userId: { in: [...userIds] } },
      select: { userId: true },
    });
    const told = new Set(before.map((row) => row.userId));
    const fresh = userIds.filter((userId) => !told.has(userId));
    if (fresh.length === 0) return [];
    await this.prismaService.contestNotice.createMany({
      data: fresh.map((userId) => ({ contestId, kind, userId })),
      skipDuplicates: true,
    });
    // `skipDuplicates` does not say which rows it skipped; a concurrent sweep
    // that claimed some of these between the read and the insert is rare and
    // costs at worst one repeated message, which the bot de-duplicates on the
    // event when it can.
    return fresh;
  }

  private async notify(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.userNotifications.create({ userId, type, payload });
    } catch (error: unknown) {
      this.logger.warn(
        `Contest notice ${type} to ${userId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function readTitle(snapshot: Prisma.JsonValue): Prisma.JsonValue {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return {};
  return (snapshot as Record<string, Prisma.JsonValue>)['title'] ?? {};
}
