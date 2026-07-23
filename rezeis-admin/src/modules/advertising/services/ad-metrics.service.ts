import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdMetrics } from '../interfaces/advertising.interface';
import { daysBetween } from '../utils/ad-attribution-window.util';

export interface AdOverview {
  readonly campaigns: number;
  readonly activePlacements: number;
  readonly opens: number;
  readonly registrations: number;
  readonly conversions: number;
  readonly revenueMinor: number;
}

export interface AdChartPoint {
  readonly date: string;
  readonly opens: number;
  readonly registrations: number;
}

@Injectable()
export class AdMetricsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async getOverview(): Promise<AdOverview> {
    const [campaigns, activePlacements, opens, registrations, conversionAgg] = await Promise.all([
      this.prismaService.adCampaign.count(),
      this.prismaService.adPlacement.count({ where: { status: 'ACTIVE' } }),
      this.prismaService.adClick.count(),
      this.prismaService.user.count({ where: { acquisitionPlacementId: { not: null } } }),
      this.prismaService.adConversion.aggregate({
        where: { status: 'ATTRIBUTED' },
        _count: true,
        _sum: { amount: true },
      }),
    ]);
    return {
      campaigns,
      activePlacements,
      opens,
      registrations,
      conversions: conversionAgg._count,
      revenueMinor: conversionAgg._sum.amount ?? 0,
    };
  }

  public async getPlacementMetrics(placementId: string): Promise<AdMetrics> {
    const placement = await this.prismaService.adPlacement.findUnique({
      where: { id: placementId },
      select: {
        id: true,
        ownerType: true,
        spendAmount: true,
        spendCurrency: true,
      },
    });
    if (placement === null) {
      throw new NotFoundException('Placement not found');
    }

    const [opens, acquiredUsers, conversionAgg, daysAgg] = await Promise.all([
      this.prismaService.adClick.count({ where: { placementId } }),
      this.prismaService.user.findMany({
        where: { acquisitionPlacementId: placementId },
        select: { id: true },
      }),
      this.prismaService.adConversion.aggregate({
        where: { placementId, status: 'ATTRIBUTED' },
        // @ts-expect-error - Prisma aggregate groupBy type issue with custom UTM fields
        groupBy: ['utmSource', 'utmMedium', 'utmCampaign'],
        _count: true,
        _sum: { amount: true },
      }),
      this.prismaService.adConversion.findMany({
        where: { placementId, status: 'ATTRIBUTED' },
        select: { occurredAt: true, userId: true, utmSource: true },
        orderBy: { occurredAt: 'asc' },
      }),
    ]);

    const registrations = acquiredUsers.length;
    const conversionGroups = Array.isArray(conversionAgg) ? conversionAgg : [];
    const conversions = conversionGroups.reduce((sum, g) => sum + (g._count ?? 0), 0);
    const revenueMinor = conversionGroups.reduce((sum, g) => sum + (g._sum?.amount ?? 0), 0);

    // Build UTM breakdown for advanced grouping/analysis (new for this step)
    const utmBreakdown = conversionGroups.map((g: any) => ({
      utmSource: g.utmSource,
      utmMedium: g.utmMedium,
      utmCampaign: g.utmCampaign,
      conversions: g._count ?? 0,
      revenueMinor: g._sum?.amount ?? 0,
    })).filter(b => b.conversions > 0);

    const costMinor = await this.resolveCostMinor(
      placement.ownerType,
      placement.spendAmount,
      acquiredUsers.map((u) => u.id),
    );

    const currency = placement.spendCurrency ?? (await this.firstConversionCurrency(placementId)) ?? 'RUB';

    const avgDaysToPurchase = await this.avgDaysToPurchase(daysAgg);

    return {
      opens,
      registrations,
      conversions,
      revenueMinor,
      costMinor,
      currency,
      cac: conversions > 0 && costMinor > 0 ? costMinor / conversions : null,
      roas: costMinor > 0 ? revenueMinor / costMinor : null,
      roi: costMinor > 0 ? (revenueMinor - costMinor) / costMinor : null,
      openToRegistrationRate: opens > 0 ? registrations / opens : 0,
      registrationToPurchaseRate: registrations > 0 ? conversions / registrations : 0,
      avgFirstPaymentMinor: conversions > 0 ? Math.round(revenueMinor / conversions) : null,
      arpuMinor: registrations > 0 ? Math.round(revenueMinor / registrations) : null,
      avgDaysToPurchase,
      utmBreakdown,
    };
  }

  public async getPlacementChartData(placementId: string, days = 14): Promise<AdChartPoint[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [clicks, users] = await Promise.all([
      this.prismaService.adClick.findMany({
        where: { placementId, occurredAt: { gte: since } },
        select: { occurredAt: true },
      }),
      this.prismaService.user.findMany({
        where: { acquisitionPlacementId: placementId, acquisitionAt: { gte: since } },
        select: { acquisitionAt: true },
      }),
    ]);
    const buckets = new Map<string, { opens: number; registrations: number }>();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
      buckets.set(dayKey(d), { opens: 0, registrations: 0 });
    }
    for (const c of clicks) {
      const key = dayKey(c.occurredAt);
      const b = buckets.get(key);
      if (b) b.opens += 1;
    }
    for (const u of users) {
      if (u.acquisitionAt === null) continue;
      const key = dayKey(u.acquisitionAt);
      const b = buckets.get(key);
      if (b) b.registrations += 1;
    }
    return Array.from(buckets.entries()).map(([date, v]) => ({
      date,
      opens: v.opens,
      registrations: v.registrations,
    }));
  }

  private async resolveCostMinor(
    ownerType: 'COMPANY' | 'PARTNER',
    spendAmount: number | null,
    acquiredUserIds: string[],
  ): Promise<number> {
    if (ownerType === 'COMPANY') {
      return spendAmount ?? 0;
    }
    if (acquiredUserIds.length === 0) {
      return 0;
    }
    // PARTNER cost = Σ commission paid for users this placement acquired.
    const agg = await this.prismaService.partnerTransaction.aggregate({
      where: { referralUserId: { in: acquiredUserIds } },
      _sum: { earnedAmount: true },
    });
    return agg._sum.earnedAmount ?? 0;
  }

  private async firstConversionCurrency(placementId: string): Promise<string | null> {
    const conversion = await this.prismaService.adConversion.findFirst({
      where: { placementId },
      select: { currency: true },
      orderBy: { occurredAt: 'asc' },
    });
    return conversion?.currency ?? null;
  }

  private async avgDaysToPurchase(
    conversions: ReadonlyArray<{ occurredAt: Date; userId: string }>,
  ): Promise<number | null> {
    if (conversions.length === 0) {
      return null;
    }
    const users = await this.prismaService.user.findMany({
      where: { id: { in: conversions.map((c) => c.userId) } },
      select: { id: true, acquisitionAt: true },
    });
    const acquisitionById = new Map(users.map((u) => [u.id, u.acquisitionAt]));
    let total = 0;
    let counted = 0;
    for (const c of conversions) {
      const acquiredAt = acquisitionById.get(c.userId);
      if (acquiredAt instanceof Date) {
        total += daysBetween(acquiredAt, c.occurredAt);
        counted += 1;
      }
    }
    return counted > 0 ? Math.round((total / counted) * 10) / 10 : null;
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
