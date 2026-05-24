import { Injectable } from '@nestjs/common';
import { Prisma, WithdrawalStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  PartnerCohortInterface,
  PartnerCohortRowInterface,
  PartnerFunnelInterface,
  PartnerGatewayDistributionInterface,
  PartnerKpiInterface,
  PartnerLevelDistributionInterface,
  PartnerTimeseriesGranularity,
  PartnerTimeseriesInterface,
  TopPartnerInterface,
  TopPartnersInterface,
  WithdrawalThroughputInterface,
} from '../interfaces/partner-analytics.interface';

const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_DEFAULT_LIMIT = 10;

interface ResolvedRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Read-only analytics for the admin "Analytics" tab on the Partners page.
 * Mirrors the structure of `AdminReferralAnalyticsService` so the SPA can
 * reuse the same chart components for both programs.
 *
 * Time-series uses `Prisma.sql` + `date_trunc` so Postgres handles the
 * bucketing instead of materializing every row in JS.
 */
@Injectable()
export class AdminPartnerAnalyticsService {
  public constructor(private readonly prismaService: PrismaService) {}

  // ── Funnel ──────────────────────────────────────────────────────────────

  public async getFunnel(input: {
    readonly from?: string;
    readonly to?: string;
  }): Promise<PartnerFunnelInterface> {
    const range = resolveRange(input);
    const [
      newPartners,
      activePartners,
      partnersWithEarningsRows,
      partnersWithWithdrawalsRows,
    ] = await Promise.all([
      this.prismaService.partner.count({
        where: { createdAt: { gte: range.from, lte: range.to } },
      }),
      this.prismaService.partner.count({
        where: {
          isActive: true,
          createdAt: { gte: range.from, lte: range.to },
        },
      }),
      this.prismaService.partnerTransaction.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: { partnerId: true },
        distinct: ['partnerId'],
      }),
      this.prismaService.partnerWithdrawal.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: { partnerId: true },
        distinct: ['partnerId'],
      }),
    ]);

    const partnersWithEarnings = partnersWithEarningsRows.length;
    const partnersWithWithdrawals = partnersWithWithdrawalsRows.length;

    return {
      newPartners,
      activePartners,
      partnersWithEarnings,
      partnersWithWithdrawals,
      conversion: {
        activationRate: safeRatio(activePartners, newPartners),
        earningRate: safeRatio(partnersWithEarnings, activePartners),
        withdrawalRate: safeRatio(partnersWithWithdrawals, partnersWithEarnings),
      },
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }

  // ── Timeseries ──────────────────────────────────────────────────────────

  public async getTimeseries(input: {
    readonly from?: string;
    readonly to?: string;
    readonly granularity?: PartnerTimeseriesGranularity;
  }): Promise<PartnerTimeseriesInterface> {
    const range = resolveRange(input);
    const granularity: PartnerTimeseriesGranularity = input.granularity ?? 'day';
    const trunc = granularity === 'week' ? 'week' : 'day';

    interface BucketRow {
      bucket: Date;
      earnings: bigint;
      withdrawals_approved: bigint;
      withdrawals_requested: bigint;
      new_partners: bigint;
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
        earnings AS (
          SELECT date_trunc(${trunc}, "created_at") AS bucket,
                 coalesce(sum("earned_amount"), 0)::bigint AS amount
          FROM "partner_transactions"
          WHERE "created_at" >= ${range.from}::timestamptz
            AND "created_at" <= ${range.to}::timestamptz
          GROUP BY 1
        ),
        wd_requested AS (
          SELECT date_trunc(${trunc}, "created_at") AS bucket, count(*)::bigint AS c
          FROM "partner_withdrawals"
          WHERE "created_at" >= ${range.from}::timestamptz
            AND "created_at" <= ${range.to}::timestamptz
          GROUP BY 1
        ),
        wd_approved AS (
          SELECT date_trunc(${trunc}, "processed_at") AS bucket, count(*)::bigint AS c
          FROM "partner_withdrawals"
          WHERE "status" = 'COMPLETED'
            AND "processed_at" IS NOT NULL
            AND "processed_at" >= ${range.from}::timestamptz
            AND "processed_at" <= ${range.to}::timestamptz
          GROUP BY 1
        ),
        new_partners AS (
          SELECT date_trunc(${trunc}, "created_at") AS bucket, count(*)::bigint AS c
          FROM "partners"
          WHERE "created_at" >= ${range.from}::timestamptz
            AND "created_at" <= ${range.to}::timestamptz
          GROUP BY 1
        )
        SELECT
          b.bucket AS bucket,
          coalesce(e.amount, 0)::bigint AS earnings,
          coalesce(wa.c, 0)::bigint AS withdrawals_approved,
          coalesce(wr.c, 0)::bigint AS withdrawals_requested,
          coalesce(np.c, 0)::bigint AS new_partners
        FROM buckets b
        LEFT JOIN earnings e ON e.bucket = b.bucket
        LEFT JOIN wd_requested wr ON wr.bucket = b.bucket
        LEFT JOIN wd_approved wa ON wa.bucket = b.bucket
        LEFT JOIN new_partners np ON np.bucket = b.bucket
        ORDER BY b.bucket ASC
      `,
    );

    return {
      granularity,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      points: rows.map((row) => ({
        bucket: row.bucket.toISOString(),
        earnings: Number(row.earnings),
        withdrawalsApproved: Number(row.withdrawals_approved),
        withdrawalsRequested: Number(row.withdrawals_requested),
        newPartners: Number(row.new_partners),
      })),
    };
  }

  // ── Level distribution ──────────────────────────────────────────────────

  public async getLevelDistribution(input: {
    readonly from?: string;
    readonly to?: string;
  }): Promise<PartnerLevelDistributionInterface> {
    const range = resolveRange(input);
    const grouped = await this.prismaService.partnerTransaction.groupBy({
      by: ['level'],
      where: { createdAt: { gte: range.from, lte: range.to } },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    });
    const byLevel: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
    const transactionsByLevel: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
    let totalEarnings = 0;
    for (const row of grouped) {
      const key = String(row.level);
      const earned = row._sum.earnedAmount ?? 0;
      byLevel[key] = earned;
      transactionsByLevel[key] = row._count._all;
      totalEarnings += earned;
    }
    return {
      byLevel,
      transactionsByLevel,
      totalEarnings,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }

  // ── Gateway distribution ────────────────────────────────────────────────

  public async getGatewayDistribution(input: {
    readonly from?: string;
    readonly to?: string;
  }): Promise<PartnerGatewayDistributionInterface> {
    const range = resolveRange(input);

    interface Row {
      gateway: string | null;
      earnings: bigint;
      transactions: bigint;
    }

    const rows = await this.prismaService.$queryRaw<Row[]>(
      Prisma.sql`
        SELECT
          tx."gateway_type"::text AS gateway,
          coalesce(sum(pt."earned_amount"), 0)::bigint AS earnings,
          count(*)::bigint AS transactions
        FROM "partner_transactions" pt
        LEFT JOIN "transactions" tx ON tx."id" = pt."source_transaction_id"
        WHERE pt."created_at" >= ${range.from}::timestamptz
          AND pt."created_at" <= ${range.to}::timestamptz
        GROUP BY tx."gateway_type"
        ORDER BY earnings DESC
      `,
    );

    const byGateway: Record<string, { earnings: number; transactions: number }> = {};
    let totalEarnings = 0;
    for (const row of rows) {
      const key = row.gateway ?? 'UNKNOWN';
      const earnings = Number(row.earnings);
      const transactions = Number(row.transactions);
      byGateway[key] = { earnings, transactions };
      totalEarnings += earnings;
    }
    return {
      byGateway,
      totalEarnings,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }

  // ── Top partners ────────────────────────────────────────────────────────

  public async getTopPartners(input: {
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
  }): Promise<TopPartnersInterface> {
    const range = resolveRange(input);
    const limit = input.limit ?? TOP_DEFAULT_LIMIT;

    interface Row {
      partner_id: string;
      user_id: string;
      username: string | null;
      name: string;
      telegram_id: bigint | null;
      earnings: bigint;
      transactions: bigint;
      referrals: bigint;
      balance: number;
    }

    const rows = await this.prismaService.$queryRaw<Row[]>(
      Prisma.sql`
        SELECT
          pt."partner_id" AS partner_id,
          p."user_id" AS user_id,
          u."username" AS username,
          u."name" AS name,
          u."telegram_id" AS telegram_id,
          coalesce(sum(pt."earned_amount"), 0)::bigint AS earnings,
          count(pt.*)::bigint AS transactions,
          coalesce((SELECT count(*) FROM "partner_referrals" pr WHERE pr."partner_id" = p."id"), 0)::bigint AS referrals,
          p."balance" AS balance
        FROM "partner_transactions" pt
        JOIN "partners" p ON p."id" = pt."partner_id"
        JOIN "users" u ON u."id" = p."user_id"
        WHERE pt."created_at" >= ${range.from}::timestamptz
          AND pt."created_at" <= ${range.to}::timestamptz
        GROUP BY pt."partner_id", p."user_id", p."id", p."balance", u."username", u."name", u."telegram_id"
        ORDER BY earnings DESC, transactions DESC
        LIMIT ${limit}
      `,
    );

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      items: rows.map(
        (row): TopPartnerInterface => ({
          partnerId: row.partner_id,
          userId: row.user_id,
          username: row.username,
          name: row.name === '' ? null : row.name,
          telegramId: row.telegram_id?.toString() ?? null,
          earnings: Number(row.earnings),
          transactions: Number(row.transactions),
          referrals: Number(row.referrals),
          balance: Number(row.balance),
        }),
      ),
    };
  }

  // ── Program KPIs (AOV / EPAP / activation / repeat) ────────────────────

  public async getKpis(input: {
    readonly from?: string;
    readonly to?: string;
  }): Promise<PartnerKpiInterface> {
    const range = resolveRange(input);

    interface KpiRow {
      total_earnings: bigint;
      total_payments: bigint;
      avg_payment_amount: number | null;
      partners_active: bigint;
      repeat_payment_earnings: bigint;
    }

    interface ActivationRow {
      new_partners: bigint;
      activated: bigint;
    }

    const [kpiRows, activationRows] = await Promise.all([
      this.prismaService.$queryRaw<KpiRow[]>(
        Prisma.sql`
          WITH window_tx AS (
            SELECT
              pt."partner_id",
              pt."referral_user_id",
              pt."earned_amount",
              pt."payment_amount",
              pt."source_transaction_id",
              row_number() OVER (
                PARTITION BY pt."partner_id", pt."referral_user_id"
                ORDER BY pt."created_at"
              ) AS occurrence
            FROM "partner_transactions" pt
            WHERE pt."created_at" >= ${range.from}::timestamptz
              AND pt."created_at" <= ${range.to}::timestamptz
          )
          SELECT
            coalesce(sum("earned_amount"), 0)::bigint AS total_earnings,
            count(distinct "source_transaction_id")::bigint AS total_payments,
            coalesce(avg(distinct_payments.amount), 0) AS avg_payment_amount,
            count(distinct "partner_id")::bigint AS partners_active,
            coalesce(sum(CASE WHEN occurrence > 1 THEN "earned_amount" ELSE 0 END), 0)::bigint AS repeat_payment_earnings
          FROM window_tx
          LEFT JOIN LATERAL (
            SELECT distinct on ("source_transaction_id") "source_transaction_id" AS source, "payment_amount" AS amount
            FROM window_tx wt2
            WHERE wt2."source_transaction_id" = window_tx."source_transaction_id"
          ) distinct_payments ON true
        `,
      ),
      this.prismaService.$queryRaw<ActivationRow[]>(
        Prisma.sql`
          WITH new_partners AS (
            SELECT id, "user_id", "created_at"
            FROM "partners"
            WHERE "created_at" >= ${range.from}::timestamptz
              AND "created_at" <= ${range.to}::timestamptz
          ),
          activated AS (
            SELECT DISTINCT np.id
            FROM new_partners np
            JOIN "partner_transactions" pt ON pt."partner_id" = np.id
            WHERE pt."created_at" <= np."created_at" + interval '14 days'
          )
          SELECT
            (SELECT count(*) FROM new_partners)::bigint AS new_partners,
            (SELECT count(*) FROM activated)::bigint AS activated
        `,
      ),
    ]);

    const kpi = kpiRows[0];
    const activation = activationRows[0];
    const totalEarnings = Number(kpi?.total_earnings ?? 0);
    const totalPayments = Number(kpi?.total_payments ?? 0);
    const partnersActive = Number(kpi?.partners_active ?? 0);
    const repeatEarnings = Number(kpi?.repeat_payment_earnings ?? 0);
    const newPartners = Number(activation?.new_partners ?? 0);
    const activatedNewPartners = Number(activation?.activated ?? 0);

    return {
      aov: kpi?.avg_payment_amount === null || kpi?.avg_payment_amount === undefined
        ? 0
        : Math.round(Number(kpi.avg_payment_amount)),
      epap: partnersActive > 0 ? Math.round(totalEarnings / partnersActive) : 0,
      activationRate: safeRatio(activatedNewPartners, newPartners),
      repeatPurchaseContribution: safeRatio(repeatEarnings, totalEarnings),
      partnersActiveInWindow: partnersActive,
      newPartners,
      newPartnersActivated: activatedNewPartners,
      totalEarnings,
      totalQualifyingPayments: totalPayments,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }

  // ── Withdrawal throughput ───────────────────────────────────────────────

  public async getWithdrawalThroughput(input: {
    readonly from?: string;
    readonly to?: string;
  }): Promise<WithdrawalThroughputInterface> {
    const range = resolveRange(input);
    const [counts, decisionStats] = await Promise.all([
      this.prismaService.partnerWithdrawal.groupBy({
        by: ['status'],
        where: { createdAt: { gte: range.from, lte: range.to } },
        _count: { _all: true },
      }),
      this.queryDecisionDuration(range),
    ]);

    let requested = 0;
    let approved = 0;
    let rejected = 0;
    for (const row of counts) {
      requested += row._count._all;
      if (row.status === WithdrawalStatus.COMPLETED) approved = row._count._all;
      if (row.status === WithdrawalStatus.REJECTED) rejected = row._count._all;
    }
    return {
      requested,
      approved,
      rejected,
      approvalRate: safeRatio(approved, approved + rejected),
      medianDecisionSeconds: decisionStats.median,
      p95DecisionSeconds: decisionStats.p95,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }

  private async queryDecisionDuration(range: ResolvedRange): Promise<{
    readonly median: number | null;
    readonly p95: number | null;
  }> {
    interface Row {
      median_seconds: number | null;
      p95_seconds: number | null;
    }
    const rows = await this.prismaService.$queryRaw<Row[]>(
      Prisma.sql`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("processed_at" - "created_at"))) AS median_seconds,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("processed_at" - "created_at"))) AS p95_seconds
        FROM "partner_withdrawals"
        WHERE "processed_at" IS NOT NULL
          AND "created_at" >= ${range.from}::timestamptz
          AND "created_at" <= ${range.to}::timestamptz
      `,
    );
    const row = rows[0];
    if (!row) return { median: null, p95: null };
    return {
      median: row.median_seconds === null ? null : Number(row.median_seconds),
      p95: row.p95_seconds === null ? null : Number(row.p95_seconds),
    };
  }

  // ── Cohort retention ───────────────────────────────────────────────────

  /**
   * Weekly cohort retention: for each cohort of partners that registered
   * in week W, the share of cohort that produced earnings in week W+0..W+N.
   * Built entirely in Postgres so we don't fan out activity logs to JS.
   *
   * Output is a dense matrix with `null` for cells where the cohort has
   * not been alive long enough to be measured (week N > weeks elapsed
   * since cohort start).
   */
  public async getCohortRetention(input: {
    readonly from?: string;
    readonly to?: string;
    readonly horizonWeeks?: number;
  }): Promise<PartnerCohortInterface> {
    const range = resolveRange(input);
    const horizon = clamp(input.horizonWeeks ?? 8, 1, 26);

    interface CohortRow {
      cohort_start: Date;
      cohort_size: bigint;
    }
    interface ActivityRow {
      cohort_start: Date;
      week_index: number;
      active_count: bigint;
    }

    const [cohorts, activity] = await Promise.all([
      this.prismaService.$queryRaw<CohortRow[]>(
        Prisma.sql`
          SELECT
            date_trunc('week', "created_at") AS cohort_start,
            count(*)::bigint AS cohort_size
          FROM "partners"
          WHERE "created_at" >= ${range.from}::timestamptz
            AND "created_at" <= ${range.to}::timestamptz
          GROUP BY 1
          ORDER BY 1 ASC
        `,
      ),
      this.prismaService.$queryRaw<ActivityRow[]>(
        Prisma.sql`
          WITH cohort AS (
            SELECT id AS partner_id, date_trunc('week', "created_at") AS cohort_start
            FROM "partners"
            WHERE "created_at" >= ${range.from}::timestamptz
              AND "created_at" <= ${range.to}::timestamptz
          )
          SELECT
            c.cohort_start,
            CAST(EXTRACT(WEEK FROM age(date_trunc('week', pt."created_at"), c.cohort_start)) AS int)
              + CAST(EXTRACT(YEAR FROM age(date_trunc('week', pt."created_at"), c.cohort_start)) AS int) * 52
              AS week_index,
            count(distinct pt."partner_id")::bigint AS active_count
          FROM cohort c
          JOIN "partner_transactions" pt ON pt."partner_id" = c.partner_id
          WHERE pt."created_at" >= c.cohort_start
            AND pt."created_at" < c.cohort_start + (${horizon} * interval '7 days')
          GROUP BY c.cohort_start, week_index
        `,
      ),
    ]);

    const activityByCohort = new Map<string, Map<number, number>>();
    for (const row of activity) {
      const key = row.cohort_start.toISOString();
      const innerMap = activityByCohort.get(key) ?? new Map<number, number>();
      innerMap.set(Number(row.week_index), Number(row.active_count));
      activityByCohort.set(key, innerMap);
    }

    const now = Date.now();
    const rows: PartnerCohortRowInterface[] = cohorts.map((cohort) => {
      const cohortKey = cohort.cohort_start.toISOString();
      const cohortSize = Number(cohort.cohort_size);
      const weeksElapsed = Math.floor(
        (now - cohort.cohort_start.getTime()) / (7 * 24 * 60 * 60 * 1000),
      );
      const innerMap = activityByCohort.get(cohortKey) ?? new Map<number, number>();
      const retention: Array<number | null> = [];
      for (let week = 0; week < horizon; week++) {
        if (week > weeksElapsed) {
          retention.push(null);
          continue;
        }
        const active = innerMap.get(week) ?? 0;
        retention.push(cohortSize > 0 ? active / cohortSize : 0);
      }
      return {
        cohortLabel: cohortKey,
        cohortSize,
        retention,
      };
    });

    return {
      horizonWeeks: horizon,
      rows,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
