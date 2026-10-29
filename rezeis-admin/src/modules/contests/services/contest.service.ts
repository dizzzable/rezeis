import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  BroadcastAudience,
  ContestStatus,
  Prisma,
  TransactionStatus,
  WheelSectorKind,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAudienceWhere, normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { PrizePayoutService } from '../../wheel/services/prize-payout.service';
import { validateSector } from '../../wheel-config/wheel-sector-validation.util';
import { drawWeightedWinners, hashDrawSeed, newDrawSeed, seededRandom } from '../contest-draw.util';

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
  prizes: { orderBy: { place: 'asc' as const }, select: PRIZE_SELECT },
  _count: { select: { entries: true, winners: true } },
} as const;

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
  readonly prizes: readonly PrizeRow[];
  /** Why it cannot be published as it stands. Empty means it can. */
  readonly problems: readonly string[];
}

export type DrawResult =
  | { readonly drawn: true; readonly winners: number; readonly entrants: number; readonly tickets: number }
  /** Not ACTIVE, or not over yet, or already drawn by a concurrent sweep. */
  | { readonly drawn: false; readonly reason: 'NOT_ACTIVE' | 'NOT_OVER' | 'ALREADY_DRAWN' };

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
   * told they had until then.
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
        data: { title: input.title, description: input.description, ...(endAt === null ? {} : { endAt }) },
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
   * the seed until the draw has used it. Only its hash goes out.
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

    const seed = newDrawSeed();
    const changed = await this.prismaService.contest.updateMany({
      where: { id: contestId, status: ContestStatus.DRAFT },
      data: { status: ContestStatus.ACTIVE, drawSeed: seed, drawSeedHash: hashDrawSeed(seed) },
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
      },
    });
    if (contest === null) throw new NotFoundException('Contest not found');

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
    const synced: string[] = [];

    const result = await this.prismaService.$transaction(
      async (tx): Promise<DrawResult> => {
        const contest = await tx.contest.findUnique({
          where: { id: input.contestId },
          select: {
            status: true,
            startAt: true,
            endAt: true,
            drawSeed: true,
            ticketsPerPurchase: true,
            ticketsPerReferral: true,
            maxTicketsPerUser: true,
            prizes: { orderBy: { place: 'asc' }, select: PRIZE_SELECT },
          },
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
        const tickets = await countTickets(tx, contest, entrants);
        const totalTickets = entrants.reduce((sum, userId) => sum + (tickets.get(userId) ?? 1), 0);

        // The stamp goes before any payout and is conditional on ACTIVE, so
        // two sweeps racing for the same contest cannot both draw it. The
        // loser's transaction has nothing left to do.
        const stamped = await tx.contest.updateMany({
          where: { id: input.contestId, status: ContestStatus.ACTIVE },
          data: {
            status: ContestStatus.DRAWN,
            drawnAt: now,
            drawnEntries: entrants.length,
            drawnTickets: totalTickets,
            drawError: null,
            drawErrorAt: null,
          },
        });
        if (stamped.count !== 1) return { drawn: false, reason: 'ALREADY_DRAWN' };

        await recordTickets(tx, input.contestId, entrants, tickets);

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
        const winners = drawWeightedWinners({
          entrants: entrants.map((userId) => ({ id: userId, tickets: tickets.get(userId) ?? 1 })),
          count: contest.prizes.length,
          random,
        });
        for (const [index, userId] of winners.entries()) {
          const prize = contest.prizes[index] as PrizeRow;
          const syncSubscriptionId = await this.award(tx, { contestId: input.contestId, userId, prize });
          if (syncSubscriptionId !== null) synced.push(syncSubscriptionId);
        }

        this.logger.log(
          `Contest ${input.contestId} drawn: ${winners.length} winner(s) from ${entrants.length} entrant(s), ${totalTickets} ticket(s)`,
        );
        return { drawn: true, winners: winners.length, entrants: entrants.length, tickets: totalTickets };
      },
      // Up to fifty prizes, each a create, a payout and an update — a
      // giveaway that size does not fit Prisma's five-second default, and
      // running out of time rolls the whole draw back onto a sweep that will
      // simply run out of time again.
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
   * Pays one place and returns the subscription it changed, for the caller to
   * push to Remnawave after the commit.
   */
  private async award(
    tx: Prisma.TransactionClient,
    input: { readonly contestId: string; readonly userId: string; readonly prize: PrizeRow },
  ): Promise<string | null> {
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
  | 'NEEDS_TELEGRAM';

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
 * does not — a window, a first place, and a channel that has both halves.
 */
export function readContestProblems(input: {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly channelChatId?: string | null;
  readonly channelJoinUrl?: string | null;
  readonly prizes: readonly Pick<PrizeRow, 'place' | 'kind' | 'amount' | 'keyPoolId' | 'promoRewardType' | 'promoPlanId' | 'promoLifetime' | 'manualInstructions'>[];
}): readonly string[] {
  const problems: string[] = [];
  if (input.prizes.length === 0) problems.push('Нужен хотя бы один приз');
  if (input.endAt.getTime() <= input.startAt.getTime()) problems.push('Конец должен быть позже начала');
  if ((input.channelChatId ?? null) === null !== ((input.channelJoinUrl ?? null) === null)) {
    problems.push('Канал: нужны и ссылка, и то, по чему его проверять');
  }

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

/** The terms a draft carries, as columns. */
function termsData(input: ContestInput): Omit<Prisma.ContestCreateInput, 'prizes' | 'createdBy'> {
  return {
    title: input.title,
    description: input.description,
    startAt: input.startAt,
    endAt: input.endAt,
    audienceFilter: input.audienceFilter ?? Prisma.JsonNull,
    maxEntries: input.maxEntries,
    announce: input.announce,
    ticketsPerPurchase: input.ticketsPerPurchase,
    ticketsPerReferral: input.ticketsPerReferral,
    maxTicketsPerUser: input.maxTicketsPerUser,
    channelChatId: input.channel?.chatId ?? null,
    channelJoinUrl: input.channel?.joinUrl ?? null,
  };
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
    prizes: row.prizes,
    problems: readContestProblems({
      startAt: row.startAt,
      endAt: row.endAt,
      channelChatId: row.channelChatId,
      channelJoinUrl: row.channelJoinUrl,
      prizes: row.prizes,
    }),
  };
}
