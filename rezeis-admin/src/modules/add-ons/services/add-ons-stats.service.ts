import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface AddOnsStatsQueryInput {
  readonly from?: Date;
  readonly to?: Date;
}

export interface AddOnsStatsTotalsInterface {
  readonly purchases: number;
  readonly uniqueBuyers: number;
  readonly revenueByCurrency: Record<string, string>;
}

export interface AddOnsStatsTopBuyerInterface {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly telegramId: string | null;
  readonly purchases: number;
  readonly revenueByCurrency: Record<string, string>;
}

export interface AddOnsStatsTimelinePointInterface {
  readonly bucket: string;
  readonly purchases: number;
  readonly revenueByCurrency: Record<string, string>;
}

export interface AddOnsStatsResultInterface {
  readonly totals: AddOnsStatsTotalsInterface;
  readonly topBuyers: readonly AddOnsStatsTopBuyerInterface[];
  readonly timeline: readonly AddOnsStatsTimelinePointInterface[];
  /**
   * Completed add-on purchases classified by their linked entitlement/source
   * line (T-012) rather than the generic `ADDITIONAL` type: legacy top-ups
   * with no ledger row are `UNKNOWN_ADDITIONAL`; ledgered lines are separated
   * into committed / active / expired / reversed / remediation.
   */
  readonly deliveryBreakdown: Readonly<Record<AddOnDeliveryClass, number>>;
}

export type AddOnDeliveryClass =
  | 'UNKNOWN_ADDITIONAL'
  | 'COMMITTED'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVERSED'
  | 'REMEDIATION_REQUIRED';

function classifyDelivery(state: string | undefined): AddOnDeliveryClass {
  switch (state) {
    case 'PENDING_ACTIVATION':
      return 'COMMITTED';
    case 'ACTIVE':
      return 'ACTIVE';
    case 'EXPIRING':
    case 'EXPIRED':
      return 'EXPIRED';
    case 'REVERSED':
      return 'REVERSED';
    case 'REMEDIATION_REQUIRED':
      return 'REMEDIATION_REQUIRED';
    default:
      // No linked entitlement (legacy one-time top-up) → ambiguous.
      return 'UNKNOWN_ADDITIONAL';
  }
}

function emptyDeliveryBreakdown(): Record<AddOnDeliveryClass, number> {
  return {
    UNKNOWN_ADDITIONAL: 0,
    COMMITTED: 0,
    ACTIVE: 0,
    EXPIRED: 0,
    REVERSED: 0,
    REMEDIATION_REQUIRED: 0,
  };
}

function addRevenue(
  target: Record<string, string>,
  currency: string,
  amount: Prisma.Decimal,
): void {
  const previous = target[currency] ?? '0';
  const sum = new Prisma.Decimal(previous).add(amount);
  target[currency] = sum.toFixed(2);
}

@Injectable()
export class AddOnsStatsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async getStats(input: AddOnsStatsQueryInput): Promise<AddOnsStatsResultInterface> {
    const where: Prisma.TransactionWhereInput = {
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
    };
    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }

    const rows = await this.prismaService.transaction.findMany({
      where,
      select: {
        id: true,
        userId: true,
        amount: true,
        currency: true,
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
    });

    const totalsRevenue: Record<string, string> = {};
    const buyerSet = new Set<string>();

    const buyerMap = new Map<
      string,
      {
        readonly userId: string;
        readonly displayName: string;
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

      const isoDay = row.createdAt.toISOString().slice(0, 10);
      let timelineEntry = timelineMap.get(isoDay);
      if (!timelineEntry) {
        timelineEntry = { bucket: isoDay, purchases: 0, revenue: {} };
        timelineMap.set(isoDay, timelineEntry);
      }
      timelineEntry.purchases += 1;
      addRevenue(timelineEntry.revenue, row.currency, row.amount);
    }

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

    // Classify each completed purchase by its linked entitlement (source line).
    const deliveryBreakdown = emptyDeliveryBreakdown();
    const txIds = rows.map((row) => row.id);
    const entitlements =
      txIds.length > 0
        ? await this.prismaService.addOnEntitlement.findMany({
            where: { sourceTransactionId: { in: txIds } },
            select: { sourceTransactionId: true, state: true },
          })
        : [];
    const stateByTxId = new Map<string, string>();
    for (const entitlement of entitlements) {
      stateByTxId.set(entitlement.sourceTransactionId, entitlement.state);
    }
    for (const row of rows) {
      deliveryBreakdown[classifyDelivery(stateByTxId.get(row.id))] += 1;
    }

    return {
      totals: {
        purchases: rows.length,
        uniqueBuyers: buyerSet.size,
        revenueByCurrency: totalsRevenue,
      },
      topBuyers,
      timeline,
      deliveryBreakdown,
    };
  }
}
