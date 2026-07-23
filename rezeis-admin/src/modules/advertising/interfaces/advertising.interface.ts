import {
  AdClickSurface,
  AdConversionStatus,
  AdOwnerType,
  AdPlacementStatus,
  AdPlatform,
  AdRequestStatus,
  AdSignupBonusType,
} from '@prisma/client';

import { AdDeepLinks } from '../utils/tracking-code.util';

/** Type-specific signup-bonus parameters stored in `AdPlacement.signupBonus`. */
export interface AdSignupBonusConfig {
  readonly type: AdSignupBonusType;
  /** TRIAL: trial subscription parameters. */
  readonly trialDurationDays?: number;
  readonly trialTrafficGb?: number;
  readonly trialDeviceLimit?: number;
  readonly trialSquadUuids?: readonly string[];
  /** TARIFF: full subscription by an active plan. */
  readonly tariffPlanId?: string;
  readonly tariffDurationDays?: number;
}

export interface AdPlacementView {
  readonly id: string;
  readonly campaignId: string;
  readonly platform: AdPlatform;
  readonly channel: string | null;
  readonly ownerType: AdOwnerType;
  readonly partnerId: string | null;
  readonly trackingCode: string;
  readonly payload: string;
  readonly links: AdDeepLinks;
  readonly attributionWindowDays: number;
  readonly promoCodeId: string | null;
  readonly spendAmountMinor: number | null;
  readonly spendCurrency: string | null;
  readonly signupBonusType: AdSignupBonusType;
  readonly signupBonus: AdSignupBonusConfig | null;
  readonly status: AdPlacementStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdCampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: AdPlacementStatus;
  readonly notes: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly placements: readonly AdPlacementView[];
}

export interface AdPlacementRequestView {
  readonly id: string;
  readonly partnerId: string;
  readonly platforms: readonly AdPlatform[];
  readonly channel: string | null;
  readonly notes: string | null;
  readonly proposedWindowDays: number;
  readonly approvedWindowDays: number | null;
  readonly selfFundedBudgetNote: string | null;
  readonly status: AdRequestStatus;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly campaignId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Aggregated metrics for one placement (or a campaign rollup). */
export interface AdMetrics {
  readonly opens: number;
  readonly registrations: number;
  readonly conversions: number;
  readonly revenueMinor: number;
  readonly costMinor: number;
  readonly currency: string;
  readonly cac: number | null;
  readonly roas: number | null;
  readonly roi: number | null;
  readonly openToRegistrationRate: number;
  readonly registrationToPurchaseRate: number;
  readonly avgFirstPaymentMinor: number | null;
  readonly arpuMinor: number | null;
  readonly avgDaysToPurchase: number | null;
  /** Breakdown of conversions and revenue by UTM source/medium/campaign (for advanced attribution analysis). */
  readonly utmBreakdown?: Array<{
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    conversions: number;
    revenueMinor: number;
  }>;
}

export interface AdClickRecordInput {
  readonly code: string;
  readonly telegramId?: string | null;
  readonly userId?: string | null;
  readonly surface?: AdClickSurface;
  readonly isNewUser?: boolean;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
  readonly utmContent?: string | null;
  readonly utmCreative?: string | null;
}

export interface AdConversionView {
  readonly id: string;
  readonly placementId: string;
  readonly campaignId: string;
  readonly userId: string;
  readonly transactionId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: AdConversionStatus;
  readonly occurredAt: string;
}
