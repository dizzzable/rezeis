import { Currency, PlanAvailability, PlanType, PointsCashbackMode } from '@prisma/client';

import { ArchivedPlanRenewModeValue } from '../utils/archived-plan-renew-mode.util';
import { TrafficLimitStrategyValue } from '../dto/traffic-limit-strategy.dto';
import { TrialSettings } from '../utils/trial-settings.util';

export interface AdminPlanPriceInterface {
  readonly id: string;
  readonly currency: Currency;
  readonly price: string;
}

export interface AdminPlanDurationInterface {
  readonly id: string;
  readonly days: number;
  readonly isActive: boolean;
  /**
   * Points for a purchase of this duration under `cashbackMode: FIXED`;
   * `null` under every other mode, and under FIXED `null` reads as zero.
   */
  readonly cashbackPoints: number | null;
  readonly prices: readonly AdminPlanPriceInterface[];
}

export interface AdminPlanInterface {
  readonly id: string;
  readonly orderIndex: number;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly icon: string | null;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  /**
   * The operator's «Скрыть от покупателя» switch: the plan stays in every panel
   * listing and grant picker, and the BUYER catalogue skips it. Independent of
   * `isActive` (which also stops grants and renewals) and of `isArchived`
   * (which is about transitions).
   */
  readonly hiddenFromBuyer: boolean;
  /**
   * Set when this row is the plan a bundle is issued as («объединённая
   * подписка»). Its type, traffic limit and squads are owned by the bundle's
   * visible member and its name by the bundle dialog; the plan editor does not
   * render those fields.
   */
  readonly bundle: { readonly id: string; readonly name: string } | null;
  readonly archivedRenewMode: ArchivedPlanRenewModeValue;
  readonly type: PlanType;
  readonly availability: PlanAvailability;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly upgradeToPlanIds: readonly string[];
  readonly replacementPlanIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly trialSettings: TrialSettings;
  /**
   * How a purchase of this plan earns points — see `points-cashback.util.ts`.
   * Read live from the catalogue by every surface, never from a subscription's
   * plan snapshot, so it is deliberately absent from `plan-snapshot-sync`.
   */
  readonly cashbackMode: PointsCashbackMode;
  /** The plan's own percent, set under PERCENT only; `null` otherwise. */
  readonly cashbackPercent: number | null;
  readonly durations: readonly AdminPlanDurationInterface[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
