import { Injectable, Logger } from '@nestjs/common';
import {
  BroadcastAudience,
  ContestNoticeKind,
  ContestStatus,
  Prisma,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAudienceWhere, normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';

/** Notice types, as the template catalogue and the panel's template page name them. */
export const CONTEST_NOTICE_TYPES = {
  started: 'contest_started',
  won: 'contest_won',
  wonManual: 'contest_won_manual',
  lost: 'contest_lost',
} as const;

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
 * its words live in «Шаблоны уведомлений».
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
  ) {}

  public async sendDue(now = new Date()): Promise<{ readonly announced: number; readonly results: number }> {
    let announced = 0;
    let results = 0;

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
      select: { id: true, title: true, endAt: true, audienceFilter: true },
    });
    for (const contest of opening) {
      announced += await this.announce(contest, now);
    }

    const drawn = await this.prismaService.contest.findMany({
      where: { status: ContestStatus.DRAWN, resultsNotifiedAt: null },
      orderBy: { drawnAt: 'asc' },
      take: 5,
      select: { id: true, title: true },
    });
    for (const contest of drawn) {
      results += await this.tellResults(contest, now);
    }
    return { announced, results };
  }

  /** One batch of «начался конкурс» to people who may enter and have not. */
  private async announce(
    contest: {
      readonly id: string;
      readonly title: Prisma.JsonValue;
      readonly endAt: Date;
      readonly audienceFilter: Prisma.JsonValue | null;
    },
    now: Date,
  ): Promise<number> {
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
      await this.notify(userId, CONTEST_NOTICE_TYPES.started, {
        contestId: contest.id,
        contestTitle: contest.title,
        contestEndsAt: contest.endAt.toISOString(),
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

  /** One batch of results to entrants not yet told. */
  private async tellResults(
    contest: { readonly id: string; readonly title: Prisma.JsonValue },
    now: Date,
  ): Promise<number> {
    const entries = await this.prismaService.contestEntry.findMany({
      where: {
        contestId: contest.id,
        user: { contestNotices: { none: { contestId: contest.id, kind: ContestNoticeKind.RESULT } } },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { userId: true },
    });
    const userIds = entries.map((entry) => entry.userId);
    const wins = await this.prismaService.contestWinner.findMany({
      where: { contestId: contest.id, userId: { in: userIds } },
      select: { userId: true, place: true, status: true, prizeSnapshot: true },
    });
    const winOf = new Map(wins.map((win) => [win.userId, win]));

    const claimed = await this.claim(contest.id, ContestNoticeKind.RESULT, userIds);
    for (const userId of claimed) {
      const win = winOf.get(userId);
      if (win === undefined) {
        await this.notify(userId, CONTEST_NOTICE_TYPES.lost, { contestId: contest.id, contestTitle: contest.title });
        continue;
      }
      // Owed and not yet handed over — a manual prize, or a key the pool ran
      // out of: the person is told an operator will be in touch, not that the
      // prize is already theirs.
      await this.notify(
        userId,
        win.status === WheelSpinStatus.PENDING ? CONTEST_NOTICE_TYPES.wonManual : CONTEST_NOTICE_TYPES.won,
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
