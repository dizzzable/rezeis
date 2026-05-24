/**
 * Stat shapes consumed by the SPA "Analytics" tab on the Referrals page.
 *
 * All endpoints accept `from` / `to` (ISO date strings) and a `granularity`
 * for time-series. Defaults are applied server-side: from = now-30d,
 * to = now, granularity = day.
 */

export interface ReferralFunnelInterface {
  readonly invitesCreated: number;
  readonly invitesConsumed: number;
  readonly referralsQualified: number;
  readonly rewardsIssued: number;
  /** Fractional 0..1, computed against the previous step. */
  readonly conversion: {
    readonly invitesToConsumed: number;
    readonly consumedToQualified: number;
    readonly qualifiedToIssued: number;
  };
  readonly from: string;
  readonly to: string;
}

export type ReferralTimeseriesGranularity = 'day' | 'week';

export interface ReferralTimeseriesPointInterface {
  readonly bucket: string;
  readonly invitesCreated: number;
  readonly referralsCreated: number;
  readonly referralsQualified: number;
  readonly rewardsIssued: number;
  readonly pointsIssued: number;
}

export interface ReferralTimeseriesInterface {
  readonly granularity: ReferralTimeseriesGranularity;
  readonly from: string;
  readonly to: string;
  readonly points: readonly ReferralTimeseriesPointInterface[];
}

export interface ReferralTopReferrerInterface {
  readonly userId: string;
  readonly username: string | null;
  readonly name: string | null;
  readonly telegramId: string | null;
  readonly totalReferrals: number;
  readonly qualifiedReferrals: number;
  /** Fractional 0..1. */
  readonly conversionRate: number;
  readonly rewardsIssued: number;
  readonly pointsEarned: number;
}

export interface ReferralTopReferrersInterface {
  readonly items: readonly ReferralTopReferrerInterface[];
  readonly from: string;
  readonly to: string;
}

export interface ReferralRewardDistributionInterface {
  readonly byType: Readonly<Record<string, { issued: number; pending: number; revoked: number }>>;
  readonly totals: {
    readonly issued: number;
    readonly pending: number;
    readonly revoked: number;
  };
}

export interface ReferralSourceBreakdownInterface {
  readonly bySource: Readonly<Record<string, number>>;
  readonly total: number;
}
