import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { FxRateService } from '../../fx/fx-rate.service';
import { AdMetrics } from '../interfaces/advertising.interface';
import { daysBetween } from '../utils/ad-attribution-window.util';

export interface AdOverview {
  readonly campaigns: number;
  readonly activePlacements: number;
  readonly opens: number;
  readonly registrations: number;
  readonly conversions: number;
  /** Revenue in the reporting base currency, converted at the time of purchase. */
  readonly revenueMinor: number;
  readonly currency: string;
  /** Conversions with no known rate — excluded from `revenueMinor`, shown as a caveat. */
  readonly unconvertedConversions: number;
}

export interface AdChartPoint {
  readonly date: string;
  readonly opens: number;
  readonly registrations: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdMetricsService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly fxRateService: FxRateService,
  ) {}

  public async getOverview(): Promise<AdOverview> {
    const [campaigns, activePlacements, opens, registrations, conversionAgg, unconvertedConversions] =
      await Promise.all([
      this.prismaService.adCampaign.count(),
      // Both statuses, because attribution requires both: a placement under a
      // paused campaign accepts nothing, so counting it as active told the
      // operator traffic was being tracked when it was being dropped.
      this.prismaService.adPlacement.count({
        where: { status: 'ACTIVE', campaign: { status: 'ACTIVE' } },
      }),
      this.prismaService.adClick.count(),
      this.prismaService.user.count({ where: { acquisitionPlacementId: { not: null } } }),
      // `amountBase`, never `amount`: summing raw minor units across 14 currencies
      // produced a number with no meaning, printed under whichever currency
      // happened to come first.
      this.prismaService.adConversion.aggregate({
        where: { status: 'ATTRIBUTED' },
        _count: true,
        _sum: { amountBase: true },
      }),
      this.prismaService.adConversion.count({
        where: { status: 'ATTRIBUTED', amountBase: null },
      }),
    ]);
    return {
      campaigns,
      activePlacements,
      opens,
      registrations,
      conversions: conversionAgg._count,
      revenueMinor: conversionAgg._sum.amountBase ?? 0,
      currency: this.fxRateService.getBaseCurrency(),
      unconvertedConversions,
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

    const [opens, acquiredUsers, conversionAgg, daysAgg, clickUtmAgg] = await Promise.all([
      this.prismaService.adClick.count({ where: { placementId } }),
      this.prismaService.user.findMany({
        where: { acquisitionPlacementId: placementId },
        select: { id: true },
      }),
      this.prismaService.adConversion.groupBy({
        where: { placementId, status: 'ATTRIBUTED' },
        by: ['utmSource', 'utmMedium', 'utmCampaign'],
        _count: true,
        _sum: { amountBase: true },
      }),
      this.prismaService.adConversion.findMany({
        where: { placementId, status: 'ATTRIBUTED' },
        select: { occurredAt: true, userId: true, utmSource: true },
        orderBy: { occurredAt: 'asc' },
      }),
      // Opens per UTM combination. The breakdown used to be built from
      // conversions alone, so it stayed empty until somebody paid — and since
      // nothing ever wrote utm onto a click, it stayed empty forever.
      this.prismaService.adClick.groupBy({
        where: { placementId },
        by: ['utmSource', 'utmMedium', 'utmCampaign'],
        _count: true,
      }),
    ]);

    const registrations = acquiredUsers.length;
    const conversionGroups = conversionAgg;
    const conversions = conversionGroups.reduce((sum, g) => sum + (g._count ?? 0), 0);
    const revenueMinor = conversionGroups.reduce((sum, g) => sum + (g._sum?.amountBase ?? 0), 0);

    // One row per UTM combination, merging what the clicks know (opens) with what
    // the conversions know (paid conversions and revenue). Rows with neither are
    // dropped; a row with opens but no purchase is exactly the interesting case —
    // a creative that draws traffic and sells nothing.
    const utmRows = new Map<
      string,
      {
        utmSource?: string;
        utmMedium?: string;
        utmCampaign?: string;
        opens: number;
        conversions: number;
        revenueMinor: number;
      }
    >();
    // Nullish-tolerant on purpose: an absent tag reaches here as `null` from a
    // grouped query and as `undefined` from anything that omits the column, and a
    // row keyed on one must not be a different row from the other.
    const utmRow = (
      source: string | null | undefined,
      medium: string | null | undefined,
      campaign: string | null | undefined,
    ) => {
      const key = `${source ?? ''}|${medium ?? ''}|${campaign ?? ''}`;
      const existing = utmRows.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = {
        ...(source == null ? {} : { utmSource: source }),
        ...(medium == null ? {} : { utmMedium: medium }),
        ...(campaign == null ? {} : { utmCampaign: campaign }),
        opens: 0,
        conversions: 0,
        revenueMinor: 0,
      };
      utmRows.set(key, created);
      return created;
    };
    for (const g of clickUtmAgg) {
      utmRow(g.utmSource, g.utmMedium, g.utmCampaign).opens += g._count ?? 0;
    }
    for (const g of conversionGroups) {
      const row = utmRow(g.utmSource, g.utmMedium, g.utmCampaign);
      row.conversions += g._count ?? 0;
      row.revenueMinor += g._sum?.amountBase ?? 0;
    }
    const utmBreakdown = Array.from(utmRows.values())
      .filter((row) => row.opens > 0 || row.conversions > 0)
      .sort((a, b) => b.revenueMinor - a.revenueMinor || b.opens - a.opens);

    // Everything below is expressed in one currency, so ratios are comparable
    // across placements. The budget can be booked in any currency, so it is
    // converted too — a USD budget against rouble revenue used to inflate ROAS
    // roughly ninetyfold.
    const currency = this.fxRateService.getBaseCurrency();
    const costMinor = await this.resolveCostMinor(
      placement.ownerType,
      placement.spendAmount,
      placement.spendCurrency,
    );
    const unconvertedConversions = await this.prismaService.adConversion.count({
      where: { placementId, status: 'ATTRIBUTED', amountBase: null },
    });

    const avgDaysToPurchase = await this.avgDaysToPurchase(daysAgg);
    // Averages must divide by the conversions that actually contributed to the
    // numerator. `revenueMinor` is SUM(amountBase) and SQL SUM skips NULL, so
    // dividing by ALL conversions understated both money tiles from the first
    // Telegram Stars payment onward — XTR has no market rate, so those rows carry
    // amountBase = NULL by design.
    const convertedConversions = Math.max(0, conversions - unconvertedConversions);

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
      avgFirstPaymentMinor:
        convertedConversions > 0 ? Math.round(revenueMinor / convertedConversions) : null,
      // Deliberately withheld while anything is unconverted: an ARPU computed over
      // all registrations from partial revenue is not "roughly right", it is a
      // number an operator would budget against.
      arpuMinor:
        registrations > 0 && unconvertedConversions === 0
          ? Math.round(revenueMinor / registrations)
          : null,
      avgDaysToPurchase,
      utmBreakdown,
      unconvertedConversions,
    };
  }

  public async getPlacementChartData(placementId: string, days = 14): Promise<AdChartPoint[]> {
    // Anchor the window to UTC midnight so the last bucket is TODAY. Anchoring
    // it to `now - days * 24h` put the final bucket on *yesterday*, so every
    // event from the current day landed outside all buckets and was dropped by
    // the lookup below — the chart read flat zero on the very day an operator
    // tested a link, which is when they look at it.
    const span = Math.max(1, Math.min(365, Math.trunc(days)));
    const startOfToday = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const since = new Date(startOfToday - (span - 1) * DAY_MS);
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
    for (let i = 0; i < span; i += 1) {
      const d = new Date(since.getTime() + i * DAY_MS);
      buckets.set(dayKey(d), { opens: 0, registrations: 0 });
    }
    // Upsert rather than skip on a miss: a dropped row is invisible in the UI,
    // so a future off-by-one in the seeding above would silently lose data
    // again instead of just showing an extra column.
    for (const c of clicks) {
      bucketFor(buckets, dayKey(c.occurredAt)).opens += 1;
    }
    for (const u of users) {
      if (u.acquisitionAt === null) continue;
      bucketFor(buckets, dayKey(u.acquisitionAt)).registrations += 1;
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        opens: v.opens,
        registrations: v.registrations,
      }));
  }

  /**
   * Advertising cost is what the operator actually spent out of pocket.
   *
   * COMPANY placements: the budget the operator recorded by hand — the platform
   * never pays for advertising from inside the service, the figure is entered to
   * measure payback.
   *
   * PARTNER placements: zero. The partner promotes at their own expense and earns
   * through the partner program; that commission belongs to the partner-program
   * economics, not to an advertising budget. Summing it here made the cost of a
   * partner placement grow with every renewal while its revenue stayed frozen on
   * the first purchase, so a profitable channel read as a deep loss.
   */
  private async resolveCostMinor(
    ownerType: 'COMPANY' | 'PARTNER',
    spendAmount: number | null,
    spendCurrency: string | null,
  ): Promise<number> {
    if (ownerType !== 'COMPANY' || spendAmount === null) {
      return 0;
    }
    const currency = (spendCurrency ?? this.fxRateService.getBaseCurrency()).toUpperCase();
    if (currency === this.fxRateService.getBaseCurrency()) {
      return spendAmount;
    }
    const converted = await this.fxRateService.toBaseMinor(spendAmount / 100, currency);
    return converted?.amountBaseMinor ?? spendAmount;
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

/** Returns the bucket for `key`, creating it when the day is outside the seed. */
function bucketFor(
  buckets: Map<string, { opens: number; registrations: number }>,
  key: string,
): { opens: number; registrations: number } {
  const existing = buckets.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = { opens: 0, registrations: 0 };
  buckets.set(key, created);
  return created;
}
