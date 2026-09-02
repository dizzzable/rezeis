import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BroadcastAudience, ContestStatus, Prisma, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAudienceWhere, normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { PrizePayoutService } from '../../wheel/services/prize-payout.service';
import { validateSector } from '../../wheel-config/wheel-sector-validation.util';
import { drawWinners } from '../contest-draw.util';

const PRIZE_SELECT = {
  id: true,
  place: true,
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
  order: true,
  createdAt: true,
  prizes: { orderBy: { place: 'asc' as const }, select: PRIZE_SELECT },
  _count: { select: { entries: true, winners: true } },
} as const;

type ContestRow = Prisma.ContestGetPayload<{ select: typeof CONTEST_SELECT }>;
export type PrizeRow = Prisma.ContestPrizeGetPayload<{ select: typeof PRIZE_SELECT }>;

export interface ContestPrizeInput {
  readonly place: number;
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

export interface ContestInput {
  readonly title: Prisma.InputJsonValue;
  readonly description: Prisma.InputJsonValue;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly audienceFilter: Prisma.InputJsonValue | null;
  readonly maxEntries: number | null;
  readonly prizes: readonly ContestPrizeInput[];
}

export interface ContestSummary {
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
  readonly order: number;
  readonly createdAt: string;
  readonly entries: number;
  readonly winners: number;
  readonly prizes: readonly PrizeRow[];
  /** Why it cannot be published as it stands. Empty means it can. */
  readonly problems: readonly string[];
}

export type DrawResult =
  | { readonly drawn: true; readonly winners: number; readonly entrants: number }
  /** Not ACTIVE, or not over yet, or already drawn by a concurrent sweep. */
  | { readonly drawn: false; readonly reason: 'NOT_ACTIVE' | 'NOT_OVER' | 'ALREADY_DRAWN' };

/**
 * A contest from draft to draw.
 *
 * ── The draw is one transaction ───────────────────────────────────────────
 *
 * Winners are chosen, every prize is paid or recorded as owed, and the
 * contest is stamped DRAWN — together or not at all. A crash halfway would
 * otherwise leave a contest with three winners paid and two unnamed, and the
 * sweep would happily draw it again with different people.
 *
 * The stamp is a conditional write on ACTIVE: two sweeps racing for the same
 * contest cannot both win it, and the loser reports ALREADY_DRAWN rather than
 * handing out a second set of prizes.
 *
 * ── Entering is one row per person ────────────────────────────────────────
 *
 * The unique index on (contest, user) is the rule. A second entry is refused
 * by the database, not by a read-then-check that a double tap could slip
 * past. The ceiling on entries, where one is set, IS a read-then-check — a
 * count and then an insert — and that is accepted: the failure it allows is
 * a contest closing at 1001 entries instead of 1000, which is not a failure
 * anybody would notice or mind.
 */
@Injectable()
export class ContestService {
  private readonly logger = new Logger(ContestService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly payout: PrizePayoutService,
  ) {}

  public async list(): Promise<readonly ContestSummary[]> {
    const rows = await this.prismaService.contest.findMany({
      orderBy: [{ status: 'asc' }, { endAt: 'desc' }],
      select: CONTEST_SELECT,
    });
    return rows.map((row) => toSummary(row));
  }

  public async get(contestId: string): Promise<ContestSummary> {
    const row = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: CONTEST_SELECT,
    });
    if (row === null) throw new NotFoundException('Contest not found');
    return toSummary(row);
  }

  public async create(input: ContestInput, createdBy: string): Promise<ContestSummary> {
    assertPrizesValid(input.prizes);
    const created = await this.prismaService.contest.create({
      data: {
        title: input.title,
        description: input.description,
        startAt: input.startAt,
        endAt: input.endAt,
        audienceFilter: input.audienceFilter ?? Prisma.JsonNull,
        maxEntries: input.maxEntries,
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
   * dates and audience may not change on a live contest. The title and the
   * description may — a typo is not a term.
   */
  public async update(contestId: string, input: ContestInput): Promise<ContestSummary> {
    const current = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { status: true },
    });
    if (current === null) throw new NotFoundException('Contest not found');

    if (current.status === ContestStatus.DRAFT) {
      assertPrizesValid(input.prizes);
      await this.prismaService.$transaction(async (tx) => {
        await tx.contestPrize.deleteMany({ where: { contestId } });
        await tx.contest.update({
          where: { id: contestId },
          data: {
            title: input.title,
            description: input.description,
            startAt: input.startAt,
            endAt: input.endAt,
            audienceFilter: input.audienceFilter ?? Prisma.JsonNull,
            maxEntries: input.maxEntries,
            prizes: { create: input.prizes.map((prize) => toPrizeData(prize)) },
          },
        });
      });
      return this.get(contestId);
    }

    if (current.status === ContestStatus.ACTIVE) {
      await this.prismaService.contest.update({
        where: { id: contestId },
        data: { title: input.title, description: input.description },
      });
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

  /** DRAFT → ACTIVE, once it is a contest somebody could actually win. */
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

    await this.prismaService.contest.update({
      where: { id: contestId },
      data: { status: ContestStatus.ACTIVE },
    });
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
   * Refusals are refusals of THIS person: outside the audience, or the
   * contest is not open. They are answered rather than thrown, because the
   * cabinet shows them as text next to the button, not as an error page.
   */
  public async enter(input: {
    readonly contestId: string;
    readonly userId: string;
    readonly now?: Date;
  }): Promise<{ readonly entered: boolean; readonly reason: EntryRefusal | null }> {
    const now = input.now ?? new Date();
    const contest = await this.prismaService.contest.findUnique({
      where: { id: input.contestId },
      select: { status: true, startAt: true, endAt: true, audienceFilter: true, maxEntries: true },
    });
    if (contest === null) throw new NotFoundException('Contest not found');

    const closed = readClosedReason(contest, now);
    if (closed !== null) return { entered: false, reason: closed };

    if (!(await this.isEligible(contest.audienceFilter, input.userId))) {
      return { entered: false, reason: 'NOT_ELIGIBLE' };
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
   * Run the draw for a contest that is over.
   *
   * `random` is injectable for the same reason the wheel's is: a draw whose
   * source of chance is baked in cannot be tested for the thing that matters.
   */
  public async draw(input: {
    readonly contestId: string;
    readonly now?: Date;
    readonly random?: () => number;
  }): Promise<DrawResult> {
    const now = input.now ?? new Date();
    const random = input.random ?? Math.random;

    return this.prismaService.$transaction(async (tx) => {
      // The stamp goes FIRST and is conditional on ACTIVE, so two sweeps
      // racing for the same contest cannot both draw it. The loser's
      // transaction has nothing left to do.
      const contest = await tx.contest.findUnique({
        where: { id: input.contestId },
        select: { status: true, endAt: true, prizes: { orderBy: { place: 'asc' }, select: PRIZE_SELECT } },
      });
      if (contest === null) throw new NotFoundException('Contest not found');
      if (contest.status === ContestStatus.DRAWN) return { drawn: false, reason: 'ALREADY_DRAWN' };
      if (contest.status !== ContestStatus.ACTIVE) return { drawn: false, reason: 'NOT_ACTIVE' };
      if (contest.endAt.getTime() > now.getTime()) return { drawn: false, reason: 'NOT_OVER' };

      const entries = await tx.contestEntry.findMany({
        where: { contestId: input.contestId },
        select: { userId: true },
      });
      const entrants = entries.map((entry) => entry.userId);

      const stamped = await tx.contest.updateMany({
        where: { id: input.contestId, status: ContestStatus.ACTIVE },
        data: { status: ContestStatus.DRAWN, drawnAt: now, drawnEntries: entrants.length },
      });
      if (stamped.count !== 1) return { drawn: false, reason: 'ALREADY_DRAWN' };

      const winners = drawWinners({ entrants, count: contest.prizes.length, random });
      for (const [index, userId] of winners.entries()) {
        const prize = contest.prizes[index] as PrizeRow;
        await this.award(tx, { contestId: input.contestId, userId, prize });
      }

      this.logger.log(
        `Contest ${input.contestId} drawn: ${winners.length} winner(s) from ${entrants.length} entrant(s)`,
      );
      return { drawn: true, winners: winners.length, entrants: entrants.length };
    });
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

  private async award(
    tx: Prisma.TransactionClient,
    input: { readonly contestId: string; readonly userId: string; readonly prize: PrizeRow },
  ): Promise<void> {
    const { prize } = input;
    // The winner row is written first so the payout has an id to hang the
    // journal rows and a claimed key on. Its status is corrected right after,
    // in the same transaction.
    const winner = await tx.contestWinner.create({
      data: {
        contestId: input.contestId,
        userId: input.userId,
        prizeId: prize.id,
        place: prize.place,
        prizeSnapshot: {
          id: prize.id,
          place: prize.place,
          kind: prize.kind,
          title: (prize.title ?? {}) as Prisma.InputJsonValue,
          amount: prize.amount,
        },
        kind: prize.kind,
        status: WheelSpinStatus.PENDING,
      },
      select: { id: true },
    });

    const paid = await this.payout.payOut(tx, {
      userId: input.userId,
      prize: { ...prize, promoPlanIds: prize.promoPlanIds },
      origin: {
        source: 'CONTEST',
        referenceKey: `contest:${winner.id}`,
        details: { contestId: input.contestId, winnerId: winner.id, place: prize.place },
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
export type EntryRefusal = 'NOT_OPEN' | 'NOT_STARTED' | 'ENDED' | 'NOT_ELIGIBLE' | 'FULL';

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
 * What would stop this contest being published: the same per-prize checks
 * the wheel applies to a sector, plus the two things a contest has that a
 * sector does not — a window and a first place.
 */
export function readContestProblems(input: {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly prizes: readonly Pick<PrizeRow, 'place' | 'kind' | 'amount' | 'keyPoolId' | 'promoRewardType' | 'promoPlanId' | 'promoLifetime' | 'manualInstructions'>[];
}): readonly string[] {
  const problems: string[] = [];
  if (input.prizes.length === 0) problems.push('Нужен хотя бы один приз');
  if (input.endAt.getTime() <= input.startAt.getTime()) problems.push('Конец должен быть позже начала');

  const places = input.prizes.map((prize) => prize.place).sort((a, b) => a - b);
  if (places.some((place, index) => place !== index + 1)) {
    problems.push('Места должны идти подряд, начиная с первого');
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
    if (seen.has(prize.place)) throw new BadRequestException(`Место ${prize.place} указано дважды`);
    seen.add(prize.place);
  }
}

function toPrizeData(prize: ContestPrizeInput): Prisma.ContestPrizeCreateWithoutContestInput {
  return {
    place: prize.place,
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

function toSummary(row: ContestRow): ContestSummary {
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
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    entries: row._count.entries,
    winners: row._count.winners,
    prizes: row.prizes,
    problems: readContestProblems({ startAt: row.startAt, endAt: row.endAt, prizes: row.prizes }),
  };
}
