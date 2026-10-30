import { Injectable, Logger } from '@nestjs/common';
import {
  BroadcastAudience,
  ContestMetric,
  PaymentGatewayType,
  PointsLedgerSource,
  Prisma,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAudienceWhere, normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { FxRateService } from '../../fx/fx-rate.service';

/** One person's place-worthy number, before places are handed out. */
export interface Standing {
  readonly userId: string;
  /** In the metric's own unit: friends, minor units of the base currency, bytes, points. */
  readonly score: bigint;
  /** When the score got where it is. On a tie, earlier ranks higher. */
  readonly reachedAt: Date;
}

/** What ranking a leaderboard needs to know about it. */
export interface RankedContest {
  readonly id: string;
  readonly metric: ContestMetric | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly audienceFilter: Prisma.JsonValue | null;
}

/**
 * The points a leaderboard counts as EARNED: what the person did — cashback
 * on a purchase, a friend, a quest, the wheel — with the reversals of the
 * same, so a refunded purchase takes its cashback off the board too.
 *
 * Not counted: a contest's own prize (a leaderboard by points would feed
 * itself), an exchange (spending, not earning), an operator's adjustment, and
 * the bookkeeping rows of a merge, an import or an opening balance.
 */
export const EARNED_POINTS_SOURCES: readonly PointsLedgerSource[] = [
  PointsLedgerSource.CASHBACK,
  PointsLedgerSource.CASHBACK_REVERSED,
  PointsLedgerSource.REFERRAL_REWARD,
  PointsLedgerSource.REFERRAL_REWARD_REVOKED,
  PointsLedgerSource.QUEST_REWARD,
  PointsLedgerSource.WHEEL_PRIZE,
];

/** How old the standings a screen is shown may be. */
const LIVE_TTL_MS = 60_000;

/** Ids per audience query: well inside Postgres's limit on bind parameters. */
const AUDIENCE_CHUNK = 5_000;

/**
 * Who stands where on a leaderboard.
 *
 * Counted from the records themselves — payments, referrals, the points
 * ledger, the traffic counters — every time, never kept as a running total:
 * a refund before the end takes its payment off the board, and there is no
 * second ledger to drift from the first. A screen gets the count at most a
 * minute old; the end of the contest counts afresh.
 *
 * Only the audience is ranked, and never a blocked account — the same people
 * who could have entered a draw with the same filter.
 */
@Injectable()
export class ContestStandingsService {
  private readonly logger = new Logger(ContestStandingsService.name);
  private readonly cache = new Map<string, { readonly at: number; readonly standings: readonly Standing[] }>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly fx: FxRateService,
  ) {}

  /** The base currency payments are ranked in. */
  public baseCurrency(): string {
    return this.fx.getBaseCurrency();
  }

  /** Best first: the score, then who got there first, then the id. */
  public async rank(contest: RankedContest, now = new Date()): Promise<readonly Standing[]> {
    if (contest.metric === null) return [];
    const until = contest.endAt.getTime() < now.getTime() ? contest.endAt : now;
    const window = { gte: contest.startAt, lte: until };

    let scores: Map<string, { score: bigint; reachedAt: Date }>;
    switch (contest.metric) {
      case ContestMetric.REFERRALS_PAID:
        scores = await this.referrals(window);
        break;
      case ContestMetric.PAYMENTS_SUM:
        scores = await this.payments(contest.id, window);
        break;
      case ContestMetric.POINTS_EARNED:
        scores = await this.points(window);
        break;
      case ContestMetric.TRAFFIC:
        scores = await this.traffic(contest.id);
        break;
    }

    const scored = [...scores].filter(([, value]) => value.score > 0n);
    const allowed = await this.inAudience(
      contest.audienceFilter,
      scored.map(([userId]) => userId),
    );
    const standings = scored
      .filter(([userId]) => allowed.has(userId))
      .map(([userId, value]) => ({ userId, score: value.score, reachedAt: value.reachedAt }));
    standings.sort(compareStandings);
    return standings;
  }

  /** The same, at most a minute old: what the cabinet and the panel show while it runs. */
  public async live(contest: RankedContest, now = new Date()): Promise<readonly Standing[]> {
    const cached = this.cache.get(contest.id);
    if (cached !== undefined && now.getTime() - cached.at < LIVE_TTL_MS) return cached.standings;
    const standings = await this.rank(contest, now);
    this.cache.set(contest.id, { at: now.getTime(), standings });
    // Contests end; their entries must not outlive them here.
    if (this.cache.size > 50) {
      for (const [id, entry] of this.cache) {
        if (now.getTime() - entry.at >= LIVE_TTL_MS) this.cache.delete(id);
      }
    }
    return standings;
  }

  /** Direct referrals whose first payment fell inside the window — a sign-up alone is free to fake. */
  private async referrals(window: Prisma.DateTimeFilter): Promise<Map<string, { score: bigint; reachedAt: Date }>> {
    const rows = await this.prismaService.referral.groupBy({
      by: ['referrerId'],
      where: { level: 1, qualifiedAt: window },
      _count: { _all: true },
      _max: { qualifiedAt: true },
    });
    const out = new Map<string, { score: bigint; reachedAt: Date }>();
    for (const row of rows) {
      out.set(row.referrerId, { score: BigInt(row._count._all), reachedAt: row._max.qualifiedAt ?? new Date(0) });
    }
    return out;
  }

  /**
   * Completed payments of more than nothing, in minor units of the base
   * currency. A payment from the partner balance is left out: that money
   * came in once already, as the payments it was earned on.
   *
   * A currency with no known rate is left out too, and said so in the log —
   * adding it at the wrong rate, or at zero, would put the wrong person first.
   */
  private async payments(
    contestId: string,
    window: Prisma.DateTimeFilter,
  ): Promise<Map<string, { score: bigint; reachedAt: Date }>> {
    const rows = await this.prismaService.transaction.groupBy({
      by: ['userId', 'currency'],
      where: {
        status: TransactionStatus.COMPLETED,
        amount: { gt: 0 },
        createdAt: window,
        gatewayType: { not: PaymentGatewayType.PARTNER_BALANCE },
      },
      _sum: { amount: true },
      _max: { createdAt: true },
    });
    const out = new Map<string, { score: bigint; reachedAt: Date }>();
    const unpriced = new Set<string>();
    for (const row of rows) {
      if (row._sum.amount === null) continue;
      const converted = await this.fx.toBaseMinor(row._sum.amount, row.currency);
      if (converted === null) {
        unpriced.add(row.currency);
        continue;
      }
      add(out, row.userId, BigInt(converted.amountBaseMinor), row._max.createdAt ?? new Date(0));
    }
    if (unpriced.size > 0) {
      this.logger.warn(
        `Contest ${contestId}: payments in ${[...unpriced].join(', ')} left out of the leaderboard — no exchange rate`,
      );
    }
    return out;
  }

  private async points(window: Prisma.DateTimeFilter): Promise<Map<string, { score: bigint; reachedAt: Date }>> {
    const rows = await this.prismaService.pointsLedgerEntry.groupBy({
      by: ['userId'],
      where: { source: { in: [...EARNED_POINTS_SOURCES] }, createdAt: window },
      _sum: { delta: true },
      _max: { createdAt: true },
    });
    const out = new Map<string, { score: bigint; reachedAt: Date }>();
    for (const row of rows) {
      out.set(row.userId, { score: BigInt(row._sum.delta ?? 0), reachedAt: row._max.createdAt ?? new Date(0) });
    }
    return out;
  }

  /** What the counters have seen each subscription use, summed per person. */
  private async traffic(contestId: string): Promise<Map<string, { score: bigint; reachedAt: Date }>> {
    const rows = await this.prismaService.contestTrafficCounter.findMany({
      where: { contestId },
      select: { userId: true, startBytes: true, lastBytes: true, updatedAt: true },
    });
    const out = new Map<string, { score: bigint; reachedAt: Date }>();
    for (const row of rows) {
      const used = row.lastBytes - row.startBytes;
      if (used <= 0n) continue;
      add(out, row.userId, used, row.updatedAt);
    }
    return out;
  }

  private async inAudience(audienceFilter: Prisma.JsonValue | null, userIds: readonly string[]): Promise<Set<string>> {
    const allowed = new Set<string>();
    if (userIds.length === 0) return allowed;
    const filter = normalizeAudienceFilter(audienceFilter);
    const audience = filter === null ? {} : buildAudienceWhere(BroadcastAudience.ALL, filter);
    for (let start = 0; start < userIds.length; start += AUDIENCE_CHUNK) {
      const chunk = userIds.slice(start, start + AUDIENCE_CHUNK);
      const rows = await this.prismaService.user.findMany({
        where: { AND: [{ id: { in: chunk } }, { isBlocked: false }, audience] },
        select: { id: true },
      });
      for (const row of rows) allowed.add(row.id);
    }
    return allowed;
  }
}

export function compareStandings(a: Standing, b: Standing): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  const time = a.reachedAt.getTime() - b.reachedAt.getTime();
  if (time !== 0) return time;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

function add(
  into: Map<string, { score: bigint; reachedAt: Date }>,
  userId: string,
  score: bigint,
  reachedAt: Date,
): void {
  const current = into.get(userId);
  if (current === undefined) {
    into.set(userId, { score, reachedAt });
    return;
  }
  current.score += score;
  if (reachedAt.getTime() > current.reachedAt.getTime()) current.reachedAt = reachedAt;
}
