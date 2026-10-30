import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  BroadcastAudience,
  ContestKind,
  ContestMetric,
  ContestPrizeDelivery,
  ContestStatus,
  Prisma,
  TransactionStatus,
  WheelSectorKind,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAudienceWhere, normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { readPlatformBranding } from '../../settings/utils/platform-branding.util';
import { PrizePayoutService } from '../../wheel/services/prize-payout.service';
import { validateSector } from '../../wheel-config/wheel-sector-validation.util';
import { addCalendarMonth, safeZone } from '../contest-calendar.util';
import { drawWeightedWinners, hashDrawSeed, newDrawSeed, seededRandom } from '../contest-draw.util';
import { ContestStandingsService, type Standing } from './contest-standings.service';

/** The most places one contest hands out, ranges included. */
export const MAX_PLACES = 100;

/**
 * How long after its end a traffic leaderboard waits for a reading from
 * Remnawave before its failure to finish is the operator's business.
 */
const TRAFFIC_GRACE_MS = 60 * 60 * 1000;

const PRIZE_SELECT = {
  id: true,
  place: true,
  placeTo: true,
  kind: true,
  title: true,
  amount: true,
  promoRewardType: true,
  promoPlanId: true,
  promoPlanIds: true,
  promoLifetime: true,
  keyPoolId: true,
  manualInstructions: true,
} as const;

const CONTEST_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  startAt: true,
  endAt: true,
  audienceFilter: true,
  maxEntries: true,
  drawnAt: true,
  drawnEntries: true,
  drawnTickets: true,
  order: true,
  createdAt: true,
  announce: true,
  announcedAt: true,
  resultsNotifiedAt: true,
  ticketsPerPurchase: true,
  ticketsPerReferral: true,
  maxTicketsPerUser: true,
  channelChatId: true,
  channelJoinUrl: true,
  drawSeed: true,
  drawSeedHash: true,
  drawError: true,
  drawErrorAt: true,
  kind: true,
  metric: true,
  minScore: true,
  leaderboardSize: true,
  prizeDelivery: true,
  repeatMonthly: true,
  repeatOfId: true,
  trafficReadAt: true,
  prizes: { orderBy: { place: 'asc' as const }, select: PRIZE_SELECT },
  _count: { select: { entries: true, winners: true } },
} as const;

/** Everything a contest is run by — what the draw reads, and what a monthly repeat copies. */
const TERMS_SELECT = {
  title: true,
  description: true,
  status: true,
  startAt: true,
  endAt: true,
  audienceFilter: true,
  maxEntries: true,
  order: true,
  createdBy: true,
  announce: true,
  ticketsPerPurchase: true,
  ticketsPerReferral: true,
  maxTicketsPerUser: true,
  channelChatId: true,
  channelJoinUrl: true,
  drawSeed: true,
  kind: true,
  metric: true,
  minScore: true,
  leaderboardSize: true,
  prizeDelivery: true,
  repeatMonthly: true,
  trafficReadAt: true,
  prizes: { orderBy: { place: 'asc' as const }, select: PRIZE_SELECT },
} as const;

type ContestTerms = Prisma.ContestGetPayload<{ select: typeof TERMS_SELECT }>;

type ContestRow = Prisma.ContestGetPayload<{ select: typeof CONTEST_SELECT }>;
export type PrizeRow = Prisma.ContestPrizeGetPayload<{ select: typeof PRIZE_SELECT }>;

/** Where entering needs a subscription: the chat Telegram is asked about, and the link people join by. */
export interface ContestChannel {
  readonly chatId: string;
  readonly joinUrl: string;
}

/** What earns extra chances. All zero / null is one person, one chance. */
export interface ContestTicketRules {
  readonly ticketsPerPurchase: number;
  readonly ticketsPerReferral: number;
  /** Ceiling per person, the ticket for entering included. `null` = none. */
  readonly maxTicketsPerUser: number | null;
}

export interface ContestPrizeInput {
  readonly place: number;
  /** The last place this prize covers; `null` is the one place. */
  readonly placeTo: number | null;
  readonly kind: WheelSectorKind;
  readonly title: Prisma.InputJsonValue;
  readonly amount: number;
  readonly promoRewardType: PrizeRow['promoRewardType'];
  readonly promoPlanId: string | null;
  readonly promoPlanIds: readonly string[];
  readonly promoLifetime: number | null;
  readonly keyPoolId: string | null;
  readonly manualInstructions: string | null;
}

export interface ContestInput extends ContestTicketRules {
  readonly title: Prisma.InputJsonValue;
  readonly description: Prisma.InputJsonValue;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly audienceFilter: Prisma.InputJsonValue | null;
  readonly maxEntries: number | null;
  readonly announce: boolean;
  readonly channel: ContestChannel | null;
  readonly prizes: readonly ContestPrizeInput[];
  readonly kind: ContestKind;
  /** What a leaderboard ranks by; ignored on a draw. */
  readonly metric: ContestMetric | null;
  /** The least score that wins a place, in the metric's unit. `null` = above nothing. */
  readonly minScore: number | null;
  readonly leaderboardSize: number;
  readonly prizeDelivery: ContestPrizeDelivery;
  readonly repeatMonthly: boolean;
}

export interface ContestSummary extends ContestTicketRules {
  readonly id: string;
  readonly title: Prisma.JsonValue;
  readonly description: Prisma.JsonValue;
  readonly status: ContestStatus;
  readonly startAt: string;
  readonly endAt: string;
  readonly audienceFilter: Prisma.JsonValue | null;
  readonly maxEntries: number | null;
  readonly drawnAt: string | null;
  readonly drawnEntries: number | null;
  readonly drawnTickets: number | null;
  readonly order: number;
  readonly createdAt: string;
  readonly entries: number;
  readonly winners: number;
  readonly announce: boolean;
  readonly announcedAt: string | null;
  readonly resultsNotifiedAt: string | null;
  readonly channel: ContestChannel | null;
  /** SHA-256 of the draw's seed, from publish on. */
  readonly drawSeedHash: string | null;
  /** The seed itself — only once the draw has run, here as in the cabinet. */
  readonly drawSeed: string | null;
  /** Why the last draw attempt failed, while it keeps failing. */
  readonly drawError: string | null;
  readonly drawErrorAt: string | null;
  readonly kind: ContestKind;
  readonly metric: ContestMetric | null;
  readonly minScore: number | null;
  readonly leaderboardSize: number;
  readonly prizeDelivery: ContestPrizeDelivery;
  readonly repeatMonthly: boolean;
  /** The contest this one repeats, if it is a monthly repeat. */
  readonly repeatOfId: string | null;
  readonly trafficReadAt: string | null;
  /** How many places it hands out, ranges counted out. */
  readonly places: number;
  /** The base currency a payments leaderboard counts in, as minor units. */
  readonly currency: string;
  /** Prizes won and not yet handed over: held for a check, manual, or a key that ran out. */
  readonly pendingPrizes: number;
  readonly prizes: readonly PrizeRow[];
  /** Why it cannot be published as it stands. Empty means it can. */
  readonly problems: readonly string[];
}

export type DrawResult =
  | {
      readonly drawn: true;
      readonly winners: number;
      readonly entrants: number;
      /** Tickets in a draw; `null` on a leaderboard. */
      readonly tickets: number | null;
      /** The contest that repeats this one, when it was made. */
      readonly repeatedBy: string | null;
    }
  /**
   * Not ACTIVE, or not over yet, or already drawn by a concurrent sweep; or a
   * traffic leaderboard still waiting for its reading after the end.
   */
  | { readonly drawn: false; readonly reason: 'NOT_ACTIVE' | 'NOT_OVER' | 'ALREADY_DRAWN' | 'AWAITING_TRAFFIC' };

/** One entrant as the operator sees them. */
export interface ContestEntrantRow {
  readonly userId: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly telegramId: string | null;
  readonly enteredAt: string;
  /** As the draw counted them, or — before the draw — as it would now. */
  readonly tickets: number;
}

/** One place on a leaderboard as the operator sees it. */
export interface ContestStandingRow {
  readonly rank: number;
  readonly userId: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly telegramId: string | null;
  /** In the metric's unit: friends, minor units of the base currency, bytes, points. */
  readonly score: number;
}

/** A leaderboard as one person sees it: the top, and where they stand. */
export interface LeaderboardView {
  readonly top: readonly {
    readonly rank: number;
    readonly userId: string;
    readonly name: string | null;
    readonly username: string | null;
    readonly score: number;
  }[];
  /** How many are ranked. */
  readonly total: number;
  readonly mine: { readonly rank: number; readonly score: number } | null;
  /**
   * How much more this person needs to take the last prize place — `0` when
   * they hold one, `null` when there is nobody to ask about.
   */
  readonly toPrize: number | null;
  /** The base currency a payments leaderboard is counted in. */
  readonly currency: string;
}

/**
 * A contest from draft to draw.
 *
 * ── The draw is one transaction ───────────────────────────────────────────
 *
 * Tickets are counted, winners are chosen, every prize is paid or recorded as
 * owed, and the contest is stamped DRAWN — together or not at all. A crash
 * halfway would otherwise leave a contest with three winners paid and two
 * unnamed, and the sweep would happily draw it again with different people.
 *
 * The stamp is a conditional write on ACTIVE: two sweeps racing for the same
 * contest cannot both win it, and the loser reports ALREADY_DRAWN rather than
 * handing out a second set of prizes.
 *
 * What the payout changed in a subscription — a won «+7 дней», «+10 ГБ» — is
 * pushed to Remnawave AFTER the commit. It used to be dropped: the panel had
 * the new date and Remnawave cut the winner off on the old one.
 *
 * ── Entering is one row per person ────────────────────────────────────────
 *
 * The unique index on (contest, user) is the rule. A second entry is refused
 * by the database, not by a read-then-check that a double tap could slip
 * past. The ceiling on entries, where one is set, IS a read-then-check — a
 * count and then an insert — and that is accepted: the failure it allows is
 * a contest closing at 1001 entries instead of 1000, which is not a failure
 * anybody would notice or mind.
 *
 * ── Tickets are counted, not kept ─────────────────────────────────────────
 *
 * Extra chances come from what happened inside the window — a paid purchase,
 * a friend who paid — and are counted from the payments and the referrals
 * themselves when they are needed: at the draw, and for the screen. A refund
 * before the draw takes its ticket with it, and there is no second ledger to
 * fall out of step with the first.
 */
@Injectable()
export class ContestService {
  private readonly logger = new Logger(ContestService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly payout: PrizePayoutService,
    /**
     * Pushes a won «+дни» / «+трафик» to Remnawave after the draw commits.
     * `@Optional()` and last for the specs that build this positionally.
     */
    @Optional() private readonly profileSyncQueue?: ProfileSyncQueueService,
    /** Ranks a leaderboard. `@Optional()` for the same specs; a leaderboard without it cannot end. */
    @Optional() private readonly standings?: ContestStandingsService,
  ) {}

  public async list(): Promise<readonly ContestSummary[]> {
    const rows = await this.prismaService.contest.findMany({
      orderBy: [{ status: 'asc' }, { endAt: 'desc' }],
      select: CONTEST_SELECT,
    });
    const currency = this.baseCurrency();
    const pending = await this.pendingPrizes(rows.map((row) => row.id));
    return rows.map((row) => toSummary(row, currency, pending.get(row.id) ?? 0));
  }

  public async get(contestId: string): Promise<ContestSummary> {
    const row = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: CONTEST_SELECT,
    });
    if (row === null) throw new NotFoundException('Contest not found');
    const pending = await this.pendingPrizes([row.id]);
    return toSummary(row, this.baseCurrency(), pending.get(row.id) ?? 0);
  }

  /** How many prizes each contest still owes — what the operator has to go and press «Выдать» on. */
  private async pendingPrizes(contestIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (contestIds.length === 0) return new Map();
    const rows = await this.prismaService.contestWinner.groupBy({
      by: ['contestId'],
      where: { contestId: { in: [...contestIds] }, status: WheelSpinStatus.PENDING },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.contestId, row._count._all]));
  }

  private baseCurrency(): string {
    return this.standings?.baseCurrency() ?? 'RUB';
  }

  public async create(input: ContestInput, createdBy: string): Promise<ContestSummary> {
    assertPrizesValid(input.prizes);
    const created = await this.prismaService.contest.create({
      data: {
        ...termsData(input),
        createdBy,
        prizes: { create: input.prizes.map((prize) => toPrizeData(prize)) },
      },
      select: { id: true },
    });
    return this.get(created.id);
  }

  /**
   * Edit a draft, or the wording of a live contest.
   *
   * Once people have entered, the terms they entered under are fixed: prizes,
   * audience, channel and tickets may not change on a live contest. The title
   * and the description may — a typo is not a term — and the end may move
   * LATER (the owner, 29.10.2026): more time takes nothing from anybody who
   * entered, while an earlier end would close the door on people who were
   * told they had until then. «Повторять каждый месяц» may be switched either
   * way: it decides what happens after this contest, not what it is.
   */
  public async update(contestId: string, input: ContestInput, now = new Date()): Promise<ContestSummary> {
    const current = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { status: true, endAt: true },
    });
    if (current === null) throw new NotFoundException('Contest not found');

    if (current.status === ContestStatus.DRAFT) {
      assertPrizesValid(input.prizes);
      await this.prismaService.$transaction(async (tx) => {
        await tx.contestPrize.deleteMany({ where: { contestId } });
        await tx.contest.update({
          where: { id: contestId },
          data: {
            ...termsData(input),
            prizes: { create: input.prizes.map((prize) => toPrizeData(prize)) },
          },
        });
      });
      return this.get(contestId);
    }

    if (current.status === ContestStatus.ACTIVE) {
      const endAt = readExtendedEnd(current.endAt, input.endAt, now);
      // Conditional on ACTIVE: a draw that lands between the read above and
      // this write must not have its end moved under it.
      const changed = await this.prismaService.contest.updateMany({
        where: { id: contestId, status: ContestStatus.ACTIVE },
        data: {
          title: input.title,
          description: input.description,
          repeatMonthly: input.repeatMonthly,
          ...(endAt === null ? {} : { endAt }),
        },
      });
      if (changed.count !== 1) throw new ConflictException('Конкурс уже разыгран — его нельзя изменить');
      return this.get(contestId);
    }

    throw new ConflictException('Завершённый конкурс нельзя редактировать');
  }

  /** A draft with nobody in it can simply go. Anything else stays for the record. */
  public async remove(contestId: string): Promise<void> {
    const current = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { status: true },
    });
    if (current === null) throw new NotFoundException('Contest not found');
    if (current.status !== ContestStatus.DRAFT) {
      throw new ConflictException('Удалить можно только черновик; остальное — отменить');
    }
    await this.prismaService.contest.delete({ where: { id: contestId } });
  }

  /**
   * DRAFT → ACTIVE, once it is a contest somebody could actually win.
   *
   * The draw's seed is made here, not at creation: until now a draft can be
   * edited at will, and from now on nobody — the operator included — may see
   * the seed until the draw has used it. Only its hash goes out. A
   * leaderboard has no chance in it, and gets no seed.
   */
  public async publish(contestId: string, now = new Date()): Promise<ContestSummary> {
    const summary = await this.get(contestId);
    if (summary.status !== ContestStatus.DRAFT) {
      throw new ConflictException('Опубликовать можно только черновик');
    }
    const problems = [...summary.problems];
    if (new Date(summary.endAt).getTime() <= now.getTime()) {
      problems.push('Конец конкурса уже прошёл');
    }
    if (problems.length > 0) throw new BadRequestException(problems.join('; '));

    const changed = await this.prismaService.contest.updateMany({
      where: { id: contestId, status: ContestStatus.DRAFT },
      data: { status: ContestStatus.ACTIVE, ...seedData(summary.kind) },
    });
    if (changed.count !== 1) throw new ConflictException('Опубликовать можно только черновик');
    return this.get(contestId);
  }

  /** ACTIVE → CANCELLED. Entries stay for the record; nothing is paid. */
  public async cancel(contestId: string): Promise<ContestSummary> {
    const changed = await this.prismaService.contest.updateMany({
      where: { id: contestId, status: ContestStatus.ACTIVE },
      data: { status: ContestStatus.CANCELLED },
    });
    if (changed.count !== 1) {
      const exists = await this.prismaService.contest.findUnique({ where: { id: contestId }, select: { id: true } });
      if (exists === null) throw new NotFoundException('Contest not found');
      throw new ConflictException('Отменить можно только идущий конкурс');
    }
    return this.get(contestId);
  }

  /**
   * Enter, on behalf of the person the caller has already authenticated.
   *
   * Refusals are refusals of THIS person: outside the audience, not in the
   * channel, or the contest is not open. They are answered rather than
   * thrown, because the cabinet shows them as text next to the button, not
   * as an error page.
   *
   * `channelMember` is the cabinet's answer from Telegram — this side has no
   * bot token. `true` and `false` are Telegram's; `null` means it could not
   * be asked (an outage, a bot that is not an admin of the channel) and lets
   * the person in, the same rule «Канал обязателен» follows; ABSENT means a
   * cabinet that does not know about channels at all, and refuses — a
   * condition the operator set is not waived by an old image.
   */
  public async enter(input: {
    readonly contestId: string;
    readonly userId: string;
    readonly channelMember?: boolean | null;
    readonly now?: Date;
  }): Promise<{ readonly entered: boolean; readonly reason: EntryRefusal | null }> {
    const now = input.now ?? new Date();
    const contest = await this.prismaService.contest.findUnique({
      where: { id: input.contestId },
      select: {
        status: true,
        startAt: true,
        endAt: true,
        audienceFilter: true,
        maxEntries: true,
        channelChatId: true,
        kind: true,
      },
    });
    if (contest === null) throw new NotFoundException('Contest not found');
    // Nobody enters a leaderboard: everybody in the audience is on it.
    if (contest.kind === ContestKind.LEADERBOARD) return { entered: false, reason: 'AUTOMATIC' };

    // Somebody already in is answered as in, whatever has changed since —
    // the second tap on the button, a channel left after entering, a full
    // contest. Telling them otherwise reads as being thrown out.
    const mine = await this.prismaService.contestEntry.findUnique({
      where: { contestId_userId: { contestId: input.contestId, userId: input.userId } },
      select: { id: true },
    });
    if (mine !== null) return { entered: true, reason: null };

    const closed = readClosedReason(contest, now);
    if (closed !== null) return { entered: false, reason: closed };

    if (!(await this.isEligible(contest.audienceFilter, input.userId))) {
      return { entered: false, reason: 'NOT_ELIGIBLE' };
    }

    if (contest.channelChatId !== null) {
      const person = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { telegramId: true },
      });
      if (person?.telegramId == null) return { entered: false, reason: 'NEEDS_TELEGRAM' };
      if (input.channelMember === undefined || input.channelMember === false) {
        return { entered: false, reason: 'CHANNEL_REQUIRED' };
      }
      if (input.channelMember === null) {
        this.logger.warn(
          `Contest ${input.contestId}: channel membership of user ${input.userId} could not be checked; let in`,
        );
      }
    }

    if (contest.maxEntries !== null) {
      const taken = await this.prismaService.contestEntry.count({ where: { contestId: input.contestId } });
      if (taken >= contest.maxEntries) return { entered: false, reason: 'FULL' };
    }

    try {
      await this.prismaService.contestEntry.create({
        data: { contestId: input.contestId, userId: input.userId },
      });
      return { entered: true, reason: null };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Already in. Not a refusal — the person asked to be in, and they are.
        return { entered: true, reason: null };
      }
      throw error;
    }
  }

  /**
   * Finish a contest that is over: draw it, or rank it.
   *
   * `random` is injectable for the same reason the wheel's is: a draw whose
   * source of chance is baked in cannot be tested for the thing that matters.
   *
   * A leaderboard is ranked BEFORE the transaction — a read over payments,
   * referrals, the points ledger or the traffic counters, and for payments a
   * currency conversion that may have to ask for a rate. Nothing it reads can
   * change any more: the window has closed. The transaction then does what a
   * draw's does, on the same conditional stamp.
   */
  public async draw(input: {
    readonly contestId: string;
    readonly now?: Date;
    readonly random?: () => number;
  }): Promise<DrawResult> {
    const now = input.now ?? new Date();
    const synced: string[] = [];

    const terms = await this.prismaService.contest.findUnique({
      where: { id: input.contestId },
      select: TERMS_SELECT,
    });
    if (terms === null) throw new NotFoundException('Contest not found');
    if (terms.status === ContestStatus.DRAWN) return { drawn: false, reason: 'ALREADY_DRAWN' };
    if (terms.status !== ContestStatus.ACTIVE) return { drawn: false, reason: 'NOT_ACTIVE' };
    if (terms.endAt.getTime() > now.getTime()) return { drawn: false, reason: 'NOT_OVER' };

    let ranked: readonly Standing[] | null = null;
    if (terms.kind === ContestKind.LEADERBOARD) {
      if (terms.metric === ContestMetric.TRAFFIC && !(terms.trafficReadAt !== null && terms.trafficReadAt >= terms.endAt)) {
        // The last reading has to come after the end, or the last hours of
        // use are not on the board. It is taken every minute while this one
        // waits; past the grace, the wait is the operator's to know about.
        if (now.getTime() - terms.endAt.getTime() < TRAFFIC_GRACE_MS) return { drawn: false, reason: 'AWAITING_TRAFFIC' };
        throw new Error('Remnawave не отдаёт трафик: без замера после окончания итоги рейтинга не подвести');
      }
      if (this.standings === undefined) throw new Error('Leaderboard standings are not wired');
      ranked = await this.standings.rank({ id: input.contestId, ...terms }, now);
    }
    const zone = terms.repeatMonthly ? await this.readZone() : 'UTC';

    const result = await this.prismaService.$transaction(
      async (tx): Promise<DrawResult> => {
        const contest = await tx.contest.findUnique({
          where: { id: input.contestId },
          select: TERMS_SELECT,
        });
        if (contest === null) throw new NotFoundException('Contest not found');
        if (contest.status === ContestStatus.DRAWN) return { drawn: false, reason: 'ALREADY_DRAWN' };
        if (contest.status !== ContestStatus.ACTIVE) return { drawn: false, reason: 'NOT_ACTIVE' };
        if (contest.endAt.getTime() > now.getTime()) return { drawn: false, reason: 'NOT_OVER' };

        const places = expandPlaces(contest.prizes);
        let picked: { readonly userId: string; readonly score: bigint | null }[];
        let entrants: number;
        let totalTickets: number | null = null;
        let drawnTickets: { readonly userIds: readonly string[]; readonly tickets: ReadonlyMap<string, number> } | null = null;

        if (ranked !== null) {
          // The places go down the board to those at or above the threshold
          // — a prefix of it, the board being sorted by score.
          const qualified = ranked.filter((row) => contest.minScore === null || row.score >= contest.minScore);
          picked = qualified.slice(0, places.length).map((row) => ({ userId: row.userId, score: row.score }));
          entrants = ranked.length;
        } else {
          const entries = await tx.contestEntry.findMany({
            where: { contestId: input.contestId },
            select: { userId: true },
          });
          const userIds = entries.map((entry) => entry.userId);
          const tickets = await countTickets(tx, contest, userIds);
          totalTickets = userIds.reduce((sum, userId) => sum + (tickets.get(userId) ?? 1), 0);
          entrants = userIds.length;
          drawnTickets = { userIds, tickets };

          // Seeded, never `Math.random`.
          //
          // A draw that throws part way through rolls back to ACTIVE and the
          // sweep tries again a minute later. With a fresh source of chance
          // each time, every retry would pick a DIFFERENT field of winners — a
          // contest whose second prize cannot be paid would quietly re-roll
          // until it found a set that could be, which is not a draw, it is a
          // search. Seeded, the retry reproduces the same winners and either
          // pays them or keeps failing visibly. The seed is made at publish and
          // shown once the draw has run; a contest published before seeds
          // existed draws from its id, as it always did.
          const random = input.random ?? seededRandom(contest.drawSeed ?? input.contestId);
          picked = drawWeightedWinners({
            entrants: userIds.map((userId) => ({ id: userId, tickets: tickets.get(userId) ?? 1 })),
            count: places.length,
            random,
          }).map((userId) => ({ userId, score: null }));
        }

        // The stamp goes before any payout and is conditional on ACTIVE, so
        // two sweeps racing for the same contest cannot both finish it. The
        // loser's transaction has nothing left to do.
        const stamped = await tx.contest.updateMany({
          where: { id: input.contestId, status: ContestStatus.ACTIVE },
          data: {
            status: ContestStatus.DRAWN,
            drawnAt: now,
            drawnEntries: entrants,
            drawnTickets: totalTickets,
            drawError: null,
            drawErrorAt: null,
          },
        });
        if (stamped.count !== 1) return { drawn: false, reason: 'ALREADY_DRAWN' };

        if (ranked !== null) await recordStandings(tx, input.contestId, ranked);
        if (drawnTickets !== null) await recordTickets(tx, input.contestId, drawnTickets.userIds, drawnTickets.tickets);

        for (const [index, winner] of picked.entries()) {
          const syncSubscriptionId = await this.award(tx, {
            contestId: input.contestId,
            userId: winner.userId,
            prize: places[index] as PrizeRow,
            place: index + 1,
            score: winner.score,
            delivery: contest.prizeDelivery,
          });
          if (syncSubscriptionId !== null) synced.push(syncSubscriptionId);
        }

        const repeatedBy = contest.repeatMonthly ? await repeatForAMonth(tx, input.contestId, contest, zone, now) : null;

        this.logger.log(
          `Contest ${input.contestId} finished: ${picked.length} winner(s) from ${entrants}` +
            (totalTickets === null ? ' ranked' : ` entrant(s), ${totalTickets} ticket(s)`) +
            (repeatedBy === null ? '' : `; repeats as ${repeatedBy}`),
        );
        return { drawn: true, winners: picked.length, entrants, tickets: totalTickets, repeatedBy };
      },
      // Up to a hundred places, each a create, a payout and an update, and a
      // leaderboard's thousands of rows besides — that does not fit Prisma's
      // five-second default, and running out of time rolls the whole thing
      // back onto a sweep that will simply run out of time again.
      { maxWait: 15_000, timeout: 120_000 },
    );

    // After the commit, never inside it: a sync job enqueued in a transaction
    // announces a change a rollback then undoes.
    for (const subscriptionId of new Set(synced)) {
      await this.profileSyncQueue
        ?.enqueueSubscriptionSync(subscriptionId, { source: 'CONTEST_PRIZE', contestId: input.contestId })
        .catch((err: unknown) => {
          this.logger.error(
            `Contest ${input.contestId} prize changed subscription ${subscriptionId}, but its sync could not be queued: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
    return result;
  }

  /**
   * Say on the contest why its draw failed, so the panel can show it.
   *
   * The draw rolls back whole and the sweep retries every minute; the reason
   * used to live only in the log, and the operator saw «Ожидает розыгрыша»
   * for ever. Returns whether this is NEWS — no reason recorded yet, or a
   * different one — so the caller raises an operator event once, not sixty
   * times an hour.
   */
  public async recordDrawFailure(contestId: string, error: unknown, now = new Date()): Promise<boolean> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const current = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { drawError: true },
    });
    if (current === null) return false;
    await this.prismaService.contest.updateMany({
      where: { id: contestId, status: ContestStatus.ACTIVE },
      data: { drawError: message, drawErrorAt: now },
    });
    return current.drawError !== message;
  }

  /** Every ACTIVE contest whose end has passed. The sweep's list. */
  public async listDue(now = new Date(), batch = 20): Promise<readonly string[]> {
    const rows = await this.prismaService.contest.findMany({
      where: { status: ContestStatus.ACTIVE, endAt: { lte: now } },
      orderBy: { endAt: 'asc' },
      take: batch,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Who entered, newest first, with their tickets: as the draw counted them
   * once it has run, as it would count them now before that.
   */
  public async listEntrants(
    contestId: string,
    page: { readonly take: number; readonly skip: number },
  ): Promise<{ readonly total: number; readonly rows: readonly ContestEntrantRow[] }> {
    const contest = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { status: true, startAt: true, endAt: true, ticketsPerPurchase: true, ticketsPerReferral: true, maxTicketsPerUser: true },
    });
    if (contest === null) throw new NotFoundException('Contest not found');
    const [total, entries] = await Promise.all([
      this.prismaService.contestEntry.count({ where: { contestId } }),
      this.prismaService.contestEntry.findMany({
        where: { contestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        skip: page.skip,
        select: {
          userId: true,
          createdAt: true,
          tickets: true,
          user: { select: { name: true, username: true, telegramId: true } },
        },
      }),
    ]);
    const live =
      contest.status === ContestStatus.DRAWN
        ? new Map<string, number>()
        : await countTickets(this.prismaService, contest, entries.map((entry) => entry.userId));
    return {
      total,
      rows: entries.map((entry) => ({
        userId: entry.userId,
        name: entry.user.name,
        username: entry.user.username,
        telegramId: entry.user.telegramId === null ? null : entry.user.telegramId.toString(),
        enteredAt: entry.createdAt.toISOString(),
        tickets: entry.tickets ?? live.get(entry.userId) ?? 1,
      })),
    };
  }

  /** One person's tickets in one contest, as the draw would count them now. */
  public async ticketsOf(
    contest: { readonly startAt: Date; readonly endAt: Date } & ContestTicketRules,
    userId: string,
  ): Promise<number> {
    const tickets = await countTickets(this.prismaService, contest, [userId]);
    return tickets.get(userId) ?? 1;
  }

  /**
   * A leaderboard's places for the operator, best first: live while it runs,
   * as the end counted them once it has.
   */
  public async listStandings(
    contestId: string,
    page: { readonly take: number; readonly skip: number },
    now = new Date(),
  ): Promise<{ readonly total: number; readonly rows: readonly ContestStandingRow[] }> {
    const contest = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { id: true, status: true, kind: true, metric: true, startAt: true, endAt: true, audienceFilter: true },
    });
    if (contest === null) throw new NotFoundException('Contest not found');
    if (contest.kind !== ContestKind.LEADERBOARD) return { total: 0, rows: [] };

    if (contest.status === ContestStatus.DRAWN) {
      const where = { contestId, rank: { not: null } };
      const [total, entries] = await Promise.all([
        this.prismaService.contestEntry.count({ where }),
        this.prismaService.contestEntry.findMany({
          where,
          orderBy: { rank: 'asc' },
          take: page.take,
          skip: page.skip,
          select: {
            userId: true,
            rank: true,
            score: true,
            user: { select: { name: true, username: true, telegramId: true } },
          },
        }),
      ]);
      return {
        total,
        rows: entries.map((entry) => ({
          rank: entry.rank ?? 0,
          userId: entry.userId,
          name: entry.user.name,
          username: entry.user.username,
          telegramId: entry.user.telegramId === null ? null : entry.user.telegramId.toString(),
          score: Number(entry.score ?? 0n),
        })),
      };
    }

    const standings = await this.liveStandings(contest, now);
    const slice = standings.slice(page.skip, page.skip + page.take);
    const people = await this.people(slice.map((row) => row.userId));
    return {
      total: standings.length,
      rows: slice.map((row, index) => {
        const person = people.get(row.userId);
        return {
          rank: page.skip + index + 1,
          userId: row.userId,
          name: person?.name ?? null,
          username: person?.username ?? null,
          telegramId: person?.telegramId ?? null,
          score: Number(row.score),
        };
      }),
    };
  }

  /**
   * A leaderboard as one person sees it: the top `leaderboardSize`, their own
   * place and score, and how far they are from the last prize place. Names
   * come unmasked; masking is the caller's, who knows who is looking.
   */
  public async leaderboardFor(
    contest: {
      readonly id: string;
      readonly status: ContestStatus;
      readonly kind: ContestKind;
      readonly metric: ContestMetric | null;
      readonly startAt: Date;
      readonly endAt: Date;
      readonly audienceFilter: Prisma.JsonValue | null;
      readonly leaderboardSize: number;
      readonly minScore: bigint | null;
      readonly prizes: readonly Pick<PrizeRow, 'place' | 'placeTo'>[];
    },
    userId: string | null,
    now = new Date(),
  ): Promise<LeaderboardView> {
    const currency = this.baseCurrency();
    if (contest.status === ContestStatus.DRAWN) {
      // The end wrote the board down: read the top and this one row, not the
      // thousands in between.
      const [entries, mineRow, total] = await Promise.all([
        this.prismaService.contestEntry.findMany({
          where: { contestId: contest.id, rank: { not: null, lte: contest.leaderboardSize } },
          orderBy: { rank: 'asc' },
          select: { userId: true, score: true, rank: true, user: { select: { name: true, username: true } } },
        }),
        userId === null
          ? Promise.resolve(null)
          : this.prismaService.contestEntry.findUnique({
              where: { contestId_userId: { contestId: contest.id, userId } },
              select: { rank: true, score: true },
            }),
        this.prismaService.contestEntry.count({ where: { contestId: contest.id, rank: { not: null } } }),
      ]);
      return {
        top: entries.map((entry) => ({
          rank: entry.rank ?? 0,
          userId: entry.userId,
          name: entry.user.name,
          username: entry.user.username,
          score: Number(entry.score ?? 0n),
        })),
        total,
        mine: mineRow?.rank == null ? null : { rank: mineRow.rank, score: Number(mineRow.score ?? 0n) },
        toPrize: null,
        currency,
      };
    }

    const board = await this.liveStandings(contest, now);
    const top = board.slice(0, contest.leaderboardSize);
    const people = await this.people(top.map((row) => row.userId));
    const index = userId === null ? -1 : board.findIndex((row) => row.userId === userId);
    const mine = index < 0 ? null : { rank: index + 1, score: Number((board[index] as Standing).score) };
    return {
      top: top.map((row, position) => ({
        rank: position + 1,
        userId: row.userId,
        name: people.get(row.userId)?.name ?? null,
        username: people.get(row.userId)?.username ?? null,
        score: Number(row.score),
      })),
      total: board.length,
      mine,
      toPrize: userId === null ? null : readGapToPrize(board, index, countPlaces(contest.prizes), contest.minScore),
      currency,
    };
  }

  private async liveStandings(contest: Parameters<ContestStandingsService['live']>[0], now: Date): Promise<readonly Standing[]> {
    if (this.standings === undefined) return [];
    return this.standings.live(contest, now);
  }

  private async people(
    userIds: readonly string[],
  ): Promise<Map<string, { readonly name: string | null; readonly username: string | null; readonly telegramId: string | null }>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prismaService.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true, username: true, telegramId: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { name: row.name, username: row.username, telegramId: row.telegramId === null ? null : row.telegramId.toString() },
      ]),
    );
  }

  /** The project's clock, for the dates a monthly repeat lands on. */
  private async readZone(): Promise<string> {
    const settings = await this.prismaService.settings
      .findUnique({ where: { id: 1 }, select: { platformPolicy: true } })
      .catch(() => null);
    return safeZone(readPlatformBranding(settings?.platformPolicy ?? null).timezone);
  }

  /**
   * Pays one place — or holds it for an operator — and returns the
   * subscription it changed, for the caller to push to Remnawave after the
   * commit.
   *
   * Held (the contest's «Выдача призов» is REVIEW or SUPPORT): the winner row
   * is written PENDING and `heldForReview`, and nothing is paid until the
   * operator's «Выдать». A MANUAL prize is never «held»: a human hands it over
   * whatever the setting, through the support thread, as before.
   */
  private async award(
    tx: Prisma.TransactionClient,
    input: {
      readonly contestId: string;
      readonly userId: string;
      readonly prize: PrizeRow;
      readonly place: number;
      readonly score: bigint | null;
      readonly delivery: ContestPrizeDelivery;
    },
  ): Promise<string | null> {
    const { prize } = input;
    const held = input.delivery !== ContestPrizeDelivery.AUTO && prize.kind !== WheelSectorKind.MANUAL;
    // The winner row is written first so the payout has an id to hang the
    // journal rows and a claimed key on. Its status is corrected right after,
    // in the same transaction.
    const winner = await tx.contestWinner.create({
      data: {
        contestId: input.contestId,
        userId: input.userId,
        prizeId: prize.id,
        place: input.place,
        score: input.score,
        heldForReview: held,
        // The whole prize, not just its face: a held prize is paid from this
        // later, and the place it was won at is the one that counts.
        prizeSnapshot: {
          id: prize.id,
          place: input.place,
          kind: prize.kind,
          title: (prize.title ?? {}) as Prisma.InputJsonValue,
          amount: prize.amount,
          promoRewardType: prize.promoRewardType,
          promoPlanId: prize.promoPlanId,
          promoPlanIds: [...prize.promoPlanIds],
          promoLifetime: prize.promoLifetime,
          keyPoolId: prize.keyPoolId,
          manualInstructions: prize.manualInstructions,
        },
        kind: prize.kind,
        status: WheelSpinStatus.PENDING,
      },
      select: { id: true },
    });
    if (held) return null;

    const paid = await this.payout.payOut(tx, {
      userId: input.userId,
      prize: { ...prize, promoPlanIds: prize.promoPlanIds },
      origin: {
        source: 'CONTEST',
        referenceKey: `contest:${winner.id}`,
        details: { contestId: input.contestId, winnerId: winner.id, place: input.place },
      },
    });

    await tx.contestWinner.update({
      where: { id: winner.id },
      data: {
        status: paid.status,
        ...(paid.outcome === null ? {} : { outcome: paid.outcome }),
        ...(paid.status === WheelSpinStatus.PENDING ? {} : { settledAt: new Date() }),
      },
    });
    if (paid.keyId !== null) {
      await tx.wheelKey.update({ where: { id: paid.keyId }, data: { claimedWinnerId: winner.id } });
    }
    return paid.syncSubscriptionId;
  }

  /**
   * Which of these contests this person may actually enter.
   *
   * The cabinet needs this to decide whether to offer the button at all:
   * showing "Участвовать" to somebody the audience filter excludes and
   * answering the tap with a refusal is a worse screen than not offering it.
   * One query for the whole page rather than one per contest.
   */
  public async eligibleAmong(
    userId: string,
    contests: readonly { readonly id: string; readonly audienceFilter: Prisma.JsonValue | null }[],
  ): Promise<ReadonlySet<string>> {
    const eligible = new Set<string>();
    if (contests.length === 0) return eligible;

    const blocked = await this.prismaService.user.count({
      where: { id: userId, isBlocked: false },
    });
    if (blocked === 0) return eligible;

    // Contests with no filter at all are open to anybody who is not blocked,
    // and they are the common case — they cost no query.
    const filtered: { id: string; where: Prisma.UserWhereInput }[] = [];
    for (const contest of contests) {
      const filter = normalizeAudienceFilter(contest.audienceFilter);
      if (filter === null) {
        eligible.add(contest.id);
        continue;
      }
      filtered.push({ id: contest.id, where: buildAudienceWhere(BroadcastAudience.ALL, filter) });
    }

    for (const item of filtered) {
      const count = await this.prismaService.user.count({
        where: { AND: [{ id: userId }, { isBlocked: false }, item.where] },
      });
      if (count > 0) eligible.add(item.id);
    }
    return eligible;
  }

  private async isEligible(audienceFilter: Prisma.JsonValue | null, userId: string): Promise<boolean> {
    const filter = normalizeAudienceFilter(audienceFilter);
    // A blocked person is never eligible, whatever the filter says — the same
    // rule quests and broadcasts follow.
    const where = filter === null ? {} : buildAudienceWhere(BroadcastAudience.ALL, filter);
    const count = await this.prismaService.user.count({
      where: { AND: [{ id: userId }, { isBlocked: false }, where] },
    });
    return count > 0;
  }
}

/** Why a person may not enter right now. */
export type EntryRefusal =
  | 'NOT_OPEN'
  | 'NOT_STARTED'
  | 'ENDED'
  | 'NOT_ELIGIBLE'
  | 'FULL'
  /** The contest needs a channel subscription and Telegram says there is none. */
  | 'CHANNEL_REQUIRED'
  /** The contest needs a channel subscription and the account has no Telegram to check. */
  | 'NEEDS_TELEGRAM'
  /** A leaderboard: there is nothing to enter, everybody in the audience counts. */
  | 'AUTOMATIC';

export function readClosedReason(
  contest: { readonly status: ContestStatus; readonly startAt: Date; readonly endAt: Date },
  now: Date,
): EntryRefusal | null {
  if (contest.status !== ContestStatus.ACTIVE) return 'NOT_OPEN';
  if (contest.startAt.getTime() > now.getTime()) return 'NOT_STARTED';
  if (contest.endAt.getTime() <= now.getTime()) return 'ENDED';
  return null;
}

/**
 * The end a live contest's edit asks for: `null` to keep it, the new end to
 * move it later. Earlier is refused, and so is a "later" that has already
 * passed — that would not extend anything, it would end the contest now.
 */
export function readExtendedEnd(current: Date, requested: Date, now: Date): Date | null {
  // The panel's date field holds minutes. An end stored with seconds comes
  // back from it up to a minute "earlier", and fixing a typo in the title
  // must not be refused as moving the end.
  if (Math.abs(requested.getTime() - current.getTime()) < 60_000) return null;
  if (requested.getTime() < current.getTime()) {
    throw new BadRequestException('Окончание идущего конкурса можно только перенести на более позднее время');
  }
  if (requested.getTime() <= now.getTime()) {
    throw new BadRequestException('Новое окончание уже прошло');
  }
  return requested;
}

/**
 * Tickets per person: one for entering, plus the contest's rate for each
 * paid purchase and each friend who paid, inside the window — up to the
 * ceiling. Counted from the payments and the referrals themselves, so a
 * refund before the draw takes its ticket back with it.
 *
 * A purchase is a completed payment of more than nothing. A friend is a
 * direct referral (level 1) whose first qualifying payment fell inside the
 * window — a registration alone is free to fake, a payment is not.
 */
export async function countTickets(
  db: Prisma.TransactionClient | PrismaService,
  contest: { readonly startAt: Date; readonly endAt: Date } & ContestTicketRules,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const tickets = new Map<string, number>(userIds.map((userId) => [userId, 1]));
  if (userIds.length === 0 || (contest.ticketsPerPurchase <= 0 && contest.ticketsPerReferral <= 0)) {
    return tickets;
  }
  const window = { gte: contest.startAt, lte: contest.endAt };
  const ids = [...new Set(userIds)];

  if (contest.ticketsPerPurchase > 0) {
    const purchases = await db.transaction.groupBy({
      by: ['userId'],
      where: { userId: { in: ids }, status: TransactionStatus.COMPLETED, amount: { gt: 0 }, createdAt: window },
      _count: { _all: true },
    });
    for (const row of purchases) {
      tickets.set(row.userId, (tickets.get(row.userId) ?? 1) + row._count._all * contest.ticketsPerPurchase);
    }
  }
  if (contest.ticketsPerReferral > 0) {
    const friends = await db.referral.groupBy({
      by: ['referrerId'],
      where: { referrerId: { in: ids }, level: 1, qualifiedAt: window },
      _count: { _all: true },
    });
    for (const row of friends) {
      tickets.set(row.referrerId, (tickets.get(row.referrerId) ?? 1) + row._count._all * contest.ticketsPerReferral);
    }
  }
  if (contest.maxTicketsPerUser !== null) {
    const ceiling = Math.max(1, contest.maxTicketsPerUser);
    for (const [userId, count] of tickets) tickets.set(userId, Math.min(count, ceiling));
  }
  return tickets;
}

/**
 * The tickets the draw counted, written onto the entries — one statement per
 * distinct count rather than one per person, because a contest is thousands
 * of entries and a handful of counts.
 */
async function recordTickets(
  tx: Prisma.TransactionClient,
  contestId: string,
  entrants: readonly string[],
  tickets: ReadonlyMap<string, number>,
): Promise<void> {
  const byCount = new Map<number, string[]>();
  for (const userId of entrants) {
    const count = tickets.get(userId) ?? 1;
    const group = byCount.get(count) ?? [];
    group.push(userId);
    byCount.set(count, group);
  }
  for (const [count, userIds] of byCount) {
    await tx.contestEntry.updateMany({ where: { contestId, userId: { in: userIds } }, data: { tickets: count } });
  }
}

/**
 * What would stop this contest being published: the same per-prize checks
 * the wheel applies to a sector, plus the things a contest has that a sector
 * does not — a window, places from the first with no gap and no overlap, a
 * channel that has both halves, and for a leaderboard something to rank by.
 */
export function readContestProblems(input: {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly channelChatId?: string | null;
  readonly channelJoinUrl?: string | null;
  readonly kind?: ContestKind;
  readonly metric?: ContestMetric | null;
  readonly prizes: readonly (Pick<PrizeRow, 'place' | 'kind' | 'amount' | 'keyPoolId' | 'promoRewardType' | 'promoPlanId' | 'promoLifetime' | 'manualInstructions'> & {
    readonly placeTo?: number | null;
  })[];
}): readonly string[] {
  const problems: string[] = [];
  if (input.prizes.length === 0) problems.push('Нужен хотя бы один приз');
  if (input.endAt.getTime() <= input.startAt.getTime()) problems.push('Конец должен быть позже начала');
  if ((input.channelChatId ?? null) === null !== ((input.channelJoinUrl ?? null) === null)) {
    problems.push('Канал: нужны и ссылка, и то, по чему его проверять');
  }
  if (input.kind === ContestKind.LEADERBOARD && (input.metric ?? null) === null) {
    problems.push('Рейтинг: выберите, по чему считать места');
  }

  // Each prize covers [place, placeTo]; together they must cover 1…N once.
  let next = 1;
  let gapless = true;
  for (const prize of [...input.prizes].sort((a, b) => a.place - b.place)) {
    const last = prize.placeTo ?? prize.place;
    if (prize.place !== next || last < prize.place) {
      gapless = false;
      break;
    }
    next = last + 1;
  }
  if (!gapless) {
    problems.push('Места должны идти подряд, начиная с первого');
  } else if (next - 1 > MAX_PLACES) {
    problems.push(`Призовых мест больше ${MAX_PLACES}`);
  }

  for (const prize of input.prizes) {
    if (prize.kind === WheelSectorKind.NOTHING) {
      // A place that gives nothing is not a prize; it is a person told they
      // won and handed nothing.
      problems.push(`Место ${prize.place}: приз не может быть «не повезло»`);
      continue;
    }
    for (const problem of validateSector({
      kind: prize.kind,
      weight: 1,
      amount: prize.amount,
      keyPoolId: prize.keyPoolId,
      promoRewardType: prize.promoRewardType,
      promoPlanId: prize.promoPlanId,
      promoLifetime: prize.promoLifetime,
      manualInstructions: prize.manualInstructions,
      maxWinsPerUser: null,
      maxWinsTotal: null,
    })) {
      problems.push(`Место ${prize.place}: ${problem.message}`);
    }
  }
  return problems;
}

function assertPrizesValid(prizes: readonly ContestPrizeInput[]): void {
  const seen = new Set<number>();
  for (const prize of prizes) {
    if (!Number.isInteger(prize.place) || prize.place < 1) {
      throw new BadRequestException('Место приза — целое число от единицы');
    }
    if (prize.placeTo !== null && (!Number.isInteger(prize.placeTo) || prize.placeTo < prize.place)) {
      throw new BadRequestException(`Место ${prize.place}: «до места» не может быть меньше «с места»`);
    }
    if (seen.has(prize.place)) throw new BadRequestException(`Место ${prize.place} указано дважды`);
    seen.add(prize.place);
  }
}

/** The prize for each place, first place first: a range is counted out place by place. */
export function expandPlaces<T extends Pick<PrizeRow, 'place' | 'placeTo'>>(prizes: readonly T[]): T[] {
  const places: T[] = [];
  for (const prize of [...prizes].sort((a, b) => a.place - b.place)) {
    for (let place = prize.place; place <= (prize.placeTo ?? prize.place); place += 1) places.push(prize);
  }
  return places;
}

export function countPlaces(prizes: readonly Pick<PrizeRow, 'place' | 'placeTo'>[]): number {
  return prizes.reduce((sum, prize) => sum + Math.max(0, (prize.placeTo ?? prize.place) - prize.place + 1), 0);
}

/**
 * How much more score takes the last prize place: 0 for somebody holding one,
 * `null` when no place is on offer.
 *
 * To take a place from the person holding it, a score has to BEAT theirs — a
 * tie goes to whoever got there first, and that is never the one catching up.
 * With fewer people on the board than places, the threshold is all it takes.
 */
export function readGapToPrize(
  board: readonly { readonly score: bigint }[],
  index: number,
  places: number,
  minScore: bigint | null,
): number | null {
  if (places <= 0) return null;
  const threshold = minScore !== null && minScore > 0n ? minScore : 1n;
  const own = index >= 0 ? (board[index] as { score: bigint }).score : 0n;
  if (index >= 0 && index < places && own >= threshold) return 0;
  let lastHeld: bigint | null = null;
  let held = 0;
  for (const [position, row] of board.entries()) {
    if (position === index) continue;
    if (row.score < threshold) break;
    held += 1;
    if (held === places) {
      lastHeld = row.score;
      break;
    }
  }
  const needed = lastHeld === null ? threshold : lastHeld + 1n > threshold ? lastHeld + 1n : threshold;
  const gap = needed - own;
  return Number(gap > 0n ? gap : 0n);
}

/** A leaderboard's final board, one entry per person ranked, in chunks. */
async function recordStandings(
  tx: Prisma.TransactionClient,
  contestId: string,
  ranked: readonly Standing[],
): Promise<void> {
  for (let start = 0; start < ranked.length; start += 5_000) {
    await tx.contestEntry.createMany({
      data: ranked.slice(start, start + 5_000).map((row, offset) => ({
        contestId,
        userId: row.userId,
        score: row.score,
        rank: start + offset + 1,
      })),
      skipDuplicates: true,
    });
  }
}

/**
 * The next month of a monthly contest: the same terms and prizes, from this
 * one's end to the same moment a calendar month later on the project's clock.
 * A contest finished so late that a whole month has passed starts from the
 * last boundary that has, not in the past.
 */
async function repeatForAMonth(
  tx: Prisma.TransactionClient,
  contestId: string,
  contest: ContestTerms,
  zone: string,
  now: Date,
): Promise<string> {
  let startAt = contest.endAt;
  let endAt = addCalendarMonth(startAt, zone);
  while (endAt.getTime() <= now.getTime()) {
    startAt = endAt;
    endAt = addCalendarMonth(endAt, zone);
  }
  const created = await tx.contest.create({
    data: {
      title: contest.title as Prisma.InputJsonValue,
      description: contest.description as Prisma.InputJsonValue,
      status: ContestStatus.ACTIVE,
      startAt,
      endAt,
      audienceFilter: contest.audienceFilter === null ? Prisma.JsonNull : (contest.audienceFilter as Prisma.InputJsonValue),
      maxEntries: contest.maxEntries,
      order: contest.order,
      createdBy: contest.createdBy,
      announce: contest.announce,
      ticketsPerPurchase: contest.ticketsPerPurchase,
      ticketsPerReferral: contest.ticketsPerReferral,
      maxTicketsPerUser: contest.maxTicketsPerUser,
      channelChatId: contest.channelChatId,
      channelJoinUrl: contest.channelJoinUrl,
      kind: contest.kind,
      metric: contest.metric,
      minScore: contest.minScore,
      leaderboardSize: contest.leaderboardSize,
      prizeDelivery: contest.prizeDelivery,
      repeatMonthly: true,
      repeatOf: { connect: { id: contestId } },
      ...seedData(contest.kind),
      prizes: {
        create: contest.prizes.map((prize) => toPrizeData({ ...prize, title: prize.title as Prisma.InputJsonValue })),
      },
    },
    select: { id: true },
  });
  return created.id;
}

/** A draw's source of chance, made when it goes live. A leaderboard has none. */
function seedData(kind: ContestKind): { drawSeed?: string; drawSeedHash?: string } {
  if (kind !== ContestKind.DRAW) return {};
  const seed = newDrawSeed();
  return { drawSeed: seed, drawSeedHash: hashDrawSeed(seed) };
}

/**
 * The terms a draft carries, as columns. A leaderboard has nobody entering,
 * so what governs entering — a ceiling, tickets, a channel — is cleared on
 * it rather than kept as a setting that does nothing.
 */
function termsData(input: ContestInput): Omit<Prisma.ContestCreateInput, 'prizes' | 'createdBy'> {
  const ranked = input.kind === ContestKind.LEADERBOARD;
  return {
    title: input.title,
    description: input.description,
    startAt: input.startAt,
    endAt: input.endAt,
    audienceFilter: input.audienceFilter ?? Prisma.JsonNull,
    maxEntries: ranked ? null : input.maxEntries,
    announce: input.announce,
    ticketsPerPurchase: ranked ? 0 : input.ticketsPerPurchase,
    ticketsPerReferral: ranked ? 0 : input.ticketsPerReferral,
    maxTicketsPerUser: ranked ? null : input.maxTicketsPerUser,
    channelChatId: ranked ? null : (input.channel?.chatId ?? null),
    channelJoinUrl: ranked ? null : (input.channel?.joinUrl ?? null),
    kind: input.kind,
    metric: ranked ? input.metric : null,
    minScore: ranked && input.minScore !== null && input.minScore > 0 ? BigInt(input.minScore) : null,
    leaderboardSize: input.leaderboardSize,
    prizeDelivery: input.prizeDelivery,
    repeatMonthly: input.repeatMonthly,
  };
}

function toPrizeData(prize: ContestPrizeInput): Prisma.ContestPrizeCreateWithoutContestInput {
  return {
    place: prize.place,
    placeTo: prize.placeTo !== null && prize.placeTo > prize.place ? prize.placeTo : null,
    kind: prize.kind,
    title: prize.title,
    amount: prize.amount,
    promoRewardType: prize.promoRewardType,
    promoPlanId: prize.promoPlanId,
    promoPlanIds: [...prize.promoPlanIds],
    promoLifetime: prize.promoLifetime,
    manualInstructions: prize.manualInstructions,
    ...(prize.keyPoolId === null ? {} : { keyPool: { connect: { id: prize.keyPoolId } } }),
  };
}

function toSummary(row: ContestRow, currency: string, pendingPrizes: number): ContestSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    audienceFilter: row.audienceFilter,
    maxEntries: row.maxEntries,
    drawnAt: row.drawnAt?.toISOString() ?? null,
    drawnEntries: row.drawnEntries,
    drawnTickets: row.drawnTickets,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    entries: row._count.entries,
    winners: row._count.winners,
    announce: row.announce,
    announcedAt: row.announcedAt?.toISOString() ?? null,
    resultsNotifiedAt: row.resultsNotifiedAt?.toISOString() ?? null,
    ticketsPerPurchase: row.ticketsPerPurchase,
    ticketsPerReferral: row.ticketsPerReferral,
    maxTicketsPerUser: row.maxTicketsPerUser,
    channel:
      row.channelChatId === null || row.channelJoinUrl === null
        ? null
        : { chatId: row.channelChatId, joinUrl: row.channelJoinUrl },
    drawSeedHash: row.drawSeedHash,
    drawSeed: row.status === ContestStatus.DRAWN ? row.drawSeed : null,
    drawError: row.drawError,
    drawErrorAt: row.drawErrorAt?.toISOString() ?? null,
    kind: row.kind,
    metric: row.metric,
    minScore: row.minScore === null ? null : Number(row.minScore),
    leaderboardSize: row.leaderboardSize,
    prizeDelivery: row.prizeDelivery,
    repeatMonthly: row.repeatMonthly,
    repeatOfId: row.repeatOfId,
    trafficReadAt: row.trafficReadAt?.toISOString() ?? null,
    places: countPlaces(row.prizes),
    currency,
    pendingPrizes,
    prizes: row.prizes,
    problems: readContestProblems({
      startAt: row.startAt,
      endAt: row.endAt,
      channelChatId: row.channelChatId,
      channelJoinUrl: row.channelJoinUrl,
      kind: row.kind,
      metric: row.metric,
      prizes: row.prizes,
    }),
  };
}
