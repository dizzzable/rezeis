import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface PlansStatsQueryInput {
  readonly from?: Date;
  readonly to?: Date;
  readonly planId?: string;
}

export interface PlansStatsTotalsInterface {
  readonly purchases: number;
  readonly revenueByCurrency: Record<string, string>;
  readonly uniqueBuyers: number;
}

export interface PlansStatsBreakdownItemInterface {
  readonly planId: string | null;
  readonly planName: string;
  readonly purchases: number;
  readonly uniqueBuyers: number;
  readonly revenueByCurrency: Record<string, string>;
}

export interface PlansStatsTimelinePointInterface {
  readonly bucket: string;
  readonly purchases: number;
  readonly revenueByCurrency: Record<string, string>;
}

export interface PlansStatsTopBuyerInterface {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly telegramId: string | null;
  readonly purchases: number;
  readonly revenueByCurrency: Record<string, string>;
}

export interface PlansStatsResultInterface {
  readonly totals: PlansStatsTotalsInterface;
  readonly byPlan: readonly PlansStatsBreakdownItemInterface[];
  readonly timeline: readonly PlansStatsTimelinePointInterface[];
  readonly topBuyers: readonly PlansStatsTopBuyerInterface[];
}

interface RawPurchaseRow {
  readonly userId: string;
  readonly amount: Prisma.Decimal;
  readonly currency: string;
  readonly planSnapshot: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly user: {
    readonly name: string;
    readonly username: string | null;
    readonly telegramId: bigint | null;
  };
}

function addRevenue(target: Record<string, string>, currency: string, amount: Prisma.Decimal): void {
  const previous = target[currency] ?? '0';
  const sum = new Prisma.Decimal(previous).add(amount);
  target[currency] = sum.toFixed(2);
}

function extractPlanRef(snapshot: Prisma.JsonValue): { id: string | null; name: string } {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const planNode = (snapshot as Record<string, unknown>).plan;
    if (planNode && typeof planNode === 'object' && !Array.isArray(planNode)) {
      const planRecord = planNode as Record<string, unknown>;
      const idValue = planRecord.id;
      const nameValue = planRecord.name;
      return {
        id: typeof idValue === 'string' ? idValue : null,
        name: typeof nameValue === 'string' ? nameValue : 'Unknown',
      };
    }
  }
  return { id: null, name: 'Unknown' };
}

@Injectable()
export class PlansStatsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async getStats(input: PlansStatsQueryInput): Promise<PlansStatsResultInterface> {
    const where: Prisma.TransactionWhereInput = {
      status: 'COMPLETED',
      purchaseType: { in: ['NEW', 'RENEW', 'UPGRADE'] },
    };

    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }

    const rows = (await this.prismaService.transaction.findMany({
      where,
      select: {
        userId: true,
        amount: true,
        currency: true,
        planSnapshot: true,
        createdAt: true,
        user: {
          select: {
            name: true,
            username: true,
            telegramId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })) as readonly RawPurchaseRow[];

    const filteredRows = input.planId
      ? rows.filter((row) => extractPlanRef(row.planSnapshot).id === input.planId)
      : rows;

    return this.aggregate(filteredRows);
  }

  private aggregate(rows: readonly RawPurchaseRow[]): PlansStatsResultInterface {
    const totalsRevenue: Record<string, string> = {};
    const buyerSet = new Set<string>();

    const planMap = new Map<
      string,
      {
        readonly planId: string | null;
        readonly planName: string;
        purchases: number;
        readonly buyers: Set<string>;
        readonly revenue: Record<string, string>;
      }
    >();

    const buyerMap = new Map<
      string,
      {
        readonly userId: string;
        displayName: string;
        readonly username: string | null;
        readonly telegramId: string | null;
        purchases: number;
        readonly revenue: Record<string, string>;
      }
    >();

    const timelineMap = new Map<
      string,
      {
        readonly bucket: string;
        purchases: number;
        readonly revenue: Record<string, string>;
      }
    >();

    for (const row of rows) {
      addRevenue(totalsRevenue, row.currency, row.amount);
      buyerSet.add(row.userId);

      // Plan breakdown
      const planRef = extractPlanRef(row.planSnapshot);
      const planKey = planRef.id ?? `__name:${planRef.name}`;
      let planEntry = planMap.get(planKey);
      if (!planEntry) {
        planEntry = {
          planId: planRef.id,
          planName: planRef.name,
          purchases: 0,
          buyers: new Set<string>(),
          revenue: {},
        };
        planMap.set(planKey, planEntry);
      }
      planEntry.purchases += 1;
      planEntry.buyers.add(row.userId);
      addRevenue(planEntry.revenue, row.currency, row.amount);

      // Buyer breakdown
      let buyerEntry = buyerMap.get(row.userId);
      if (!buyerEntry) {
        const fallbackName =
          (row.user.name && row.user.name.length > 0 ? row.user.name : null) ??
          row.user.username ??
          (row.user.telegramId ? `tg:${row.user.telegramId.toString()}` : row.userId);
        buyerEntry = {
          userId: row.userId,
          displayName: fallbackName,
          username: row.user.username,
          telegramId: row.user.telegramId ? row.user.telegramId.toString() : null,
          purchases: 0,
          revenue: {},
        };
        buyerMap.set(row.userId, buyerEntry);
      }
      buyerEntry.purchases += 1;
      addRevenue(buyerEntry.revenue, row.currency, row.amount);

      // Timeline by ISO date (UTC day)
      const isoDay = row.createdAt.toISOString().slice(0, 10);
      let timelineEntry = timelineMap.get(isoDay);
      if (!timelineEntry) {
        timelineEntry = { bucket: isoDay, purchases: 0, revenue: {} };
        timelineMap.set(isoDay, timelineEntry);
      }
      timelineEntry.purchases += 1;
      addRevenue(timelineEntry.revenue, row.currency, row.amount);
    }

    const byPlan = Array.from(planMap.values())
      .map((entry) => ({
        planId: entry.planId,
        planName: entry.planName,
        purchases: entry.purchases,
        uniqueBuyers: entry.buyers.size,
        revenueByCurrency: entry.revenue,
      }))
      .sort((a, b) => b.purchases - a.purchases);

    const topBuyers = Array.from(buyerMap.values())
      .map((entry) => ({
        userId: entry.userId,
        displayName: entry.displayName,
        username: entry.username,
        telegramId: entry.telegramId,
        purchases: entry.purchases,
        revenueByCurrency: entry.revenue,
      }))
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 10);

    const timeline = Array.from(timelineMap.values())
      .map((entry) => ({
        bucket: entry.bucket,
        purchases: entry.purchases,
        revenueByCurrency: entry.revenue,
      }))
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

    return {
      totals: {
        purchases: rows.length,
        revenueByCurrency: totalsRevenue,
        uniqueBuyers: buyerSet.size,
      },
      byPlan,
      timeline,
      topBuyers,
    };
  }
}
