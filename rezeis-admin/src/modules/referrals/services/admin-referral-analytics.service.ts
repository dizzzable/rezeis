import { Injectable } from '@nestjs/common';
import { Prisma, ReferralRewardType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ReferralFunnelInterface,
  ReferralRewardDistributionInterface,
  ReferralSourceBreakdownInterface,
  ReferralTimeseriesGranularity,
  ReferralTimeseriesInterface,
  ReferralTopReferrerInterface,
  ReferralTopReferrersInterface,
} from '../interfaces/admin-referral-analytics.interface';

const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_REFERRERS_DEFAULT_LIMIT = 10;

interface ResolvedRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Read-only analytics for the admin "Analytics" tab on the Referrals
 * page. Each endpoint computes its own scope from a single resolved
 * date range so the methods can be called independently from the SPA.
 *
 * Time-series uses native `Prisma.sql` `date_trunc` so we don't have
 * to gather + bucket millions of rows in JS — Postgres handles it,
 * we just hydrate the result.
 */
@Injectable()
export class AdminReferralAnalyticsService {
  public constructor(private readonly prismaService: PrismaService) {}

  // ── Funnel ─────────────────────────────────────────────────────────────

  public async getFunnel(input: {
    readonly from?: string;
    readonly to?: string;
  }): Promise<ReferralFunnelInterface> {
    const range = resolveRange(input);
    const [invitesCreated, invitesConsumed, referralsQualified, rewardsIssued] =
      await Promise.all([
        this.prismaService.referralInvite.count({
          where: { createdAt: { gte: range.from, lte: range.to } },
        }),
        this.prismaService.referralInvite.count({
          where: { consumedAt: { gte: range.from, lte: range.to } },
        }),
        this.prismaService.referral.count({
          where: { qualifiedAt: { gte: range.from, lte: range.to } },
        }),
        this.prismaService.referralReward.count({
          where: {
            issuedAt: { gte: range.from, lte: range.to },
            isIssued: true,
            revokedAt: null,
          },
        }),
      ]);

    return {
      invitesCreated,
      invitesConsumed,
      referralsQualified,
      rewardsIssued,
      conversion: {
        invitesToConsumed: safeRatio(invitesConsumed, invitesCreated),
        consumedToQualified: safeRatio(referralsQualified, invitesConsumed),
        qualifiedToIssued: safeRatio(rewardsIssued, referralsQualified),
      },
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }

  // ── Timeseries ─────────────────────────────────────────────────────────

  public async getTimeseries(input: {
    readonly from?: string;
    readonly to?: string;
    readonly granularity?: ReferralTimeseriesGranularity;
  }): Promise<ReferralTimeseriesInterface> {
    const range = resolveRange(input);
    const granularity: ReferralTimeseriesGranularity = input.granularity ?? 'day';
    const trunc = granularity === 'week' ? 'week' : 'day';

    interface BucketRow {
      bucket: Date;
      invites_created: bigint;
      referrals_created: bigint;
      referrals_qualified: bigint;
      rewards_issued: bigint;
      points_issued: bigint;
    }

    const rows = await this.prismaService.$queryRaw<BucketRow[]>(
      Prisma.sql`
        WITH buckets AS (
          SELECT generate_series(
            date_trunc(${trunc}, ${range.from}::timestamptz),
            date_trunc(${trunc}, ${range.to}::timestamptz),
            ${granularity === 'week' ? Prisma.sql`'1 week'::interval` : Prisma.sql`'1 day'::interval`}
          ) AS bucket
        ),
        invites AS (
          SELECT date_trunc(${trunc}, "created_at") AS bucket, count(*)::bigint AS c
          FROM "referral_invites"
          WHERE "created_at" >= ${range.from}::timestamptz
            AND "created_at" <= ${range.to}::timestamptz
          GROUP BY 1
        ),
        referrals_created AS (
          SELECT date_trunc(${trunc}, "created_at") AS bucket, count(*)::bigint AS c
          FROM "referrals"
          WHERE "created_at" >= ${range.from}::timestamptz
            AND "created_at" <= ${range.to}::timestamptz
          GROUP BY 1
        ),
        referrals_qualified AS (
          SELECT date_trunc(${trunc}, "qualified_at") AS bucket, count(*)::bigint AS c
          FROM "referrals"
          WHERE "qualified_at" IS NOT NULL
            AND "qualified_at" >= ${range.from}::timestamptz
            AND "qualified_at" <= ${range.to}::timestamptz
          GROUP BY 1
        ),
        rewards AS (
          SELECT
            date_trunc(${trunc}, "issued_at") AS bucket,
            count(*)::bigint AS c,
            coalesce(sum(CASE WHEN "type" = 'POINTS' THEN "amount" ELSE 0 END), 0)::bigint AS pts
          FROM "referral_rewards"
          WHERE "is_issued" = true
            AND "revoked_at" IS NULL
            AND "issued_at" >= ${range.from}::timestamptz
            AND "issued_at" <= ${range.to}::timestamptz
          GROUP BY 1
        )
        SELECT
          b.bucket AS bucket,
          coalesce(i.c, 0)::bigint AS invites_created,
          coalesce(rc.c, 0)::bigint AS referrals_created,
          coalesce(rq.c, 0)::bigint AS referrals_qualified,
          coalesce(rw.c, 0)::bigint AS rewards_issued,
          coalesce(rw.pts, 0)::bigint AS points_issued
        FROM buckets b
          LEFT JOIN invites i ON i.bucket = b.bucket
          LEFT JOIN referrals_created rc ON rc.bucket = b.bucket
          LEFT JOIN referrals_qualified rq ON rq.bucket = b.bucket
          LEFT JOIN rewards rw ON rw.bucket = b.bucket
        ORDER BY b.bucket ASC
      `,
    );

    return {
      granularity,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      points: rows.map((row) => ({
        bucket: row.bucket.toISOString(),
        invitesCreated: Number(row.invites_created),
        referralsCreated: Number(row.referrals_created),
        referralsQualified: Number(row.referrals_qualified),
        rewardsIssued: Number(row.rewards_issued),
        pointsIssued: Number(row.points_issued),
      })),
    };
  }

  // ── Top referrers ─────────────────────────────────────────────────────

  public async getTopReferrers(input: {
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
  }): Promise<ReferralTopReferrersInterface> {
    const range = resolveRange(input);
    const limit = input.limit ?? TOP_REFERRERS_DEFAULT_LIMIT;

    interface Row {
      referrer_id: string;
      username: string | null;
      name: string;
      telegram_id: bigint | null;
      total_referrals: bigint;
      qualified_referrals: bigint;
      rewards_issued: bigint;
      points_earned: bigint;
    }

    const rows = await this.prismaService.$queryRaw<Row[]>(
      Prisma.sql`
        SELECT
          r."referrer_id" AS referrer_id,
          u."username"    AS username,
          u."name"        AS name,
          u."telegram_id" AS telegram_id,
          count(r.*)::bigint AS total_referrals,
          count(r.*) FILTER (WHERE r."qualified_at" IS NOT NULL)::bigint AS qualified_referrals,
          coalesce(rw.issued_count, 0)::bigint AS rewards_issued,
          coalesce(rw.points_sum, 0)::bigint AS points_earned
        FROM "referrals" r
        JOIN "users" u ON u."id" = r."referrer_id"
        LEFT JOIN (
          SELECT
            "user_id",
            count(*) FILTER (WHERE "is_issued" = true AND "revoked_at" IS NULL)::bigint AS issued_count,
            coalesce(sum(CASE WHEN "type" = 'POINTS' AND "is_issued" = true AND "revoked_at" IS NULL THEN "amount" ELSE 0 END), 0)::bigint AS points_sum
          FROM "referral_rewards"
          WHERE "issued_at" IS NULL OR ("issued_at" >= ${range.from}::timestamptz AND "issued_at" <= ${range.to}::timestamptz)
          GROUP BY "user_id"
        ) rw ON rw."user_id" = r."referrer_id"
        WHERE r."created_at" >= ${range.from}::timestamptz
          AND r."created_at" <= ${range.to}::timestamptz
        GROUP BY r."referrer_id", u."username", u."name", u."telegram_id", rw.issued_count, rw.points_sum
        ORDER BY qualified_referrals DESC, total_referrals DESC, points_earned DESC
        LIMIT ${limit}
      `,
    );

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      items: rows.map(
        (row): ReferralTopReferrerInterface => ({
          userId: row.referrer_id,
          username: row.username,
          name: row.name === '' ? null : row.name,
          telegramId: row.telegram_id?.toString() ?? null,
          totalReferrals: Number(row.total_referrals),
          qualifiedReferrals: Number(row.qualified_referrals),
          conversionRate: safeRatio(
            Number(row.qualified_referrals),
            Number(row.total_referrals),
          ),
          rewardsIssued: Number(row.rewards_issued),
          pointsEarned: Number(row.points_earned),
        }),
      ),
    };
  }

  // ── Reward distribution ───────────────────────────────────────────────

  public async getRewardDistribution(): Promise<ReferralRewardDistributionInterface> {
    const groups = await this.prismaService.referralReward.groupBy({
      by: ['type', 'isIssued'],
      _count: { _all: true },
      where: { revokedAt: null },
    });
    const revokedCount = await this.prismaService.referralReward.count({
      where: { revokedAt: { not: null } },
    });
    const byType: Record<string, { issued: number; pending: number; revoked: number }> = {};
    for (const enumValue of Object.values(ReferralRewardType)) {
      byType[enumValue] = { issued: 0, pending: 0, revoked: 0 };
    }
    let totalIssued = 0;
    let totalPending = 0;
    for (const group of groups) {
      const slot = group.isIssued ? 'issued' : 'pending';
      const bucket = byType[group.type] ?? { issued: 0, pending: 0, revoked: 0 };
      bucket[slot] = group._count._all;
      byType[group.type] = bucket;
      if (slot === 'issued') totalIssued += group._count._all;
      else totalPending += group._count._all;
    }
    return {
      byType,
      totals: {
        issued: totalIssued,
        pending: totalPending,
        revoked: revokedCount,
      },
    };
  }

  // ── Invite source breakdown ───────────────────────────────────────────

  public async getSourceBreakdown(): Promise<ReferralSourceBreakdownInterface> {
    const groups = await this.prismaService.referral.groupBy({
      by: ['inviteSource'],
      _count: { _all: true },
    });
    const bySource: Record<string, number> = {};
    let total = 0;
    for (const group of groups) {
      bySource[group.inviteSource] = group._count._all;
      total += group._count._all;
    }
    return { bySource, total };
  }
}

// ── Module-private helpers ────────────────────────────────────────────────

function resolveRange(input: { readonly from?: string; readonly to?: string }): ResolvedRange {
  const to = input.to !== undefined ? new Date(input.to) : new Date();
  const from =
    input.from !== undefined
      ? new Date(input.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  return { from, to };
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}
